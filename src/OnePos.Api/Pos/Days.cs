using System.Text.Json;
using Dapper;
using Npgsql;
using OnePos.Api.Data;
using OnePos.Api.Platform;

namespace OnePos.Api.Pos;

/// <summary>
/// Business days and shifts (REQ DAY-01 … DAY-10). The branch sells inside an open day (its date holds across midnight). Who opens
/// and closes it follows the branch's day control: Manual (day.manage), Cashier-run (day.shift may too), Automatic (on a schedule,
/// and on the first sale). Each cashier works a shift on a register: float counted, cash in / out, X report, blind count, variance
/// within tolerance or waiting for approval, shift Z report. Closing the day handles open orders by the branch's rule and keeps a Z report.
/// </summary>
public static class Days
{
    public sealed record OpenShiftBody(decimal OpeningFloat, JsonElement? Counts);
    public sealed record CloseShiftBody(decimal CountedCash, JsonElement? Counts, string? Note);
    public sealed record CashBody(string Kind, decimal Amount, string Reason);
    public sealed record ApproveBody(string? Note);
    public sealed record DepositBody(decimal Amount, string? BagNo, string TakenBy);

    public sealed class DayRow
    {
        public Guid Id { get; set; }
        public Guid BranchId { get; set; }
        public DateOnly Date { get; set; }
        public string Status { get; set; } = "";
        public DateTime OpenedAt { get; set; }
        public Guid? OpenedBy { get; set; }
        public string? OpenedByName { get; set; }
        public DateTime? ClosedAt { get; set; }
        public string? ClosedByName { get; set; }
        public int Reopened { get; set; }
        public string? ZReport { get; set; }
        /// <summary>The closing countdown is on: the day closes at this moment (automatic day control).</summary>
        public DateTime? ClosingAt { get; set; }
        /// <summary>Closing was delayed (customers still waiting) until this moment; DelayedMinutes in all.</summary>
        public DateTime? DelayedUntil { get; set; }
        public int DelayedMinutes { get; set; }
    }

    public sealed class ShiftRow
    {
        public Guid Id { get; set; }
        public Guid BusinessDayId { get; set; }
        public Guid RegisterId { get; set; }
        public string? RegisterName { get; set; }
        public Guid UserId { get; set; }
        public string? UserName { get; set; }
        public string Status { get; set; } = "";
        public DateTime OpenedAt { get; set; }
        public decimal OpeningFloat { get; set; }
        public decimal FloatExpected { get; set; }
        public DateTime? ClosedAt { get; set; }
        public decimal? ExpectedCash { get; set; }
        public decimal? CountedCash { get; set; }
        public decimal? Variance { get; set; }
        public string? Note { get; set; }
        public string? ApprovedByName { get; set; }
        /// <summary>The till's drawer is shared: every cashier there works in this shift.</summary>
        public bool SharedDrawer { get; set; }
    }

    private sealed class Branch
    {
        public Guid Id { get; set; }
        public Guid CompanyId { get; set; }
        public string DayControl { get; set; } = "";
        public string TimeZone { get; set; } = "";
        public TimeOnly AutoOpenTime { get; set; }
        public TimeOnly AutoCloseTime { get; set; }
        public decimal VarianceTolerance { get; set; }
        public decimal DefaultFloat { get; set; }
        public string OpenOrdersAtClose { get; set; } = "";
        public int CloseDelayMinutes { get; set; }
        public int CloseDelayMaxMinutes { get; set; }
    }

    /// <summary>How long the tills count down before the day closes by itself.</summary>
    public static readonly TimeSpan Countdown = TimeSpan.FromSeconds(60);

    /// <summary>
    /// An automatic branch's opening window now: whether it's inside it, and the closing time that ends it (or, outside it, the one
    /// that just passed), as a UTC moment.
    /// </summary>
    private static (bool InWindow, DateTime CloseUtc) Window(Branch b, DateTime nowUtc)
    {
        var zone = BusinessClock.Zone(b.TimeZone);
        var localNow = TimeZoneInfo.ConvertTimeFromUtc(nowUtc, zone);
        var local = TimeOnly.FromDateTime(localNow);
        var inWindow = b.AutoOpenTime < b.AutoCloseTime
            ? local >= b.AutoOpenTime && local < b.AutoCloseTime
            : local >= b.AutoOpenTime || local < b.AutoCloseTime;
        var close = localNow.Date + b.AutoCloseTime.ToTimeSpan();
        if (inWindow && close <= localNow) close = close.AddDays(1);
        if (!inWindow && close > localNow) close = close.AddDays(-1);
        return (inWindow, TimeZoneInfo.ConvertTimeToUtc(DateTime.SpecifyKind(close, DateTimeKind.Unspecified), zone));
    }

    /// <summary>
    /// When an open day closes by itself: the first closing time after it was opened. A day started early (08:23, before a 10:00
    /// opening) closes at the coming 03:00, not at once; a 03:00 missed while the server was off is caught up when it's back.
    /// </summary>
    private static DateTime CloseDueUtc(Branch b, DateTime openedUtc)
    {
        var zone = BusinessClock.Zone(b.TimeZone);
        var opened = TimeZoneInfo.ConvertTimeFromUtc(openedUtc, zone);
        var close = opened.Date + b.AutoCloseTime.ToTimeSpan();
        if (close <= opened) close = close.AddDays(1);
        return TimeZoneInfo.ConvertTimeToUtc(DateTime.SpecifyKind(close, DateTimeKind.Unspecified), zone);
    }

    private const string ShiftSql = """
        select s.*, r.name as register_name, r.shared_drawer, u.display_name as user_name, a.display_name as approved_by_name
        from shift s join register r on r.id = s.register_id join app_user u on u.id = s.user_id left join app_user a on a.id = s.approved_by
        """;

    private static Task<Branch> BranchAsync(NpgsqlConnection c, NpgsqlTransaction tx, Guid branchId) =>
        c.QuerySingleAsync<Branch>("select * from branch where id = @branchId", new { branchId }, tx);

    /// <summary>
    /// The branch's open business day, for anything that sells or pays. None open: Automatic and Cashier-run branches open one now;
    /// a Manual branch says a manager must open it.
    /// </summary>
    public static async Task<DayRow> CurrentAsync(NpgsqlConnection c, NpgsqlTransaction tx, Guid branchId, Guid? userId)
    {
        var day = await c.QuerySingleOrDefaultAsync<DayRow>("select * from business_day where branch_id = @branchId and status = 'open'", new { branchId }, tx);
        if (day is not null) return day;
        var b = await BranchAsync(c, tx, branchId);
        if (b.DayControl == "manual") throw new DomainException("The business day isn't open yet. A manager opens it under Day.");
        return await OpenDayAsync(c, tx, b, b.DayControl == "automatic" ? null : userId);
    }

