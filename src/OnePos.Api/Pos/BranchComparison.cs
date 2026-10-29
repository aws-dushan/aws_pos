using Dapper;
using Npgsql;
using OnePos.Api.Data;
using OnePos.Api.Platform;

namespace OnePos.Api.Pos;

/// <summary>
/// Branch comparison (admin and finance): every branch the user works in side by side over the days, each against the previous
/// period of the same length (same weekdays when whole weeks are chosen). Fair figures (per day open), why each branch's sales
/// changed (more or fewer orders, bigger or smaller bills, discounts, platforms), and a few plain findings drawn from all of it.
/// </summary>
public static class BranchComparison
{
    private sealed class Figures
    {
        public Guid BranchId { get; set; }
        public int Orders { get; set; }
        public decimal Net { get; set; }
        public decimal Gross { get; set; }
        public decimal Discounts { get; set; }
        public decimal DineIn { get; set; }
        public decimal Takeaway { get; set; }
        public decimal Delivery { get; set; }
        public decimal Platform { get; set; }
        public decimal Voids { get; set; }
        public decimal Refunds { get; set; }
        public decimal Wastage { get; set; }
        public decimal Variance { get; set; }
        public int DaysOpen { get; set; }
        public int? BusiestHour { get; set; }
        public decimal AverageBill => Orders == 0 ? 0 : Money.Round(Net / Orders);
        public decimal PerDay => DaysOpen == 0 ? 0 : Money.Round(Net / DaysOpen);
    }

    private static async Task<Dictionary<Guid, Figures>> FiguresAsync(NpgsqlConnection c, NpgsqlTransaction tx, Guid[] ids, DateOnly f, DateOnly t)
    {
        var args = new { ids, f, t };
        var rows = (await c.QueryAsync<Figures>("""
            select b.id as branch_id,
                   coalesce(o.orders, 0) as orders, coalesce(o.net, 0) as net, coalesce(o.gross, 0) as gross, coalesce(o.discounts, 0) as discounts,
                   coalesce(o.dine_in, 0) as dine_in, coalesce(o.takeaway, 0) as takeaway, coalesce(o.delivery, 0) as delivery, coalesce(o.platform, 0) as platform,
                   (select coalesce(sum(v.total), 0) from pos_order v where v.branch_id = b.id and v.business_date between @f and @t and v.status = 'void') as voids,
                   (select coalesce(sum(n.total), 0) from credit_note n where n.branch_id = b.id and n.business_date between @f and @t) as refunds,
                   (select coalesce(sum(w.cost_value), 0) from wastage w where w.branch_id = b.id and w.business_date between @f and @t and w.voided_at is null and w.kind = 'wastage') as wastage,
                   (select coalesce(sum(s.variance), 0) from shift s join business_day d on d.id = s.business_day_id where s.branch_id = b.id and d.date between @f and @t) as variance,
                   (select count(*)::int from business_day d where d.branch_id = b.id and d.date between @f and @t) as days_open,
                   (select extract(hour from h.closed_at at time zone b.time_zone)::int from pos_order h
                    where h.branch_id = b.id and h.business_date between @f and @t and h.status in ('paid','refunded')
                    group by 1 order by sum(h.total - h.refunded) desc limit 1) as busiest_hour
            from branch b
            left join lateral (
              select count(*)::int as orders, sum(x.total - x.refunded) as net, sum(x.total) as gross, sum(x.discount_total) as discounts,
                     sum(x.total - x.refunded) filter (where x.platform_id is null and x.order_type = 'dine_in') as dine_in,
                     sum(x.total - x.refunded) filter (where x.platform_id is null and x.order_type = 'takeaway') as takeaway,
                     sum(x.total - x.refunded) filter (where x.platform_id is null and x.order_type = 'delivery') as delivery,
                     sum(x.total - x.refunded) filter (where x.platform_id is not null) as platform
              from pos_order x where x.branch_id = b.id and x.business_date between @f and @t and x.status in ('paid','refunded')) o on true
            where b.id = any(@ids)
            """, args, tx)).ToList();
        return rows.ToDictionary(r => r.BranchId);
    }

    private static decimal? Pct(decimal now, decimal before) => before == 0 ? null : decimal.Round((now - before) / before * 100, 1, MidpointRounding.AwayFromZero);
    private static decimal Share(decimal part, decimal whole) => whole == 0 ? 0 : decimal.Round(part / whole * 100, 1, MidpointRounding.AwayFromZero);
    private static string Signed(decimal? p) => p is { } v ? $"{(v >= 0 ? "▲" : "▼")} {Math.Abs(v):0.#}%" : "new";

