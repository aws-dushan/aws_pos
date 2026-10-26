using Dapper;
using OnePos.Api.Data;
using OnePos.Api.Platform;

namespace OnePos.Api.Pos;

/// <summary>
/// Sales reports (REQ RPT-02 … RPT-06) for a range of business days, one branch or every branch the user works in: the summary,
/// by day, by hour, by item and category, by payment method and by cashier. Sales are paid orders net of their credit notes
/// (an item's net is its line share less what came back). Money by method and by cashier counts the day it changed hands.
/// </summary>
public static class Reports
{
    public static void Map(RouteGroupBuilder api)
    {
        api.MapGet("/reports/sales", async (HttpContext http, Db db, DateOnly? from, DateOnly? to, string? branches) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("reports.view");
            return await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var today = scope.BranchId is { } bid ? await Days.DateAsync(c, tx, bid) : DateOnly.FromDateTime(DateTime.UtcNow);
                var t = to ?? today;
                var f = from ?? t;
                if (f > t) (f, t) = (t, f);
                if (t.DayNumber - f.DayNumber > 366) throw new DomainException("Choose at most a year.");
                // This branch, or every branch of the company this user works in.
                var ids = branches == "all"
                    ? (await c.QueryAsync<Guid>("""
                        select b.id from branch b where @admin or exists (select 1 from user_branch ub where ub.branch_id = b.id and ub.user_id = @u)
                        """, new { admin = scope.IsAdmin, u = scope.UserId }, tx)).ToArray()
                    : [scope.Branch];
                var tz = scope.BranchId is { } b0 ? await c.ExecuteScalarAsync<string>("select time_zone from branch where id = @b0", new { b0 }, tx) ?? "Asia/Dubai" : "Asia/Dubai";
                var args = new { ids, f, t, tz };

                var summary = await c.QuerySingleAsync<(int Orders, decimal Gross, decimal Vat, decimal Discounts, decimal Service, int Guests, decimal Refunded)>("""
                    select count(*)::int, coalesce(sum(total), 0), coalesce(sum(vat), 0), coalesce(sum(discount_total), 0), coalesce(sum(service_charge), 0),
                           coalesce(sum(guests), 0)::int, coalesce(sum(refunded), 0)
                    from pos_order where branch_id = any(@ids) and business_date between @f and @t and status in ('paid','refunded')
                    """, args, tx);
                var notes = await c.QuerySingleAsync<(int Count, decimal Total, decimal Vat, decimal AmountOnly)>("""
                    select count(*)::int, coalesce(sum(total), 0), coalesce(sum(vat), 0), coalesce(sum(total) filter (where kind = 'amount'), 0)
                    from credit_note where branch_id = any(@ids) and business_date between @f and @t
                    """, args, tx);
                var voids = await c.QuerySingleAsync<(int Count, decimal Value)>("""
                    select count(*)::int, coalesce(sum(total), 0) from pos_order where branch_id = any(@ids) and business_date between @f and @t and status = 'void'
                    """, args, tx);
                var byDay = await c.QueryAsync<(DateOnly Day, int Orders, decimal Sales, decimal Refunded)>("""
                    select business_date, count(*)::int, sum(total), sum(refunded) from pos_order
                    where branch_id = any(@ids) and business_date between @f and @t and status in ('paid','refunded') group by business_date order by business_date
                    """, args, tx);
                var byHour = await c.QueryAsync<(int Hour, int Orders, decimal Sales)>("""
                    select extract(hour from closed_at at time zone @tz)::int, count(*)::int, sum(total - refunded) from pos_order
                    where branch_id = any(@ids) and business_date between @f and @t and status in ('paid','refunded') group by 1 order by 1
                    """, args, tx);
                // Items: each line's share of what the order was paid (discounts and service charge spread), less what came back.
                // Finished days come summed per day (SalesSummary), so a year's report doesn't read every bill line.
                var byItem = await SalesSummary.ItemsAsync(c, tx, ids, f, t);
                var byMethod = await c.QueryAsync<(string Method, decimal Taken, decimal Refunded, int Count)>("""
                    select method, coalesce(sum(amount) filter (where kind = 'payment'), 0), coalesce(sum(amount) filter (where kind = 'refund'), 0), count(*) filter (where kind = 'payment')::int
                    from payment where branch_id = any(@ids) and business_date between @f and @t group by method order by 2 desc
                    """, args, tx);
                // Discounts: each item's discount under what gave it (its own when that was the bigger, else the bill's) and who gave it.
                var byDiscount = await c.QueryAsync<(string Name, string Kind, string By, int Bills, decimal Amount)>("""
                    with ln as (
                      select o.id as order_id, l.discount, l.disc_type, l.disc_name, l.disc_source, l.disc_by, o.discount_name, o.discount_source, o.discount_pct, o.discount_by,
                             case l.disc_type when 'pct' then round(l.line_total * least(l.disc_value, 100) / 100, 2)
                                              when 'amount' then least(l.line_total, round(l.disc_value * l.qty, 2))
                                              when 'price' then greatest(0, l.line_total - round(l.disc_value * l.qty, 2)) else 0 end as own
                      from order_line l join pos_order o on o.id = l.order_id
                      where o.branch_id = any(@ids) and o.business_date between @f and @t and o.status in ('paid','refunded') and not l.is_void and l.discount > 0),
                    w as (
                      select order_id, discount, disc_type is not null and own >= discount as mine, disc_name, disc_source, disc_by, discount_name, discount_source, discount_pct, discount_by from ln)
                    select case when mine then coalesce(disc_name, 'Item discount (typed)')
                                else coalesce(discount_name, case when discount_pct > 0 then 'Bill discount ' || trim(to_char(discount_pct, 'FM990.##')) || '%' else 'Bill discount (typed)' end) end as name,
                           case when mine then coalesce(disc_source, 'typed') else coalesce(discount_source, 'typed') end as kind,
                           coalesce(u.display_name, case when mine and disc_source = 'promotion' then 'Automatic' else '—' end) as by,
                           count(distinct order_id)::int, sum(discount)
                    from w left join app_user u on u.id = case when mine then disc_by else discount_by end
                    group by 1, 2, 3 order by 5 desc
                    """, args, tx);
                var byCashier = await c.QueryAsync<(string Name, int Payments, decimal Taken, decimal Refunded)>("""
                    select u.display_name, count(*) filter (where p.kind = 'payment')::int,
                           coalesce(sum(p.amount) filter (where p.kind = 'payment'), 0), coalesce(sum(p.amount) filter (where p.kind = 'refund'), 0)
                    from payment p join app_user u on u.id = p.taken_by
                    where p.branch_id = any(@ids) and p.business_date between @f and @t group by u.display_name order by 3 desc
                    """, args, tx);
                var byType = await c.QueryAsync<(string Type, int Orders, decimal Sales)>("""
                    select order_type, count(*)::int, sum(total - refunded) from pos_order
                    where branch_id = any(@ids) and business_date between @f and @t and status in ('paid','refunded') group by order_type order by 3 desc
                    """, args, tx);
                var byBranch = await c.QueryAsync<(string Code, string Name, int Orders, decimal Sales)>("""
                    select b.code, b.name, count(o.branch_id)::int, coalesce(sum(o.total - o.refunded), 0) from branch b
                    left join pos_order o on o.branch_id = b.id and o.business_date between @f and @t and o.status in ('paid','refunded')
                    where b.id = any(@ids) group by b.code, b.name order by 4 desc
                    """, args, tx);

                var items = byItem.ToList();
                return new
                {
                    from = f, to = t, branches = ids.Length,
                    summary = new
                    {
                        summary.Orders, gross = summary.Gross, vat = summary.Vat - notes.Vat, net = summary.Gross - notes.Total, netOfVat = summary.Gross - notes.Total - (summary.Vat - notes.Vat),
                        summary.Discounts, serviceCharge = summary.Service, summary.Guests, refunds = notes.Total, creditNotes = notes.Count,
                        averageOrder = summary.Orders == 0 ? 0 : Money.Round((summary.Gross - notes.Total) / summary.Orders),
                        voids = new { voids.Count, voids.Value },
                    },
                    byDay = byDay.Select(x => new { day = x.Day, x.Orders, sales = x.Sales - x.Refunded }),
                    byHour = byHour.Select(x => new { x.Hour, x.Orders, x.Sales }),
                    // What comes off sales but off no item (refunds of an amount, rounding of full returns): its own line, so the items add up.
                    amountRefunds = (summary.Gross - notes.Total) - Money.Round(items.Sum(x => x.Sales)),
                    byItem = items.Select(x => new { x.Name, category = x.Category ?? "Other", x.Qty, sales = Money.Round(x.Sales) }),
                    byCategory = items.GroupBy(x => x.Category ?? "Other").Select(g => new { category = g.Key, qty = g.Sum(x => x.Qty), sales = Money.Round(g.Sum(x => x.Sales)) }).OrderByDescending(x => x.sales),
                    byMethod = byMethod.Select(x => new { x.Method, x.Taken, x.Refunded, net = x.Taken - x.Refunded, x.Count }),
                    byCashier = byCashier.Select(x => new { x.Name, x.Payments, x.Taken, x.Refunded, net = x.Taken - x.Refunded }),
                    byDiscount = byDiscount.Select(x => new { x.Name, x.Kind, x.By, x.Bills, amount = Money.Round(x.Amount) }),
                    byType = byType.Select(x => new { x.Type, x.Orders, x.Sales }),
                    byBranch = byBranch.Select(x => new { x.Code, x.Name, x.Orders, x.Sales }),
                };
            });
        });

        // Invoices: one row per paid, refunded or voided bill of the days — its number, who and which till, the money, how it was
        // paid (card type, platform) and whether it reached FACTS (its latest invoice posting).
        api.MapGet("/reports/invoices", async (HttpContext http, Db db, DateOnly from, DateOnly to, string? branches) =>
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
                var tz = scope.BranchId is { } b0 ? await c.ExecuteScalarAsync<string>("select time_zone from branch where id = @b0", new { b0 }, tx) ?? "Asia/Dubai" : "Asia/Dubai";
                var rows = await c.QueryAsync<Invoice>("""
                    select o.id, coalesce(o.invoice_no, '#' || o.number) as invoice_no, o.business_date, b.code as branch,
                           to_char(coalesce(o.closed_at, o.opened_at) at time zone @tz, 'YYYY-MM-DD"T"HH24:MI') as at,
                           o.order_type, dp.name as platform, o.platform_ref, o.status,
                           coalesce(cu.display_name, ou.display_name) as cashier, r.name as till,
                           (select coalesce(sum(l.qty), 0) from order_line l where l.order_id = o.id and not l.is_void) as items,
                           o.subtotal as gross, o.discount_total as discount, o.vat, o.total as net, o.refunded,
                           (select string_agg(case p.method when 'card' then coalesce(initcap(regexp_replace(p.card_type, '^\S+\s+', '')), 'Card') when 'platform' then coalesce(dp.name, 'Platform')
                                                             else initcap(p.method) end || ' ' || to_char(p.amount, 'FM999999990.00'), ' · ' order by p.at)
                              from payment p where p.order_id = o.id and p.kind = 'payment') as paid_by,
                           (select e.status from erp_post e where e.order_id = o.id and e.kind = 'invoice' order by e.created_at desc limit 1) as facts
                    from pos_order o
                    join branch b on b.id = o.branch_id
                    left join delivery_platform dp on dp.id = o.platform_id
                    left join register r on r.id = o.register_id
                    left join app_user ou on ou.id = o.opened_by
                    left join lateral (select u.display_name from payment p join app_user u on u.id = p.taken_by
                                       where p.order_id = o.id and p.kind = 'payment' order by p.at desc limit 1) cu on true
                    where o.branch_id = any(@ids) and o.business_date between @f and @t and o.status in ('paid', 'refunded', 'void')
                    order by coalesce(o.closed_at, o.opened_at)
                    """, new { ids, f, t, tz }, tx);
                return new { invoices = rows };
            });
        });
    }

    public sealed class Invoice
    {
        public Guid Id { get; set; } public string InvoiceNo { get; set; } = ""; public DateOnly BusinessDate { get; set; } public string Branch { get; set; } = "";
        public string At { get; set; } = ""; public string OrderType { get; set; } = ""; public string? Platform { get; set; } public string? PlatformRef { get; set; }
        public string Status { get; set; } = ""; public string? Cashier { get; set; } public string? Till { get; set; } public decimal Items { get; set; }
        public decimal Gross { get; set; } public decimal Discount { get; set; } public decimal Vat { get; set; } public decimal Net { get; set; } public decimal Refunded { get; set; }
        public string? PaidBy { get; set; } public string? Facts { get; set; }
    }
}