    /// <summary>The date to sell under: the open day's, or (nothing open, e.g. reports) today in the branch's time zone.</summary>
    public static async Task<DateOnly> DateAsync(NpgsqlConnection c, NpgsqlTransaction tx, Guid branchId)
    {
        var d = await c.ExecuteScalarAsync<DateOnly?>("select date from business_day where branch_id = @branchId and status = 'open'", new { branchId }, tx);
        return d ?? BusinessClock.Today(await c.ExecuteScalarAsync<string>("select time_zone from branch where id = @branchId", new { branchId }, tx) ?? "Asia/Dubai");
    }

    private static async Task<DayRow> OpenDayAsync(NpgsqlConnection c, NpgsqlTransaction tx, Branch b, Guid? userId)
    {
        var date = BusinessClock.Today(b.TimeZone);
        // Today's day was already closed (e.g. closed early by mistake): it is reopened, not opened again under another date.
        if (await c.ExecuteScalarAsync<bool>("select exists (select 1 from business_day where branch_id = @id and date >= @date)", new { b.Id, date }, tx))
            throw new DomainException(userId is null ? "Today's business day is already closed." : "Today's business day was already closed. A manager can reopen it under Day & shifts.");
        var id = await c.ExecuteScalarAsync<Guid>("insert into business_day (company_id, branch_id, date, opened_by) values (@co, @b, @date, @userId) returning id",
            new { co = b.CompanyId, b = b.Id, date, userId }, tx);
        await Audit.RecordAsync(c, tx, b.CompanyId, b.Id, userId ?? Guid.Empty, "day", id.ToString(), "opened", $"Business day {date:dd MMM yyyy} opened{(userId is null ? " automatically" : "")}");
        return await c.QuerySingleAsync<DayRow>("select * from business_day where id = @id", new { id }, tx);
    }

    /// <summary>The open shift of this person on this register (a till must have one to take payments).</summary>
    public static Task<Guid?> ShiftOfAsync(NpgsqlConnection c, NpgsqlTransaction tx, Guid? registerId, Guid userId) =>
        registerId is null ? Task.FromResult<Guid?>(null)
        // Their own open shift on this register, or — a shared drawer — whoever opened it.
        : c.ExecuteScalarAsync<Guid?>("""
            select s.id from shift s join register r on r.id = s.register_id
            where s.register_id = @registerId and s.status = 'open' and (s.user_id = @userId or r.shared_drawer)
            """, new { registerId, userId }, tx);

    /// <summary>The cash the drawer should hold: float + cash taken − cash paid back + cash in − cash out − drops − bank deposits.</summary>
    private static async Task<(decimal Expected, object Parts)> ExpectedAsync(NpgsqlConnection c, NpgsqlTransaction tx, Guid shiftId)
    {
        var p = await c.QuerySingleAsync<(decimal Float, decimal Sales, decimal Refunds, decimal In, decimal Out, decimal Drops, decimal Deposits)>("""
            select s.opening_float,
              coalesce((select sum(amount) from payment where shift_id = s.id and method = 'cash' and kind = 'payment'), 0),
              coalesce((select sum(amount) from payment where shift_id = s.id and method = 'cash' and kind = 'refund'), 0),
              coalesce((select sum(amount) from cash_movement where shift_id = s.id and kind = 'in'), 0),
              coalesce((select sum(amount) from cash_movement where shift_id = s.id and kind = 'out'), 0),
              coalesce((select sum(amount) from cash_movement where shift_id = s.id and kind = 'drop'), 0),
              coalesce((select sum(amount) from cash_movement where shift_id = s.id and kind = 'deposit'), 0)
            from shift s where s.id = @shiftId
            """, new { shiftId }, tx);
        var expected = p.Float + p.Sales - p.Refunds + p.In - p.Out - p.Drops - p.Deposits;
        return (expected, new { openingFloat = p.Float, cashSales = p.Sales, cashRefunds = p.Refunds, cashIn = p.In, cashOut = p.Out, drops = p.Drops, deposits = p.Deposits, expected });
    }

    /// <summary>An X (shift, still open) or Z (closed) report of a shift: what it took, by method, and its cash.</summary>
    private static async Task<object> ShiftReportAsync(NpgsqlConnection c, NpgsqlTransaction tx, Guid shiftId)
    {
        var s = await c.QuerySingleAsync<ShiftRow>($"{ShiftSql} where s.id = @shiftId", new { shiftId }, tx);
        var (expected, cash) = await ExpectedAsync(c, tx, shiftId);
        // Platform payments per platform (Talabat, Deliveroo…: the platform of the order they paid), card payments per card type.
        var methods = (await c.QueryAsync<(string Method, string Kind, string? Platform, string? CardType, decimal Amount, int Count)>("""
            select p.method, p.kind, case when p.method = 'platform' then dp.name end, case when p.method = 'card' then p.card_type end, sum(p.amount), count(*)::int
            from payment p left join pos_order o on o.id = p.order_id left join delivery_platform dp on dp.id = o.platform_id
            where p.shift_id = @shiftId group by 1, 2, 3, 4 order by 1, 3, 4
            """, new { shiftId }, tx)).Select(m => new { m.Method, m.Kind, m.Platform, m.CardType, m.Amount, m.Count });
        // The orders paid in this shift by type, each delivery platform apart from the branch's own delivery.
        var byType = (await c.QueryAsync<(string Type, string? Platform, int Orders, decimal Amount)>("""
            select o.order_type, dp.name, count(*)::int, sum(o.total) from pos_order o left join delivery_platform dp on dp.id = o.platform_id
            where o.id in (select order_id from payment where shift_id = @shiftId and kind = 'payment') and o.status in ('paid','refunded')
            group by 1, 2 order by 1, 2 nulls first
            """, new { shiftId }, tx)).Select(t => new { t.Type, t.Platform, t.Orders, t.Amount });
        var movements = await c.QueryAsync<(string Kind, decimal Amount, string Reason, DateTime At)>(
            "select kind, amount, reason, at from cash_movement where shift_id = @shiftId order by at", new { shiftId }, tx);
        // Who took what in this shift (a shared drawer has several cashiers): payments taken less refunds given, cash and in all.
        var byCashier = (await c.QueryAsync<(string Name, decimal Cash, decimal Total, int Payments)>("""
            select coalesce(u.display_name, '—'),
                   coalesce(sum(case when p.method = 'cash' then case when p.kind = 'refund' then -p.amount else p.amount end end), 0),
                   coalesce(sum(case when p.kind = 'refund' then -p.amount else p.amount end), 0),
                   count(*) filter (where p.kind = 'payment')::int
            from payment p left join app_user u on u.id = p.taken_by where p.shift_id = @shiftId
            group by u.display_name order by 3 desc
            """, new { shiftId }, tx)).Select(x => new { name = x.Name, cash = x.Cash, total = x.Total, payments = x.Payments }).ToList();
        return new
        {
            kind = s.Status == "open" ? "X" : "Z", shift = s, cash, expected,
            payments = methods, byType, movements = movements.Select(m => new { m.Kind, m.Amount, m.Reason, m.At }), byCashier,
            orders = await c.ExecuteScalarAsync<int>("select count(distinct order_id)::int from payment where shift_id = @shiftId and kind = 'payment'", new { shiftId }, tx),
        };
    }

