using Dapper;
using Npgsql;
using OnePos.Api.Data;
using OnePos.Api.Platform;

namespace OnePos.Api.Pos;

/// <summary>
/// Items sold per branch and business day (sales_day_item), summed once the day is over, so reports over months or a year don't
/// read every bill line ever rung and stay as fast as the years of history grow. A summed day is summed again whenever one of
/// its bills changes (a carried-over bill paid later, an item returned) and forgotten when the day is reopened; the days not
/// summed yet (today, the open day) are read from the bills as before.
/// </summary>
public static class SalesSummary
{
    // One bill line's share of what its bill was paid (discounts and service charge spread over the lines), less what was refunded on it.
    private const string ItemsOfDaysSql = """
        with refunded as (
          select cl.order_line_id, sum(cl.amount) as amount from credit_note_line cl
          join credit_note n on n.id = cl.credit_note_id join pos_order o on o.id = n.order_id
          join days d on d.b = o.branch_id and d.d = o.business_date group by cl.order_line_id)
        select o.company_id, o.branch_id, o.business_date, l.item_id, l.name, sum(l.qty - l.returned_qty) as qty,
               sum(case when o.subtotal - o.discount_total = 0 then 0 else o.total * (l.line_total - l.discount) / (o.subtotal - o.discount_total) end - coalesce(r.amount, 0)) as sales
        from days d join pos_order o on o.branch_id = d.b and o.business_date = d.d
        join order_line l on l.order_id = o.id
        left join refunded r on r.order_line_id = l.id
        where o.status in ('paid','refunded') and not l.is_void and l.qty > 0
        group by o.company_id, o.branch_id, o.business_date, l.item_id, l.name
        """;

    /// <summary>Sums one finished day of a branch (again, if it was summed before).</summary>
    public static async Task BuildDayAsync(NpgsqlConnection c, NpgsqlTransaction tx, Guid companyId, Guid branchId, DateOnly date)
    {
        await c.ExecuteAsync("delete from sales_day_item where branch_id = @branchId and business_date = @date", new { branchId, date }, tx);
        await c.ExecuteAsync($"""
            with days as (select @branchId::uuid as b, @date::date as d)
            insert into sales_day_item (company_id, branch_id, business_date, item_id, name, qty, sales)
            {ItemsOfDaysSql}
            """, new { branchId, date }, tx);
        await c.ExecuteAsync("""
            insert into sales_day_built (company_id, branch_id, business_date) values (@companyId, @branchId, @date)
            on conflict (branch_id, business_date) do update set built_at = now()
            """, new { companyId, branchId, date }, tx);
    }

    /// <summary>A bill of a summed day changed: that day is summed again (in the same transaction, so a report never sees it half done).</summary>
    public static async Task RefreshAsync(NpgsqlConnection c, NpgsqlTransaction tx, Guid companyId, Guid branchId, DateOnly date)
    {
        if (await c.ExecuteScalarAsync<bool>("select exists (select 1 from sales_day_built where branch_id = @branchId and business_date = @date)", new { branchId, date }, tx))
            await BuildDayAsync(c, tx, companyId, branchId, date);
    }

    /// <summary>The day was reopened: its bills are read directly again until it's over.</summary>
    public static async Task ForgetDayAsync(NpgsqlConnection c, NpgsqlTransaction tx, Guid branchId, DateOnly date)
    {
        await c.ExecuteAsync("delete from sales_day_item where branch_id = @branchId and business_date = @date", new { branchId, date }, tx);
        await c.ExecuteAsync("delete from sales_day_built where branch_id = @branchId and business_date = @date", new { branchId, date }, tx);
    }

    /// <summary>Items sold over a range of business days in these branches: summed days from the summary, the rest from the bills.</summary>
    public static Task<IEnumerable<(string Name, string? Category, decimal Qty, decimal Sales)>> ItemsAsync(
        NpgsqlConnection c, NpgsqlTransaction tx, Guid[] ids, DateOnly f, DateOnly t) =>
        c.QueryAsync<(string, string?, decimal, decimal)>($"""
            with days as materialized (
              -- The days in range not summed yet: usually just today.
              select b, d::date as d from unnest(@ids::uuid[]) b, generate_series(@f::date, @t::date, interval '1 day') d
              where not exists (select 1 from sales_day_built s where s.branch_id = b and s.business_date = d::date)),
            live as ({ItemsOfDaysSql}),
            x as (
              select item_id, name, qty, sales from live
              union all
              select item_id, name, qty, sales from sales_day_item where branch_id = any(@ids) and business_date between @f and @t)
            select x.name, cat.name, sum(x.qty), sum(x.sales)
            from x left join menu_item i on i.id = x.item_id left join menu_category cat on cat.id = i.category_id
            group by x.name, cat.name order by 4 desc
            """, new { ids, f, t }, tx);

    /// <summary>
    /// Sums the finished days not summed yet, every few minutes: a day is finished once it's closed, or (no day control on that
    /// date) two days have passed. Days of an open business day wait until it closes. Small batches, so the tills never wait on it.
    /// </summary>
    public sealed class Builder(Db db, ILogger<Builder> logger) : BackgroundService
    {
        protected override async Task ExecuteAsync(CancellationToken stop)
        {
            await Task.Delay(TimeSpan.FromSeconds(20), stop).ContinueWith(_ => { });
            while (!stop.IsCancellationRequested)
            {
                try
                {
                    var companies = await db.Platform((c, tx) => c.QueryAsync<Guid>("select id from company where is_active", transaction: tx));
                    foreach (var co in companies)
                    {
                        if (stop.IsCancellationRequested) break;
                        await BuildCompanyAsync(co, stop);
                    }
                }
                catch (Exception ex) { logger.LogWarning(ex, "Sales summary failed"); }
                await Task.Delay(TimeSpan.FromMinutes(10), stop).ContinueWith(_ => { });
            }
        }

        private async Task BuildCompanyAsync(Guid companyId, CancellationToken stop)
        {
            var branches = await db.Company(companyId, (c, tx) => c.QueryAsync<(Guid Id, string TimeZone, DateOnly? First, DateOnly? Open, DateOnly? LastClosed)>("""
                select b.id, b.time_zone,
                       (select min(business_date) from pos_order where branch_id = b.id),
                       (select date from business_day where branch_id = b.id and status = 'open'),
                       (select max(date) from business_day where branch_id = b.id and status = 'closed')
                from branch b
                """, transaction: tx));
            foreach (var b in branches.Where(x => x.First is not null))
            {
                var today = BusinessClock.Today(b.TimeZone);
                var last = b.Open is { } open ? open.AddDays(-1) : new[] { b.LastClosed ?? DateOnly.MinValue, today.AddDays(-2) }.Max();
                while (!stop.IsCancellationRequested)
                {
                    var built = await db.Company(companyId, async (c, tx) =>
                    {
                        var days = (await c.QueryAsync<DateOnly>("""
                            select d::date from generate_series(@first::date, @last::date, interval '1 day') d
                            where not exists (select 1 from sales_day_built s where s.branch_id = @id and s.business_date = d::date)
                            order by d limit 31
                            """, new { first = b.First, last, id = b.Id }, tx)).ToList();
                        foreach (var d in days) await BuildDayAsync(c, tx, companyId, b.Id, d);
                        return days.Count;
                    });
                    if (built == 0) break;
                }
            }
        }
    }
}
