using Dapper;
using Npgsql;
using OnePos.Api.Data;
using OnePos.Api.Platform;

namespace OnePos.Api.Pos;

/// <summary>
/// Cash to bank: every cash sale is owed to the bank. A branch's balance is its cash sales less cash refunds, less its bank deposits,
/// by business day from its start date (branch.cash_bank_from); what isn't deposited carries forward. The float, cash paid out at the
/// till and shift shortages don't change it. Read-only: deposits are recorded on the till (Cash in / out → Bank deposit).
/// </summary>
public static class CashToBank
{
    public sealed record DayRow(DateOnly Date, decimal CashSales, decimal Refunds, decimal Deposited);
    public sealed record DepositRow(DateOnly Date, decimal Amount, string? BagNo, string TakenBy, string? Register, DateTime At);

    public static void Map(RouteGroupBuilder api)
    {
        // This branch's days (newest first) with brought forward / carried forward, its deposits, and each branch's balance now.
        api.MapGet("/cash-bank", async (HttpContext http, Db db) =>
        {
            var scope = await http.ScopeAsync(db);
            if (!scope.Can("reports.view")) scope.Require("day.manage");
            return await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var branch = scope.Branch;
                var start = await c.ExecuteScalarAsync<DateOnly>("select cash_bank_from from branch where id = @branch", new { branch }, tx);
                var days = await DaysAsync(c, tx, [branch]);
                var mine = days.GetValueOrDefault(branch) ?? [];
                var rows = new List<object>();
                decimal balance = 0;
                foreach (var d in mine)
                {
                    var brought = balance;
                    balance += d.CashSales - d.Refunds - d.Deposited;
                    rows.Add(new { d.Date, broughtForward = brought, d.CashSales, d.Refunds, d.Deposited, carriedForward = balance });
                }
                rows.Reverse();
                var deposits = (await c.QueryAsync<DepositRow>("""
                    select bd.date, d.amount, d.bag_no, d.taken_by, r.name as register, d.at
                    from bank_deposit d join business_day bd on bd.id = d.business_day_id
                    left join shift s on s.id = d.shift_id left join register r on r.id = s.register_id
                    where d.branch_id = @branch and bd.date >= @start order by d.at desc
                    """, new { branch, start }, tx)).ToList();
                var month = DateOnly.FromDateTime(DateTime.UtcNow);
                return new
                {
                    from = start, owed = balance, oldest = Oldest(mine, balance),
                    depositedThisMonth = mine.Where(d => d.Date.Year == month.Year && d.Date.Month == month.Month).Sum(d => d.Deposited),
                    days = rows, deposits,
                    branches = await BranchesAsync(c, tx),
                };
            });
        });
    }

    /// <summary>Each branch's cash days from its start date, oldest first: only days with cash sales, refunds or deposits.</summary>
    private static async Task<Dictionary<Guid, List<DayRow>>> DaysAsync(NpgsqlConnection c, NpgsqlTransaction tx, Guid[] branches)
    {
        var rows = await c.QueryAsync<(Guid Branch, DateOnly Date, decimal CashSales, decimal Refunds, decimal Deposited)>("""
            with b as (select id, cash_bank_from from branch where id = any(@branches)),
            cash as (
              select p.branch_id, p.business_date as date,
                     sum(case when p.kind = 'payment' then p.amount else 0 end) as sales,
                     sum(case when p.kind = 'refund' then p.amount else 0 end) as refunds
              from payment p join b on b.id = p.branch_id
              where p.method = 'cash' and p.business_date >= b.cash_bank_from group by 1, 2),
            dep as (
              select d.branch_id, bd.date, sum(d.amount) as deposited
              from bank_deposit d join business_day bd on bd.id = d.business_day_id join b on b.id = d.branch_id
              where bd.date >= b.cash_bank_from group by 1, 2)
            select coalesce(cash.branch_id, dep.branch_id), coalesce(cash.date, dep.date),
                   coalesce(cash.sales, 0), coalesce(cash.refunds, 0), coalesce(dep.deposited, 0)
            from cash full join dep on dep.branch_id = cash.branch_id and dep.date = cash.date
            order by 1, 2
            """, new { branches }, tx);
        return rows.GroupBy(r => r.Branch).ToDictionary(g => g.Key, g => g.Select(r => new DayRow(r.Date, r.CashSales, r.Refunds, r.Deposited)).ToList());
    }

    /// <summary>The oldest business day whose cash isn't all deposited yet: deposits pay off the oldest cash first.</summary>
    private static DateOnly? Oldest(List<DayRow> days, decimal owed)
    {
        if (owed <= 0) return null;
        var left = owed;
        for (var i = days.Count - 1; i >= 0; i--)
        {
            var net = days[i].CashSales - days[i].Refunds;
            if (net <= 0) continue;
            left -= net;
            if (left <= 0) return days[i].Date;
        }
        return days.FirstOrDefault()?.Date;
    }

    /// <summary>Every branch of the company: what it owes the bank now and since when.</summary>
    private static async Task<List<object>> BranchesAsync(NpgsqlConnection c, NpgsqlTransaction tx)
    {
        var branches = (await c.QueryAsync<(Guid Id, string Code, string Name)>("select id, code, name from branch where is_active order by code", transaction: tx)).ToList();
        var days = await DaysAsync(c, tx, branches.Select(b => b.Id).ToArray());
        return branches.Select(b =>
        {
            var list = days.GetValueOrDefault(b.Id) ?? [];
            var owed = list.Sum(d => d.CashSales - d.Refunds - d.Deposited);
            return (object)new { b.Id, b.Code, b.Name, owed, oldest = Oldest(list, owed) };
        }).ToList();
    }
}