    public sealed record CashMove(string Kind, decimal Amount, string Reason, string? Register, string? By, DateTime At);
    /// <summary>The day's cash, till by till (see <see cref="DayCashAsync"/>).</summary>
    public sealed record DayCash(decimal OpeningFloat, decimal CashSales, decimal CashRefunds, decimal CashIn, decimal CashOut, decimal Drops, decimal Deposits,
        decimal ShiftChange, decimal Expected, decimal Counted, int Uncounted, IReadOnlyList<CashMove> Movements);

    /// <summary>
    /// The day's cash, TILL BY TILL: a till's shifts follow each other in one drawer, so the next shift's float is (mostly) the cash the
    /// last one counted, not more money. Per till: the first shift's float + every shift's cash sales − refunds + cash in − cash out −
    /// drops − bank deposits; what was taken out (or put in) between shifts = the last count less the next float; the drawer should
    /// end on the last shift's expected, against the last shift's count (a till whose last shift isn't counted yet counts nothing).
    /// </summary>
    public static async Task<DayCash> DayCashAsync(NpgsqlConnection c, NpgsqlTransaction tx, Guid dayId)
    {
        var shifts = (await c.QueryAsync<(Guid Id, Guid Register, decimal Float, string Status, decimal? Expected, decimal? Counted)>("""
            select id, register_id, opening_float, status, expected_cash, counted_cash from shift where business_day_id = @dayId order by register_id, opened_at
            """, new { dayId }, tx)).ToList();
        var flows = await c.QuerySingleAsync<(decimal Sales, decimal Refunds, decimal In, decimal Out, decimal Drops, decimal Deposits)>("""
            select
              coalesce((select sum(amount) from payment p join shift x on x.id = p.shift_id where x.business_day_id = @dayId and p.method = 'cash' and p.kind = 'payment'), 0),
              coalesce((select sum(amount) from payment p join shift x on x.id = p.shift_id where x.business_day_id = @dayId and p.method = 'cash' and p.kind = 'refund'), 0),
              coalesce((select sum(amount) from cash_movement m join shift x on x.id = m.shift_id where x.business_day_id = @dayId and m.kind = 'in'), 0),
              coalesce((select sum(amount) from cash_movement m join shift x on x.id = m.shift_id where x.business_day_id = @dayId and m.kind = 'out'), 0),
              coalesce((select sum(amount) from cash_movement m join shift x on x.id = m.shift_id where x.business_day_id = @dayId and m.kind = 'drop'), 0),
              coalesce((select sum(amount) from cash_movement m join shift x on x.id = m.shift_id where x.business_day_id = @dayId and m.kind = 'deposit'), 0)
            """, new { dayId }, tx);
        decimal firstFloats = 0, change = 0, expected = 0, counted = 0;
        var uncounted = 0;
        foreach (var till in shifts.GroupBy(s => s.Register))
        {
            var list = till.ToList();
            firstFloats += list[0].Float;
            for (var i = 1; i < list.Count; i++)
            {
                var before = list[i - 1].Counted ?? list[i - 1].Expected ?? (await ExpectedAsync(c, tx, list[i - 1].Id)).Expected;
                change += before - list[i].Float;
            }
            var last = list[^1];
            expected += last.Status == "open" || last.Expected is null ? (await ExpectedAsync(c, tx, last.Id)).Expected : last.Expected.Value;
            if (last.Counted is { } k) counted += k; else uncounted++;
        }
        var moves = (await c.QueryAsync<CashMove>("""
            select m.kind, m.amount, m.reason, r.name as register, u.display_name as "by", m.at from cash_movement m join shift x on x.id = m.shift_id
            left join register r on r.id = x.register_id left join app_user u on u.id = m.by_user
            where x.business_day_id = @dayId order by m.at
            """, new { dayId }, tx)).ToList();
        return new DayCash(firstFloats, flows.Sales, flows.Refunds, flows.In, flows.Out, flows.Drops, flows.Deposits, change, expected, counted, uncounted, moves);
    }

