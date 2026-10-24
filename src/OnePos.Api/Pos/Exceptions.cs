using Dapper;
using OnePos.Api.Data;
using OnePos.Api.Platform;

namespace OnePos.Api.Pos;

/// <summary>
/// No-sale (REQ HW-04): the drawer opened without a sale needs pos.nosale and a reason, and is kept. The exceptions report
/// (REQ RPT-03): over business days, discounts, voided orders, voided items, refunds and no-sales — who, when, why, and who approved.
/// </summary>
public static class Exceptions
{
    public sealed record NoSaleBody(string Reason);

    public sealed class Discount { public int? Number { get; set; } public DateOnly BusinessDate { get; set; } public string Branch { get; set; } = ""; public decimal Pct { get; set; } public string? What { get; set; } public decimal Amount { get; set; } public decimal Total { get; set; } public string? By { get; set; } public string? ApprovedBy { get; set; } }
    public sealed class Void { public int? Number { get; set; } public DateOnly BusinessDate { get; set; } public string Branch { get; set; } = ""; public decimal Total { get; set; } public string? Reason { get; set; } public string? By { get; set; } public DateTime? At { get; set; } }
    public sealed class LineVoid { public DateTime At { get; set; } public string Branch { get; set; } = ""; public string? What { get; set; } public string? Reason { get; set; } public string? By { get; set; } }
    public sealed class Refund { public string Number { get; set; } = ""; public int? OrderNumber { get; set; } public DateOnly BusinessDate { get; set; } public string Branch { get; set; } = ""; public decimal Total { get; set; } public string Method { get; set; } = ""; public string Reason { get; set; } = ""; public string? By { get; set; } public string? ApprovedBy { get; set; } }
    public sealed class NoSale { public DateTime At { get; set; } public DateOnly BusinessDate { get; set; } public string Branch { get; set; } = ""; public string? Register { get; set; } public string Reason { get; set; } = ""; public string? By { get; set; } }