    public static void Map(RouteGroupBuilder api)
    {
        api.MapGet("/reports/branch-comparison", async (HttpContext http, Db db, DateOnly from, DateOnly to) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("facts.post");
            var (f, t) = from <= to ? (from, to) : (to, from);
            if (t.DayNumber - f.DayNumber > 366) throw new DomainException("Choose at most a year.");
            // The previous period of the same length, just before (same weekdays when the days are whole weeks).
            var len = t.DayNumber - f.DayNumber + 1;
            var (pf, pt) = (f.AddDays(-len), f.AddDays(-1));
            return await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var branches = (await c.QueryAsync<(Guid Id, string Code, string Name)>("""
                    select b.id, b.code, b.name from branch b where b.is_active and (@admin or exists (select 1 from user_branch ub where ub.branch_id = b.id and ub.user_id = @u))
                    order by b.code
                    """, new { admin = scope.IsAdmin, u = scope.UserId }, tx)).ToList();
                var ids = branches.Select(b => b.Id).ToArray();
                var now = await FiguresAsync(c, tx, ids, f, t);
                var before = await FiguresAsync(c, tx, ids, pf, pt);

                // Only branches that sold in the period are compared.
                var live = branches.Where(b => now[b.Id].Orders > 0).ToList();
                string NameOf(Guid id) => branches.First(b => b.Id == id).Name;

                // Why each branch's sales changed: orders (at last period's average bill), the bill size, then discounts and platforms.
                var why = live.Select(b =>
                {
                    var (n, p) = (now[b.Id], before[b.Id]);
                    var traffic = Money.Round((n.Orders - p.Orders) * p.AverageBill);
                    var bill = Money.Round(n.Net - p.Net - traffic);
                    return new
                    {
                        branch = b.Name, now = n.Net, before = p.Net, change = n.Net - p.Net, changePct = Pct(n.Net, p.Net),
                        fromOrders = traffic, fromBill = bill, ordersNow = n.Orders, ordersBefore = p.Orders, billNow = n.AverageBill, billBefore = p.AverageBill,
                        discountPctNow = Share(n.Discounts, n.Gross + n.Discounts), discountPctBefore = Share(p.Discounts, p.Gross + p.Discounts),
                        platformPctNow = Share(n.Platform, n.Net), platformPctBefore = Share(p.Platform, p.Net),
                    };
                }).ToList();

                // Findings: a few plain sentences, the biggest things first.
                var findings = new List<string>();
                if (why.Where(w => w.changePct is not null).OrderByDescending(w => w.changePct).FirstOrDefault() is { } up && up.changePct > 0)
                    findings.Add($"{up.branch} is {Signed(up.changePct)} on the previous period: " +
                        (Math.Abs(up.fromOrders) >= Math.Abs(up.fromBill) ? $"more orders ({up.ordersBefore} → {up.ordersNow})" : $"bigger bills ({up.billBefore:0.00} → {up.billNow:0.00})") +
                        (up.platformPctNow - up.platformPctBefore >= 5 ? $", platforms up to {up.platformPctNow:0.#}% of its sales." : "."));
                if (why.Where(w => w.changePct is not null).OrderBy(w => w.changePct).FirstOrDefault() is { } down && down.changePct < 0)
                    findings.Add($"{down.branch} is {Signed(down.changePct)}: " +
                        (Math.Abs(down.fromOrders) >= Math.Abs(down.fromBill) ? $"fewer orders ({down.ordersBefore} → {down.ordersNow})" : $"smaller bills ({down.billBefore:0.00} → {down.billNow:0.00})") +
                        (down.discountPctNow - down.discountPctBefore >= 1 ? $", discounts up to {down.discountPctNow:0.#}% of sales." : "."));
                void Outlier(string what, Func<Figures, decimal> value, decimal factor, decimal floor)
                {
                    foreach (var b in live)
                    {
                        var mine = Share(value(now[b.Id]), now[b.Id].Net);
                        var rest = live.Where(o => o.Id != b.Id).Select(o => Share(value(now[o.Id]), now[o.Id].Net)).DefaultIfEmpty(0).Average();
                        if (live.Count > 1 && mine >= floor && mine >= rest * factor)
                            findings.Add($"{b.Name}'s {what} are {mine:0.#}% of its sales, against {rest:0.#}% at the other branches.");
                    }
                }
                Outlier("discounts", x => x.Discounts, 1.5m, 2);
                Outlier("voided orders", x => x.Voids, 2, 1);
                Outlier("wastage", x => x.Wastage, 1.5m, 1);
                if (live.Select(b => now[b.Id].DaysOpen).Distinct().Count() > 1)
                    findings.Add($"Not every branch was open every day ({string.Join(", ", live.Select(b => $"{b.Name} {now[b.Id].DaysOpen}"))} days): compare per day open.");

                var all = live.Select(b => now[b.Id]).ToList();
                return new
                {
                    from = f, to = t, previousFrom = pf, previousTo = pt,
                    findings,
                    branches = live.Select(b =>
                    {
                        var (n, p) = (now[b.Id], before[b.Id]);
                        return new
                        {
                            b.Code, b.Name, n.Orders, n.Net, netPct = Pct(n.Net, p.Net), share = Share(n.Net, all.Sum(x => x.Net)), n.DaysOpen, n.PerDay, perDayPct = Pct(n.PerDay, p.PerDay),
                            averageBill = n.AverageBill, averageBillPct = Pct(n.AverageBill, p.AverageBill), ordersPct = Pct(n.Orders, p.Orders),
                            dineIn = Share(n.DineIn, n.Net), takeaway = Share(n.Takeaway, n.Net), delivery = Share(n.Delivery, n.Net), platform = n.Platform, platformPct = Share(n.Platform, n.Net),
                            n.Discounts, discountPct = Share(n.Discounts, n.Gross + n.Discounts), n.Refunds, n.Voids, n.Wastage, wastagePct = Share(n.Wastage, n.Net), n.Variance, n.BusiestHour,
                        };
                    }),
                    total = new
                    {
                        orders = all.Sum(x => x.Orders), net = all.Sum(x => x.Net), netPct = Pct(all.Sum(x => x.Net), live.Sum(b => before[b.Id].Net)),
                        daysOpen = all.Sum(x => x.DaysOpen), discounts = all.Sum(x => x.Discounts), refunds = all.Sum(x => x.Refunds), voids = all.Sum(x => x.Voids),
                        wastage = all.Sum(x => x.Wastage), variance = all.Sum(x => x.Variance), platform = all.Sum(x => x.Platform),
                        averageBill = all.Sum(x => x.Orders) == 0 ? 0 : Money.Round(all.Sum(x => x.Net) / all.Sum(x => x.Orders)),
                    },
                    why,
                };
            });
        });
    }
}