    /// <summary>The day's Z report: sales, VAT, discounts, by type and method, refunds, voids, shifts and their variances, deposits.</summary>
    private static async Task<object> DayReportAsync(NpgsqlConnection c, NpgsqlTransaction tx, DayRow day)
    {
        var args = new { b = day.BranchId, d = day.Date, id = day.Id };
        var sales = await c.QuerySingleAsync<(int Orders, decimal Gross, decimal Vat, decimal Discounts, decimal Service, int Guests)>("""
            select count(*)::int, coalesce(sum(total), 0), coalesce(sum(vat), 0), coalesce(sum(discount_total), 0), coalesce(sum(service_charge), 0), coalesce(sum(guests), 0)::int
            from pos_order where branch_id = @b and business_date = @d and status in ('paid','refunded')
            """, args, tx);
        // By type, each delivery platform apart from the branch's own delivery; platform payments per platform.
        var byType = await c.QueryAsync<(string Type, string? Platform, int Orders, decimal Amount)>("""
            select o.order_type, dp.name, count(*)::int, sum(o.total) from pos_order o left join delivery_platform dp on dp.id = o.platform_id
            where o.branch_id = @b and o.business_date = @d and o.status in ('paid','refunded') group by 1, 2 order by 1, 2 nulls first
            """, args, tx);
        var methods = await c.QueryAsync<(string Method, string Kind, string? Platform, string? CardType, decimal Amount)>("""
            select p.method, p.kind, case when p.method = 'platform' then dp.name end, case when p.method = 'card' then p.card_type end, sum(p.amount)
            from payment p left join pos_order o on o.id = p.order_id left join delivery_platform dp on dp.id = o.platform_id
            where p.branch_id = @b and p.business_date = @d group by 1, 2, 3, 4 order by 1, 3, 4
            """, args, tx);
        var notes = await c.QuerySingleAsync<(int Count, decimal Total, decimal Vat)>("""
            select count(*)::int, coalesce(sum(total), 0), coalesce(sum(vat), 0) from credit_note where branch_id = @b and business_date = @d
            """, args, tx);
        var voids = await c.QuerySingleAsync<(int Count, decimal Value)>("""
            select count(*)::int, coalesce(sum(total), 0) from pos_order where branch_id = @b and business_date = @d and status = 'void'
            """, args, tx);
        var shifts = (await c.QueryAsync<ShiftRow>($"{ShiftSql} where s.business_day_id = @id order by s.opened_at", args, tx)).ToList();
        // Bank deposits: from a drawer (its register) or from the safe (recorded on Day & shifts).
        var deposits = await c.QueryAsync<(decimal Amount, string? BagNo, string TakenBy, DateTime At, string? Register)>("""
            select d.amount, d.bag_no, d.taken_by, d.at, r.name from bank_deposit d left join shift s on s.id = d.shift_id left join register r on r.id = s.register_id
            where d.business_day_id = @id order by d.at
            """, args, tx);
        var cash = await DayCashAsync(c, tx, day.Id);
        var open = await c.QuerySingleAsync<(int Count, decimal Value)>("select count(*)::int, coalesce(sum(total), 0) from pos_order where branch_id = @b and status = 'open'", args, tx);
        var waste = await c.QuerySingleAsync<(int Count, decimal Value)>(
            "select count(*)::int, coalesce(sum(cost_value), 0) from wastage where branch_id = @b and business_date = @d and voided_at is null", args, tx);
        return new
        {
            date = day.Date, status = day.Status,
            sales = new { sales.Orders, gross = sales.Gross, net = sales.Gross - sales.Vat, sales.Vat, sales.Discounts, serviceCharge = sales.Service, sales.Guests },
            refunds = new { notes.Count, notes.Total, notes.Vat },
            netSales = sales.Gross - notes.Total,
            byType = byType.Select(t => new { t.Type, t.Platform, t.Orders, t.Amount }),
            payments = methods.Select(m => new { m.Method, m.Kind, m.Platform, m.CardType, m.Amount }),
            voids = new { voids.Count, voids.Value },
            shifts = shifts.Select(s => new { s.Id, s.RegisterName, s.UserName, s.Status, s.OpeningFloat, s.ExpectedCash, s.CountedCash, s.Variance }),
            variance = shifts.Sum(s => s.Variance ?? 0),
            deposits = deposits.Select(x => new { x.Amount, x.BagNo, x.TakenBy, x.At, fromRegister = x.Register }),
            depositTotal = deposits.Sum(x => x.Amount),
            cash,
            openOrders = new { open.Count, open.Value },
            wastage = new { waste.Count, waste.Value },
            noSales = await c.ExecuteScalarAsync<int>("select count(*)::int from no_sale where branch_id = @b and business_date = @d", args, tx),
        };
    }

    /// <summary>Closes a shift: the count against the expected cash; outside the tolerance it waits for a manager (or, uncounted, says so).</summary>
    private static async Task CloseShiftAsync(NpgsqlConnection c, NpgsqlTransaction tx, ShiftRow s, decimal? counted, string? counts, string? note, Guid? byUser, decimal tolerance)
    {
        var (expected, _) = await ExpectedAsync(c, tx, s.Id);
        var variance = counted is { } k ? k - expected : (decimal?)null;
        var status = counted is null ? "not_counted" : Math.Abs(variance!.Value) <= tolerance ? "closed" : "needs_approval";
        await c.ExecuteAsync("""
            update shift set status = @status, closed_at = now(), expected_cash = @expected, counted_cash = @counted, closing_counts = cast(@counts as jsonb),
              variance = @variance, note = @note where id = @id
            """, new { s.Id, status, expected, counted, counts, variance, note }, tx);
        var z = JsonSerializer.Serialize(await ShiftReportAsync(c, tx, s.Id), new JsonSerializerOptions(JsonSerializerDefaults.Web));
        await c.ExecuteAsync("update shift set z_report = cast(@z as jsonb) where id = @id", new { z, s.Id }, tx);
        var co = await c.ExecuteScalarAsync<Guid>("select company_id from shift where id = @id", new { s.Id }, tx);
        var branch = await c.ExecuteScalarAsync<Guid>("select branch_id from shift where id = @id", new { s.Id }, tx);
        await Audit.RecordAsync(c, tx, co, branch, byUser ?? Guid.Empty, "shift", s.Id.ToString(), status,
            counted is null ? $"Shift of {s.UserName} on {s.RegisterName} closed without a count" : $"Shift of {s.UserName} on {s.RegisterName} closed: counted {counted:N2}, expected {expected:N2}, variance {variance:+0.00;-0.00;0.00}",
            note: note);
    }

    /// <summary>Closes the day: shifts (automatic: uncounted ones close as "not counted"), open orders by the branch's rule, Z report.</summary>
    private static async Task<object> CloseDayAsync(NpgsqlConnection c, NpgsqlTransaction tx, Branch b, DayRow day, Guid? byUser, bool automatic)
    {
        var open = (await c.QueryAsync<ShiftRow>($"{ShiftSql} where s.business_day_id = @id and s.status = 'open'", new { day.Id }, tx)).ToList();
        if (open.Count > 0 && !automatic)
            throw new DomainException($"Close the open shift{(open.Count == 1 ? "" : "s")} first: {string.Join(", ", open.Select(s => $"{s.UserName} on {s.RegisterName}"))}.");
        foreach (var s in open) await CloseShiftAsync(c, tx, s, null, null, "Closed with the day", byUser, b.VarianceTolerance);
        // Open orders: empty ones go; "void_unsent" voids those the kitchen never got; the rest carry into the next day.
        await c.ExecuteScalarAsync<int>("""
            with gone as (
              delete from pos_order o where o.branch_id = @b and o.status = 'open'
                and not exists (select 1 from order_line l where l.order_id = o.id) and not exists (select 1 from payment p where p.order_id = o.id)
              returning o.id
            ), fix as (update reservation set status = 'booked', order_id = null where order_id in (select id from gone))
            select count(*)::int from gone
            """, new { b = b.Id }, tx);
        if (b.OpenOrdersAtClose == "void_unsent")
        {
            var unsent = (await c.QueryAsync<Guid>("""
                select o.id from pos_order o where o.branch_id = @b and o.status = 'open' and o.paid = 0
                  and not exists (select 1 from order_line l where l.order_id = o.id and l.sent_qty > 0)
                """, new { b = b.Id }, tx)).ToArray();
            await c.ExecuteAsync("update pos_order set status = 'void', void_reason = 'Day closed', closed_at = now(), lock_session = null where id = any(@unsent)", new { unsent }, tx);
            await c.ExecuteAsync("delete from order_table where order_id = any(@unsent)", new { unsent }, tx);
        }
        // The kept Z report is of the closed day (it is built just before the status is saved).
        day.Status = "closed";
        var z = await DayReportAsync(c, tx, day);
        await c.ExecuteAsync("update business_day set status = 'closed', closed_at = now(), closed_by = @byUser, z_report = cast(@z as jsonb) where id = @id",
            new { day.Id, byUser, z = JsonSerializer.Serialize(z, new JsonSerializerOptions(JsonSerializerDefaults.Web)) }, tx);
        await Notices.OnDayClosedAsync(c, tx, b.CompanyId, b.Id, day.Date, b.VarianceTolerance);
        // The day's wastage to FACTS as a draft transfer, where the company sends it so (finance gives batches and posts it).
        await Erp.FactsPosting.EnqueueWastageAsync(c, tx, b.Id, day.Date);
        // The day's made-to-order items (a BOM valid that day) to FACTS as a draft repacking voucher: raw materials out, items in.
        await Boms.EnqueueRepackingAsync(c, tx, b.Id, day.Date);
        // The day's items summed for reports (bills carried over and paid later sum it again).
        await SalesSummary.BuildDayAsync(c, tx, b.CompanyId, b.Id, day.Date);
        await Audit.RecordAsync(c, tx, b.CompanyId, b.Id, byUser ?? Guid.Empty, "day", day.Id.ToString(), "closed", $"Business day {day.Date:dd MMM yyyy} closed{(automatic ? " automatically" : "")}");
        return z;
    }