    public static void Map(RouteGroupBuilder api)
    {
        api.MapPost("/drawer/no-sale", async (NoSaleBody body, HttpContext http, Db db, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("pos.nosale");
            var reason = (body.Reason ?? "").Trim();
            if (reason.Length == 0) throw new DomainException("Say why the drawer is opened.");
            var id = await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var day = (await Days.CurrentAsync(c, tx, scope.Branch, scope.UserId)).Date;
                var shift = await Days.ShiftOfAsync(c, tx, scope.RegisterId, scope.UserId)
                    ?? throw new DomainException("Open your shift first: the drawer opens only in a shift (on the Dashboard).");
                var id = await c.ExecuteScalarAsync<Guid>("""
                    insert into no_sale (company_id, branch_id, register_id, shift_id, business_date, reason, by_user)
                    values (@co, @b, @reg, @shift, @day, @reason, @u) returning id
                    """, new { co = scope.CompanyId, b = scope.Branch, reg = scope.RegisterId, shift, day, reason, u = scope.UserId }, tx);
                await Audit.RecordAsync(c, tx, scope.CompanyId, scope.Branch, scope.UserId, "drawer", id.ToString(), "no_sale", "Cash drawer opened without a sale", note: reason);
                return id;
            });
            await live.ToBranch(scope.Branch, "day.changed");
            return Results.Ok(new { id });
        });

        api.MapGet("/reports/exceptions", async (HttpContext http, Db db, DateOnly from, DateOnly to, string? branches) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("reports.view");
            var (f, t) = from <= to ? (from, to) : (to, from);
            if (t.DayNumber - f.DayNumber > 366) throw new DomainException("Choose at most a year.");
            return await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var ids = branches == "all"
                    ? (await c.QueryAsync<Guid>("""
                        select b.id from branch b where @admin or exists (select 1 from user_branch ub where ub.branch_id = b.id and ub.user_id = @u)
                        """, new { admin = scope.IsAdmin, u = scope.UserId }, tx)).ToArray()
                    : [scope.Branch];
                var args = new { ids, f, t };
                // Who did it comes from the audit log (the last entry of that kind on the order); who approved from the approvals.
                var discounts = (await c.QueryAsync<Discount>("""
                    select o.number, o.business_date, b.code as branch, o.discount_pct as pct, o.discount_total as amount, o.total,
                           -- What it was: the bill discount's name or %, else the items' own (promotions, item discounts).
                           coalesce(o.discount_name, case when o.discount_pct > 0 then trim(to_char(o.discount_pct, 'FM990.##')) || '%' when o.discount_amount > 0 then 'Amount off the bill' end,
                                    (select string_agg(distinct coalesce(l.disc_name, 'Item discount'), ', ') from order_line l where l.order_id = o.id and l.disc_type is not null and not l.is_void)) as what,
                           (select u.display_name from audit_log a join app_user u on u.id = a.user_id where a.entity = 'order' and a.entity_id = o.id::text and a.action = 'discount' order by a.at desc limit 1) as by,
                           (select u.display_name from approval ap join app_user u on u.id = ap.decided_by where ap.order_id = o.id and ap.kind = 'discount' and ap.status in ('approved','used') order by ap.requested_at desc limit 1) as approved_by
                    from pos_order o join branch b on b.id = o.branch_id
                    where o.branch_id = any(@ids) and o.business_date between @f and @t and o.discount_total > 0 and o.status in ('paid','refunded')
                    order by o.business_date, o.number
                    """, args, tx)).ToList();
                var voids = (await c.QueryAsync<Void>("""
                    select o.number, o.business_date, b.code as branch, o.total, o.void_reason as reason, a.name as by, a.at
                    from pos_order o join branch b on b.id = o.branch_id
                    left join lateral (select u.display_name as name, x.at from audit_log x join app_user u on u.id = x.user_id
                                       where x.entity = 'order' and x.entity_id = o.id::text and x.action = 'void' order by x.at desc limit 1) a on true
                    where o.branch_id = any(@ids) and o.business_date between @f and @t and o.status = 'void' and o.number is not null
                    order by o.business_date, o.number
                    """, args, tx)).ToList();
                var lineVoids = (await c.QueryAsync<LineVoid>("""
                    select x.at, b.code as branch, x.data->>'label' as what, x.data->>'note' as reason, u.display_name as by
                    from audit_log x join pos_order o on o.id::text = x.entity_id join branch b on b.id = o.branch_id left join app_user u on u.id = x.user_id
                    where x.entity = 'order' and x.action = 'line_void' and o.branch_id = any(@ids) and o.business_date between @f and @t
                    order by x.at
                    """, args, tx)).ToList();
                var refunds = (await c.QueryAsync<Refund>("""
                    select n.number, o.number as order_number, n.business_date, b.code as branch, n.total, n.method, n.reason, u.display_name as by,
                           (select du.display_name from approval ap join app_user du on du.id = ap.decided_by where ap.order_id = o.id and ap.kind = 'refund' and ap.status in ('approved','used') order by ap.requested_at desc limit 1) as approved_by
                    from credit_note n join pos_order o on o.id = n.order_id join branch b on b.id = n.branch_id join app_user u on u.id = n.created_by
                    where n.branch_id = any(@ids) and n.business_date between @f and @t order by n.created_at
                    """, args, tx)).ToList();
                var noSales = (await c.QueryAsync<NoSale>("""
                    select s.at, s.business_date, b.code as branch, r.name as register, s.reason, u.display_name as by
                    from no_sale s join branch b on b.id = s.branch_id left join register r on r.id = s.register_id join app_user u on u.id = s.by_user
                    where s.branch_id = any(@ids) and s.business_date between @f and @t order by s.at
                    """, args, tx)).ToList();
                return new
                {
                    from = f, to = t, discounts, voids, lineVoids, refunds, noSales,
                    totals = new
                    {
                        discounts = new { count = discounts.Count, value = discounts.Sum(x => x.Amount) },
                        voids = new { count = voids.Count, value = voids.Sum(x => x.Total) },
                        lineVoids = new { count = lineVoids.Count },
                        refunds = new { count = refunds.Count, value = refunds.Sum(x => x.Total) },
                        noSales = new { count = noSales.Count },
                    },
                };
            });
        });
    }
}
