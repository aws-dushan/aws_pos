using Dapper;
using OnePos.Api.Data;
using OnePos.Api.Platform;

namespace OnePos.Api.Pos;

/// <summary>
/// Sales dashboard (REQ RPT-01). Two views, each allowed per role by an admin: "register" (dashboard.register: this till's sales,
/// only on a till) and "branch" (dashboard.branch: every register of the branch). Figures are for one business date (default today).
/// </summary>
public static class Dashboard
{
    private sealed class Paid { public string OrderType { get; set; } = ""; public decimal Total { get; set; } public decimal Discount { get; set; } public int Hour { get; set; } public Guid? RegisterId { get; set; } public Guid OpenedBy { get; set; } public string? Platform { get; set; } }

    public static void Map(RouteGroupBuilder api)
    {
        api.MapGet("/dashboard", async (HttpContext http, Db db, string? view, DateOnly? date) =>
        {
            var scope = await http.ScopeAsync(db);
            var branchId = scope.Branch;
            var isRegister = view != "branch";
            if (isRegister)
            {
                scope.Require("dashboard.register");
                if (scope.RegisterId is null) throw new DomainException("Register sales show on a till. Open this on a till, or choose Branch sales.");
            }
            else scope.Require("dashboard.branch");
            var reg = isRegister ? scope.RegisterId : null;

            return await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var tz = await c.ExecuteScalarAsync<string>("select time_zone from branch where id = @branchId", new { branchId }, tx) ?? "Asia/Dubai";
                var day = date ?? await Days.DateAsync(c, tx, branchId);
                var args = new { branchId, day, prev = day.AddDays(-1), reg, tz };
                // Paid orders of the day (hour in the branch's local time).
                var paid = (await c.QueryAsync<Paid>("""
                    select o.order_type, o.total - o.refunded as total, o.discount_total as discount,
                           extract(hour from o.closed_at at time zone @tz)::int as hour, o.register_id, o.opened_by, dp.name as platform
                    from pos_order o left join delivery_platform dp on dp.id = o.platform_id
                    where o.branch_id = @branchId and o.business_date = @day and o.status in ('paid','refunded') and (@reg is null or o.register_id = @reg)
                    """, args, tx)).ToList();
                // Money counts at the till that took or paid it; a back-office refund (no till) counts at the till of its order.
                var money = (await c.QueryAsync<(string Kind, string Method, decimal Amount)>("""
                    select p.kind, p.method, sum(p.amount) from payment p join pos_order o on o.id = p.order_id
                    where p.branch_id = @branchId and p.business_date = @day and (@reg is null or coalesce(p.register_id, o.register_id) = @reg)
                    group by p.kind, p.method
                    """, args, tx)).ToList();
                var open = await c.QuerySingleAsync<(int Count, decimal Value)>("""
                    select count(*)::int, coalesce(sum(total), 0) from pos_order
                    where branch_id = @branchId and status = 'open' and (@reg is null or register_id = @reg)
                    """, args, tx);
                var voids = await c.QuerySingleAsync<(int Count, decimal Value)>("""
                    select count(*)::int, coalesce(sum(total), 0) from pos_order
                    where branch_id = @branchId and business_date = @day and status = 'void' and (@reg is null or register_id = @reg)
                    """, args, tx);
                var yesterday = await c.ExecuteScalarAsync<decimal>("""
                    select coalesce(sum(total - refunded), 0) from pos_order
                    where branch_id = @branchId and business_date = @prev and status in ('paid','refunded') and (@reg is null or register_id = @reg)
                    """, args, tx);
                var names = (await c.QueryAsync<(Guid Id, string Name)>("""
                    select id, name from register where branch_id = @branchId
                    union all select u.id, u.display_name from app_user u join user_branch ub on ub.user_id = u.id where ub.branch_id = @branchId
                    """, args, tx)).GroupBy(x => x.Id).ToDictionary(g => g.Key, g => g.First().Name);

                var sales = paid.Sum(p => p.Total);
                decimal Net(string m) => money.Where(x => x.Method == m && x.Kind == "payment").Sum(x => x.Amount) - money.Where(x => x.Method == m && x.Kind == "refund").Sum(x => x.Amount);
                return new
                {
                    view = isRegister ? "register" : "branch",
                    date = day,
                    registerName = reg is { } r && names.TryGetValue(r, out var rn) ? rn : null,
                    sales,
                    yesterday,
                    orders = paid.Count,
                    averageTicket = paid.Count == 0 ? 0 : Money.Round(sales / paid.Count),
                    discounts = paid.Sum(p => p.Discount),
                    refunds = money.Where(x => x.Kind == "refund").Sum(x => x.Amount),
                    openOrders = new { count = open.Count, value = open.Value },
                    voids = new { count = voids.Count, value = voids.Value },
                    // Every method used today (points, platform…), the usual ones first.
                    byMethod = new[] { "cash", "card", "other", "voucher", "account", "points", "platform" }.Concat(money.Select(x => x.Method)).Distinct()
                        .Select(m => new { method = m, amount = Net(m) }).Where(x => x.amount != 0),
                    // Delivery is our own here; each delivery platform's orders are in byPlatform.
                    byType = new[] { "dine_in", "takeaway", "delivery" }.Select(t => new
                    {
                        type = t, amount = paid.Where(p => p.OrderType == t && p.Platform is null).Sum(p => p.Total), orders = paid.Count(p => p.OrderType == t && p.Platform is null),
                    }),
                    byPlatform = paid.Where(p => p.Platform is not null).GroupBy(p => p.Platform!)
                        .Select(g => new { name = g.Key, amount = g.Sum(p => p.Total), orders = g.Count() }).OrderByDescending(x => x.amount),
                    byHour = Enumerable.Range(0, 24).Select(h => new { hour = h, amount = paid.Where(p => p.Hour == h).Sum(p => p.Total) }),
                    byRegister = isRegister ? null : paid.GroupBy(p => p.RegisterId)
                        .Select(g => new { name = g.Key is { } k && names.TryGetValue(k, out var n) ? n : "Back office", amount = g.Sum(p => p.Total), orders = g.Count() })
                        .OrderByDescending(x => x.amount),
                    byCashier = isRegister ? null : paid.GroupBy(p => p.OpenedBy)
                        .Select(g => new { name = names.TryGetValue(g.Key, out var n) ? n : "Someone", amount = g.Sum(p => p.Total), orders = g.Count() })
                        .OrderByDescending(x => x.amount),
                };
            });
        });
    }
}