    private static void RequireDayRight(Scope scope, string dayControl)
    {
        if (scope.Can("day.manage")) return;
        if (dayControl == "cashier" && scope.Can("day.shift")) return;
        throw new ForbiddenException(dayControl == "manual" ? "A manager opens and closes the day." : "Your role can't open or close the day.");
    }

    public static void Map(RouteGroupBuilder api)
    {
        // The day screen: today's day, its shifts, my shift (on a till), and the last closed days.
        api.MapGet("/day", async (HttpContext http, Db db) =>
        {
            var scope = await http.ScopeAsync(db);
            if (!scope.Can("day.shift")) scope.Require("day.manage");
            return await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var b = await BranchAsync(c, tx, scope.Branch);
                var day = await c.QuerySingleOrDefaultAsync<DayRow>("""
                    select d.*, u.display_name as opened_by_name, cu.display_name as closed_by_name from business_day d
                    left join app_user u on u.id = d.opened_by left join app_user cu on cu.id = d.closed_by
                    where d.branch_id = @b and d.status = 'open'
                    """, new { b = scope.Branch }, tx);
                var shifts = day is null ? [] : (await c.QueryAsync<ShiftRow>($"{ShiftSql} where s.business_day_id = @id order by s.opened_at", new { day.Id }, tx)).ToList();
                var pending = (await c.QueryAsync<ShiftRow>($"{ShiftSql} where s.branch_id = @b and s.status = 'needs_approval' order by s.closed_at", new { b = scope.Branch }, tx)).ToList();
                var recent = (await c.QueryAsync<DayRow>("""
                    select d.*, u.display_name as opened_by_name, cu.display_name as closed_by_name from business_day d
                    left join app_user u on u.id = d.opened_by left join app_user cu on cu.id = d.closed_by
                    where d.branch_id = @b and d.status = 'closed' order by d.date desc limit 14
                    """, new { b = scope.Branch }, tx)).ToList();
                var myShift = await ShiftOfAsync(c, tx, scope.RegisterId, scope.UserId);
                // Automatic close: when it closes (with any delay), whether the countdown is on, and whether it can wait longer.
                DateTime? closesAt = null;
                if (day is not null && b.DayControl == "automatic")
                {
                    var due = CloseDueUtc(b, day.OpenedAt);
                    closesAt = day.ClosingAt ?? (day.DelayedUntil is { } until && until > due ? until : due);
                }
                var canDelay = day is not null && b.DayControl == "automatic" && scope.Can("day.shift") && day.DelayedMinutes + b.CloseDelayMinutes <= b.CloseDelayMaxMinutes;
                return new
                {
                    closesAt, closingAt = day?.ClosingAt, delayedMinutes = day?.DelayedMinutes ?? 0, canDelay, delayStep = b.CloseDelayMinutes,
                    dayControl = b.DayControl, defaultFloat = b.DefaultFloat, tolerance = b.VarianceTolerance, openOrdersAtClose = b.OpenOrdersAtClose,
                    autoOpen = b.AutoOpenTime.ToString("HH:mm"), autoClose = b.AutoCloseTime.ToString("HH:mm"),
                    day, shifts, pending, myShiftId = myShift, registerId = scope.RegisterId,
                    report = day is null ? null : await DayReportAsync(c, tx, day),
                    recent = recent.Select(r => new { r.Id, r.Date, r.Status, r.OpenedAt, r.ClosedAt, r.OpenedByName, r.ClosedByName, r.Reopened, z = r.ZReport is null ? (JsonElement?)null : JsonDocument.Parse(r.ZReport).RootElement }),
                    canManage = scope.Can("day.manage") || (b.DayControl == "cashier" && scope.Can("day.shift")),
                    canReopen = scope.Can("day.reopen"),
                    canDeposit = scope.Can("day.manage") || scope.Can("day.deposit"),
                };
            });
        });

        api.MapPost("/day/open", async (HttpContext http, Db db, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            var day = await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var b = await BranchAsync(c, tx, scope.Branch);
                RequireDayRight(scope, b.DayControl);
                if (await c.ExecuteScalarAsync<bool>("select exists (select 1 from business_day where branch_id = @b and status = 'open')", new { b = b.Id }, tx))
                    throw new ConflictException("The day is already open.");
                return await OpenDayAsync(c, tx, b, scope.UserId);
            });
            await live.ToBranch(scope.Branch, "day.changed");
            return Results.Ok(day);
        });

        api.MapPost("/day/close", async (HttpContext http, Db db, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            var z = await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var b = await BranchAsync(c, tx, scope.Branch);
                RequireDayRight(scope, b.DayControl);
                var day = await c.QuerySingleOrDefaultAsync<DayRow>("select * from business_day where branch_id = @b and status = 'open' for update", new { b = b.Id }, tx)
                          ?? throw new DomainException("No business day is open.");
                return await CloseDayAsync(c, tx, b, day, scope.UserId, automatic: false);
            });
            await live.ToBranch(scope.Branch, "day.changed");
            await live.ToBranch(scope.Branch, "floor.changed");
            return Results.Ok(z);
        });

        // Reopen the last closed day (day.reopen), e.g. to fix a mistake. Phase 3: only until its sales are posted to the ERP.
        // The closing countdown: customers still waiting, so the day closes later (the branch's step, up to its limit).
        api.MapPost("/day/delay-close", async (HttpContext http, Db db, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("day.shift");
            var until = await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var b = await BranchAsync(c, tx, scope.Branch);
                if (b.DayControl != "automatic") throw new DomainException("This branch's day doesn't close by itself.");
                var day = await c.QuerySingleOrDefaultAsync<DayRow>("select * from business_day where branch_id = @b and status = 'open' for update", new { b = b.Id }, tx)
                          ?? throw new DomainException("The business day is already closed.");
                if (day.DelayedMinutes + b.CloseDelayMinutes > b.CloseDelayMaxMinutes)
                    throw new DomainException($"Closing can't wait any longer: it has already been delayed {day.DelayedMinutes} minutes (the limit is {b.CloseDelayMaxMinutes}).");
                var now = DateTime.UtcNow;
                var from = new[] { now, day.DelayedUntil ?? DateTime.MinValue, CloseDueUtc(b, day.OpenedAt) }.Max();
                if (day.ClosingAt is not null) from = now;   // the countdown was on: from now
                var until = from.AddMinutes(b.CloseDelayMinutes);
                await c.ExecuteAsync("update business_day set closing_at = null, delayed_until = @until, delayed_minutes = delayed_minutes + @step where id = @id",
                    new { until, step = b.CloseDelayMinutes, id = day.Id }, tx);
                await Audit.RecordAsync(c, tx, scope.CompanyId, b.Id, scope.UserId, "day", day.Id.ToString(), "close_delayed",
                    $"Closing delayed {b.CloseDelayMinutes} minutes (customers waiting)");
                return until;
            });
            await live.ToBranch(scope.Branch, "day.changed");
            return Results.Ok(new { delayedUntil = until });
        });

        // The closing countdown: close now instead of waiting for it to end.
        api.MapPost("/day/close-now", async (HttpContext http, Db db, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("day.shift");
            var at = await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var b = await BranchAsync(c, tx, scope.Branch);
                var day = await c.QuerySingleOrDefaultAsync<DayRow>("select * from business_day where branch_id = @b and status = 'open' for update", new { b = b.Id }, tx)
                          ?? throw new DomainException("The business day is already closed.");
                if (b.DayControl != "automatic" || day.ClosingAt is null) throw new DomainException("The day isn't closing now: a manager closes it under Day & shifts.");
                await CloseDayAsync(c, tx, b, day, scope.UserId, automatic: true);
                return TimeZoneInfo.ConvertTimeFromUtc(DateTime.UtcNow, BusinessClock.Zone(b.TimeZone)).ToString("HH:mm");
            });
            await live.ToBranch(scope.Branch, "day.changed");
            await live.ToBranch(scope.Branch, "floor.changed");
            await live.ToBranch(scope.Branch, "day.autoclosed", new { at });
            return Results.Ok(new { at });
        });

        api.MapPost("/day/{id:guid}/reopen", async (Guid id, HttpContext http, Db db, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("day.reopen");
            await db.Company(scope.CompanyId, async (c, tx) =>
            {
                if (await c.ExecuteScalarAsync<bool>("select exists (select 1 from business_day where branch_id = @b and status = 'open')", new { b = scope.Branch }, tx))
                    throw new DomainException("Close the open day first; only one day can be open.");
                var last = await c.ExecuteScalarAsync<Guid?>("select id from business_day where branch_id = @b order by date desc limit 1", new { b = scope.Branch }, tx);
                if (last != id) throw new DomainException("Only the last closed day can be reopened.");
                await c.ExecuteAsync("update business_day set status = 'open', closed_at = null, closed_by = null, reopened = reopened + 1, closing_at = null, delayed_until = null where id = @id", new { id }, tx);
                await SalesSummary.ForgetDayAsync(c, tx, scope.Branch, await c.ExecuteScalarAsync<DateOnly>("select date from business_day where id = @id", new { id }, tx));
                await Audit.RecordAsync(c, tx, scope.CompanyId, scope.Branch, scope.UserId, "day", id.ToString(), "reopened", "Business day reopened");
                return 0;
            });
            await live.ToBranch(scope.Branch, "day.changed");
            return Results.Ok(new { id });
        });

        api.MapPost("/shifts/open", async (OpenShiftBody body, HttpContext http, Db db, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("day.shift");
            if (scope.RegisterId is not { } reg) throw new DomainException("Pick the register you're at first: a shift is opened on a register.");
            if (body.OpeningFloat < 0) throw new DomainException("The float can't be negative.");
            var id = await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var day = await CurrentAsync(c, tx, scope.Branch, scope.UserId);
                if (await c.QuerySingleOrDefaultAsync<(string Who, bool Shared)?>("""
                        select u.display_name, r.shared_drawer from shift s join app_user u on u.id = s.user_id join register r on r.id = s.register_id
                        where s.register_id = @reg and s.status = 'open'
                        """, new { reg }, tx) is { } open)
                    throw new ConflictException(open.Shared
                        ? $"This till's drawer is shared and already open ({open.Who}'s count): just sell, your payments are kept under your name."
                        : $"{open.Who}'s shift is still open on this register. Close it first.");
                if (await ShiftOfAsync(c, tx, null, scope.UserId) is not null || await c.ExecuteScalarAsync<bool>("select exists (select 1 from shift where user_id = @u and branch_id = @b and status = 'open')", new { u = scope.UserId, b = scope.Branch }, tx))
                    throw new ConflictException("You already have a shift open on another register.");
                var b = await BranchAsync(c, tx, scope.Branch);
                var id = await c.ExecuteScalarAsync<Guid>("""
                    insert into shift (company_id, branch_id, business_day_id, register_id, user_id, opening_float, float_expected, opening_counts)
                    values (@co, @b, @day, @reg, @u, @f, @expected, cast(@counts as jsonb)) returning id
                    """, new { co = scope.CompanyId, b = scope.Branch, day = day.Id, reg, u = scope.UserId, f = Money.Round(body.OpeningFloat), expected = b.DefaultFloat,
                               counts = body.Counts?.GetRawText() }, tx);
                var diff = Money.Round(body.OpeningFloat) - b.DefaultFloat;
                await Audit.RecordAsync(c, tx, scope.CompanyId, scope.Branch, scope.UserId, "shift", id.ToString(), "opened",
                    $"Shift opened with a float of {body.OpeningFloat:N2}{(diff != 0 ? $" ({diff:+0.00;-0.00} against the expected {b.DefaultFloat:N2})" : "")}");
                return id;
            });
            await live.ToBranch(scope.Branch, "day.changed");
            return Results.Ok(new { id });
        });

        // A bank deposit straight from the drawer, during the shift: the cash leaves the drawer (its own movement, so the count still
        // balances and every X/Z shows it) and is the day's bank deposit (amount, bag number, who takes it). For whoever may record deposits.
        api.MapPost("/shifts/{id:guid}/deposit", async (Guid id, DepositBody body, HttpContext http, Db db, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            if (!scope.Can("day.manage")) scope.Require("day.deposit");
            if (body.Amount <= 0) throw new DomainException("Enter the amount deposited.");
            if (string.IsNullOrWhiteSpace(body.TakenBy)) throw new DomainException("Who takes it to the bank?");
            await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var s = await c.QuerySingleOrDefaultAsync<ShiftRow>($"{ShiftSql} where s.id = @id and s.branch_id = @b", new { id, b = scope.Branch }, tx) ?? throw new NotFoundException("Shift not found.");
                if (s.Status != "open") throw new DomainException("This shift is closed: record the deposit on Day & shifts instead.");
                if (s.UserId != scope.UserId && !(s.SharedDrawer && scope.Can("day.shift")) && !scope.Can("day.manage")) throw new ForbiddenException("Only the shift's own cashier or a manager can move its cash.");
                var amount = Money.Round(body.Amount);
                var bag = string.IsNullOrWhiteSpace(body.BagNo) ? null : body.BagNo.Trim();
                var who = body.TakenBy.Trim();
                await c.ExecuteAsync("insert into cash_movement (company_id, shift_id, kind, amount, reason, by_user) values (@co, @id, 'deposit', @amount, @reason, @u)",
                    new { co = scope.CompanyId, id, amount, reason = $"{(bag is null ? "" : $"bag {bag} · ")}{who}", u = scope.UserId }, tx);
                await c.ExecuteAsync("insert into bank_deposit (company_id, branch_id, business_day_id, amount, bag_no, taken_by, recorded_by, shift_id) values (@co, @b, @d, @amount, @bag, @who, @u, @id)",
                    new { co = scope.CompanyId, b = scope.Branch, d = s.BusinessDayId, amount, bag, who, u = scope.UserId, id }, tx);
                await Audit.RecordAsync(c, tx, scope.CompanyId, scope.Branch, scope.UserId, "shift", id.ToString(), "deposit", $"Bank deposit {amount:N2} from the drawer, taken by {who}", note: bag);
                return 0;
            });
            await live.ToBranch(scope.Branch, "day.changed");
            return Results.Ok(new { id });
        });

        api.MapPost("/shifts/{id:guid}/cash", async (Guid id, CashBody body, HttpContext http, Db db, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("day.shift");
            var kind = (body.Kind ?? "").Trim().ToLowerInvariant();
            if (kind is not ("in" or "out" or "drop")) throw new DomainException("Cash in, cash out or a drop to the safe.");
            if (body.Amount <= 0) throw new DomainException("Enter an amount.");
            if (string.IsNullOrWhiteSpace(body.Reason)) throw new DomainException("Give a reason.");
            await db.Company(scope.CompanyId, async (c, tx) =>
            {
                if (kind == "out" && scope.Limit("maxCashOut") is { } max && body.Amount > max)
                    await Approvals.RequireAsync(c, tx, http, scope, "cash_out", Money.Round(body.Amount), $"Your role can take out up to {max:N2}. A manager can approve more.", shiftId: id);
                var s = await c.QuerySingleOrDefaultAsync<ShiftRow>($"{ShiftSql} where s.id = @id and s.branch_id = @b", new { id, b = scope.Branch }, tx) ?? throw new NotFoundException("Shift not found.");
                if (s.Status != "open") throw new DomainException("This shift is closed.");
                if (s.UserId != scope.UserId && !(s.SharedDrawer && scope.Can("day.shift")) && !scope.Can("day.manage")) throw new ForbiddenException("Only the shift's own cashier or a manager can move its cash.");
                await c.ExecuteAsync("insert into cash_movement (company_id, shift_id, kind, amount, reason, by_user) values (@co, @id, @kind, @amount, @reason, @u)",
                    new { co = scope.CompanyId, id, kind, amount = Money.Round(body.Amount), reason = body.Reason.Trim(), u = scope.UserId }, tx);
                await Audit.RecordAsync(c, tx, scope.CompanyId, scope.Branch, scope.UserId, "shift", id.ToString(), $"cash_{kind}", $"Cash {kind}: {body.Amount:N2}", note: body.Reason.Trim());
                return 0;
            });
            await live.ToBranch(scope.Branch, "day.changed");
            return Results.Ok(new { id });
        });

        // X report while open, Z once closed. The cashier sees their own; managers any. A blind count hides "expected" until counted.
        api.MapGet("/shifts/{id:guid}/report", async (Guid id, HttpContext http, Db db) =>
        {
            var scope = await http.ScopeAsync(db);
            return await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var s = await c.QuerySingleOrDefaultAsync<ShiftRow>($"{ShiftSql} where s.id = @id and s.branch_id = @b", new { id, b = scope.Branch }, tx) ?? throw new NotFoundException("Shift not found.");
                if (s.UserId != scope.UserId && !(s.SharedDrawer && scope.Can("day.shift")) && !scope.Can("day.manage") && !scope.Can("reports.view")) throw new ForbiddenException("This is another cashier's shift.");
                return await ShiftReportAsync(c, tx, id);
            });
        });

        // Close a shift with a blind count (REQ DAY-05): the cashier counts without seeing what's expected.
        api.MapPost("/shifts/{id:guid}/close", async (Guid id, CloseShiftBody body, HttpContext http, Db db, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("day.shift");
            if (body.CountedCash < 0) throw new DomainException("The count can't be negative.");
            var report = await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var s = await c.QuerySingleOrDefaultAsync<ShiftRow>($"{ShiftSql} where s.id = @id and s.branch_id = @b for update of s", new { id, b = scope.Branch }, tx) ?? throw new NotFoundException("Shift not found.");
                if (s.Status != "open") throw new DomainException("This shift is already closed.");
                if (s.UserId != scope.UserId && !(s.SharedDrawer && scope.Can("day.shift")) && !scope.Can("day.manage")) throw new ForbiddenException("Only the shift's own cashier or a manager can close it.");
                var b = await BranchAsync(c, tx, scope.Branch);
                await CloseShiftAsync(c, tx, s, Money.Round(body.CountedCash), body.Counts?.GetRawText(), string.IsNullOrWhiteSpace(body.Note) ? null : body.Note.Trim(), scope.UserId, b.VarianceTolerance);
                return await ShiftReportAsync(c, tx, id);
            });
            await live.ToBranch(scope.Branch, "day.changed");
            return Results.Ok(report);
        });

        // A variance outside the tolerance is approved by a manager (on the till or remotely), with a note.
        api.MapPost("/shifts/{id:guid}/approve", async (Guid id, ApproveBody body, HttpContext http, Db db, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("day.manage");
            await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var s = await c.QuerySingleOrDefaultAsync<ShiftRow>($"{ShiftSql} where s.id = @id and s.branch_id = @b", new { id, b = scope.Branch }, tx) ?? throw new NotFoundException("Shift not found.");
                if (s.Status != "needs_approval") throw new DomainException("This shift doesn't need approval.");
                await c.ExecuteAsync("update shift set status = 'closed', approved_by = @u, approved_at = now(), note = coalesce(@note, note) where id = @id",
                    new { id, u = scope.UserId, note = string.IsNullOrWhiteSpace(body.Note) ? null : body.Note.Trim() }, tx);
                await Audit.RecordAsync(c, tx, scope.CompanyId, scope.Branch, scope.UserId, "shift", id.ToString(), "approved", $"Variance {s.Variance:+0.00;-0.00} of {s.UserName} approved", note: body.Note);
                return 0;
            });
            await live.ToBranch(scope.Branch, "day.changed");
            return Results.Ok(new { id });
        });

        // A bank deposit: a manager, or anyone allowed to record deposits (e.g. the cashier who takes the cash to the bank).
        api.MapPost("/day/deposits", async (DepositBody body, HttpContext http, Db db, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            if (!scope.Can("day.manage")) scope.Require("day.deposit");
            if (body.Amount <= 0) throw new DomainException("Enter the amount deposited.");
            if (string.IsNullOrWhiteSpace(body.TakenBy)) throw new DomainException("Who takes it to the bank?");
            await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var day = await c.QuerySingleOrDefaultAsync<DayRow>("select * from business_day where branch_id = @b order by date desc limit 1", new { b = scope.Branch }, tx)
                          ?? throw new DomainException("Open a business day first.");
                await c.ExecuteAsync("insert into bank_deposit (company_id, branch_id, business_day_id, amount, bag_no, taken_by, recorded_by) values (@co, @b, @d, @amount, @bag, @who, @u)",
                    new { co = scope.CompanyId, b = scope.Branch, d = day.Id, amount = Money.Round(body.Amount), bag = string.IsNullOrWhiteSpace(body.BagNo) ? null : body.BagNo.Trim(), who = body.TakenBy.Trim(), u = scope.UserId }, tx);
                await Audit.RecordAsync(c, tx, scope.CompanyId, scope.Branch, scope.UserId, "day", day.Id.ToString(), "deposit", $"Bank deposit {body.Amount:N2} taken by {body.TakenBy.Trim()}", note: body.BagNo);
                return 0;
            });
            await live.ToBranch(scope.Branch, "day.changed");
            return Results.Ok(new { ok = true });
        });
    }

    /// <summary>
    /// Automatic day control (REQ DAY-07): every minute, for branches set to Automatic, opens the day at the auto-open time and closes it
    /// at the auto-close time (a window that may run past midnight). Closing counts nothing: open shifts close as "not counted" and
    /// open orders follow the branch's rule. Runs as the owner (it spans every company).
    /// </summary>
    public sealed class AutoDay(IConfiguration config, ILogger<AutoDay> logger, Live live) : BackgroundService
    {
        protected override async Task ExecuteAsync(CancellationToken stop)
        {
            var owner = config.GetConnectionString("Owner");
            while (!stop.IsCancellationRequested)
            {
                try
                {
                    await using var c = new NpgsqlConnection(owner);
                    await c.OpenAsync(stop);
                    var branches = (await c.QueryAsync<Branch>("select * from branch where day_control = 'automatic' and is_active")).ToList();
                    foreach (var b in branches)
                    {
                        var closedAt = (string?)null;
                        await using var tx = await c.BeginTransactionAsync(stop);
                        var now = DateTime.UtcNow;
                        var local = TimeOnly.FromDateTime(TimeZoneInfo.ConvertTimeFromUtc(now, BusinessClock.Zone(b.TimeZone)));
                        var inWindow = Window(b, now).InWindow;
                        var counting = false;
                        var day = await c.QuerySingleOrDefaultAsync<DayRow>("select * from business_day where branch_id = @id and status = 'open' for update", new { b.Id }, tx);
                        var today = BusinessClock.Today(b.TimeZone);
                        if (day is null && inWindow && local >= b.AutoOpenTime
                            && !await c.ExecuteScalarAsync<bool>("select exists (select 1 from business_day where branch_id = @id and date >= @today)", new { b.Id, today }, tx))
                        {
                            await OpenDayAsync(c, tx, b, null);
                            logger.LogInformation("Opened the business day of branch {Branch}", b.Id);
                        }
                        else if (day is not null && now >= CloseDueUtc(b, day.OpenedAt) && !(day.DelayedUntil > now))
                        {
                            // Closing time (or the end of a delay): the tills count down a minute first, then it closes.
                            if (day.ClosingAt is null)
                            {
                                await c.ExecuteAsync("update business_day set closing_at = @at where id = @id", new { at = now + Countdown, id = day.Id }, tx);
                                counting = true;
                            }
                            else if (now >= day.ClosingAt)
                            {
                                await CloseDayAsync(c, tx, b, day, null, automatic: true);
                                closedAt = TimeZoneInfo.ConvertTimeFromUtc(now, BusinessClock.Zone(b.TimeZone)).ToString("HH:mm");
                                logger.LogInformation("Closed the business day of branch {Branch}", b.Id);
                            }
                        }
                        await tx.CommitAsync(stop);
                        if (counting) await live.ToBranch(b.Id, "day.changed");
                        // Closed by itself: every till of the branch locks back to its PIN pad, so nobody stays signed in overnight.
                        if (closedAt is not null)
                        {
                            await live.ToBranch(b.Id, "day.changed");
                            await live.ToBranch(b.Id, "floor.changed");
                            await live.ToBranch(b.Id, "day.autoclosed", new { at = closedAt });
                        }
                    }
                }
                catch (Exception ex) when (ex is not OperationCanceledException) { logger.LogWarning(ex, "Automatic day control failed"); }
                // Often enough for the one-minute countdown to end on time.
                await Task.Delay(TimeSpan.FromSeconds(10), stop).ContinueWith(_ => { });
            }
        }
    }
}
