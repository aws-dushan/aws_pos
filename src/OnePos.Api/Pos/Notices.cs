using System.Net;
using System.Net.Mail;
using System.Text;
using System.Text.Json;
using Dapper;
using Microsoft.AspNetCore.DataProtection;
using Npgsql;
using OnePos.Api.Data;
using OnePos.Api.Platform;

namespace OnePos.Api.Pos;

/// <summary>
/// Daily summary and exception alerts (REQ DAY-10), always made. When a branch's day closes: a summary,
/// and alerts where a figure is over the company's limits (cash variance, voids, refunds, no-sales, discounts) or a shift wasn't
/// counted. Shown under the bell to people with reports for the branch; emailed to the company's list where email is set up.
/// </summary>
public static class Notices
{
    public sealed record AlertSettings(bool EmailEnabled, string[] Emails, decimal? VoidsOver, decimal? RefundsOver, int? NoSalesOver,
        decimal? DiscountPctOver, bool VarianceAlerts, bool NotCountedAlerts,
        // Approval reminders (see ApprovalReminders): waiting longer than ReminderHours, emailed to the approver within the sending hours.
        bool ApprovalReminders = true, int ReminderHours = 12, string ReminderFrom = "08:00", string ReminderUntil = "22:00");
    public sealed record SmtpBody(string Host, int Port, bool Ssl, string? User, string? Password, string From, string? FromName = null);
    public sealed record TestBody(string To);
    public sealed record ReadBody(Guid[]? Ids);
    public sealed record Line(string Label, string Value, bool Warn = false);

    private static readonly JsonSerializerOptions Web = new(JsonSerializerDefaults.Web);

    public static AlertSettings Read(string? json)
    {
        var d = new AlertSettings(false, [], 200, 300, 3, 10, true, true);
        if (string.IsNullOrWhiteSpace(json) || json == "{}") return d;
        try { return JsonSerializer.Deserialize<AlertSettings>(json, Web) is { } s ? s with { Emails = s.Emails ?? [] } : d; }
        catch (JsonException) { return d; }
    }

    public sealed class NoticeRow
    {
        public Guid Id { get; set; }
        public Guid BranchId { get; set; }
        public string BranchCode { get; set; } = "";
        public string BranchName { get; set; } = "";
        public DateOnly BusinessDate { get; set; }
        public string Kind { get; set; } = "";
        public string Title { get; set; } = "";
        public string Lines { get; set; } = "[]";
        public string EmailStatus { get; set; } = "";
        public DateTime CreatedAt { get; set; }
        public bool IsRead { get; set; }
    }

    /// <summary>After a day closes (same transaction): its summary and any alerts, where the company has them switched on.</summary>
    public static async Task OnDayClosedAsync(NpgsqlConnection c, NpgsqlTransaction tx, Guid companyId, Guid branchId, DateOnly day, decimal tolerance)
    {
        var co = await c.QuerySingleAsync<(string Settings, string Currency, bool Smtp)>(
            "select alert_settings::text, base_currency, smtp_settings is not null from company where id = @companyId", new { companyId }, tx);
        var s = Read(co.Settings);
        var cur = co.Currency;
        var a = new { b = branchId, d = day, prev = day.AddDays(-7) };
        var sales = await c.QuerySingleAsync<(int Orders, decimal Gross, decimal Discounts, decimal Subtotal)>("""
            select count(*)::int, coalesce(sum(total), 0), coalesce(sum(discount_total), 0), coalesce(sum(subtotal), 0)
            from pos_order where branch_id = @b and business_date = @d and status in ('paid','refunded')
            """, a, tx);
        var refunds = await c.QuerySingleAsync<(int Count, decimal Total)>("select count(*)::int, coalesce(sum(total), 0) from credit_note where branch_id = @b and business_date = @d", a, tx);
        var net = sales.Gross - refunds.Total;
        var lastWeek = await c.ExecuteScalarAsync<decimal>("""
            select coalesce(sum(total - refunded), 0) from pos_order where branch_id = @b and business_date = @prev and status in ('paid','refunded')
            """, a, tx);
        var voids = await c.QuerySingleAsync<(int Count, decimal Value)>("select count(*)::int, coalesce(sum(total), 0) from pos_order where branch_id = @b and business_date = @d and status = 'void' and number is not null", a, tx);
        var noSales = await c.ExecuteScalarAsync<int>("select count(*)::int from no_sale where branch_id = @b and business_date = @d", a, tx);
        var waste = await c.ExecuteScalarAsync<decimal>("select coalesce(sum(cost_value), 0) from wastage where branch_id = @b and business_date = @d and voided_at is null and kind = 'wastage'", a, tx);
        var given = await c.ExecuteScalarAsync<decimal>("select coalesce(sum(cost_value), 0) from wastage where branch_id = @b and business_date = @d and voided_at is null and kind = 'marketing'", a, tx);
        var shifts = (await c.QueryAsync<(string Register, string User, string Status, decimal? Variance)>("""
            select r.name, u.display_name, s.status, s.variance from shift s join business_day bd on bd.id = s.business_day_id
            join register r on r.id = s.register_id join app_user u on u.id = s.user_id where bd.branch_id = @b and bd.date = @d
            """, a, tx)).ToList();
        var variance = shifts.Sum(x => x.Variance ?? 0);
        var top = (await c.QueryAsync<(string Name, decimal Qty)>("""
            select l.name, sum(l.qty - l.returned_qty) from order_line l join pos_order o on o.id = l.order_id
            where o.branch_id = @b and o.business_date = @d and o.status in ('paid','refunded') and not l.is_void
            group by l.name order by 2 desc limit 3
            """, a, tx)).ToList();
        string M(decimal v) => $"{cur} {v:N2}";
        var discountPct = sales.Subtotal > 0 ? decimal.Round(sales.Discounts / sales.Subtotal * 100, 1, MidpointRounding.AwayFromZero) : 0;
        var change = lastWeek > 0 ? decimal.Round((net - lastWeek) / lastWeek * 100, 0, MidpointRounding.AwayFromZero) : (decimal?)null;

        var summary = new List<Line>
        {
            new("Net sales", $"{M(net)}{(change is { } ch ? $" ({(ch >= 0 ? "+" : "")}{ch}% on last week)" : "")}"),
            new("Orders", $"{sales.Orders}{(sales.Orders > 0 ? $" · average {M(Money.Round(net / sales.Orders))}" : "")}"),
            new("Cash variance", M(variance), Math.Abs(variance) > tolerance),
            new("Discounts", $"{M(sales.Discounts)} ({discountPct}%)", s.DiscountPctOver is { } dp && discountPct > dp),
            new("Refunds", $"{refunds.Count} · {M(refunds.Total)}", s.RefundsOver is { } ro && refunds.Total > ro),
            new("Voided orders", $"{voids.Count} · {M(voids.Value)}", s.VoidsOver is { } vo && voids.Value > vo),
            new("No-sales", noSales.ToString(), s.NoSalesOver is { } ns && noSales > ns),
        };
        if (waste > 0) summary.Add(new("Wastage", M(waste)));
        if (given > 0) summary.Add(new("Marketing (given away)", M(given)));
        if (top.Count > 0) summary.Add(new("Best sellers", string.Join(", ", top.Select(t => $"{t.Name} ×{t.Qty:0.###}"))));

        // The day's cash, till by till (as the day's Z report, Days.DayCashAsync): what the drawers should hold against what was
        // counted, each cash in / cash out (by reason), safe drops, and the bank deposits (from a drawer or from the safe).
        var dayId = await c.ExecuteScalarAsync<Guid>("select id from business_day where branch_id = @b and date = @d", a, tx);
        var cash = await Days.DayCashAsync(c, tx, dayId);
        summary.Add(new("Cash expected in drawers", $"{M(cash.Expected)} (opening float {M(cash.OpeningFloat)} + cash sales {M(cash.CashSales)}{(cash.CashRefunds > 0 ? $" − refunds {M(cash.CashRefunds)}" : "")})"));
        if (cash.ShiftChange != 0)
            summary.Add(new(cash.ShiftChange > 0 ? "Taken out at shift changes" : "Put in at shift changes", M(Math.Abs(cash.ShiftChange))));
        summary.Add(new("Cash counted", $"{M(cash.Counted)}{(cash.Uncounted > 0 ? $" ({cash.Uncounted} till{(cash.Uncounted == 1 ? "" : "s")} not counted)" : "")}", cash.Uncounted > 0));
        var moves = await c.QueryAsync<(string Kind, string Reason, decimal Amount, int Count)>("""
            select m.kind, m.reason, sum(m.amount), count(*)::int from cash_movement m join shift x on x.id = m.shift_id join business_day bd on bd.id = x.business_day_id
            where bd.branch_id = @b and bd.date = @d and m.kind in ('in', 'out', 'drop') group by m.kind, m.reason order by m.kind, 3 desc
            """, a, tx);
        foreach (var m in moves)
            summary.Add(new($"{(m.Kind == "in" ? "Cash in" : m.Kind == "out" ? "Cash out" : "Safe drop")} · {m.Reason}", $"{(m.Kind == "in" ? "" : "−")}{M(m.Amount)}{(m.Count > 1 ? $" ({m.Count}×)" : "")}"));
        var deposits = await c.QueryAsync<(decimal Amount, string? BagNo, string TakenBy, string? Register)>("""
            select d.amount, d.bag_no, d.taken_by, r.name from bank_deposit d join business_day bd on bd.id = d.business_day_id
            left join shift s on s.id = d.shift_id left join register r on r.id = s.register_id
            where bd.branch_id = @b and bd.date = @d order by d.at
            """, a, tx);
        foreach (var x in deposits)
            summary.Add(new($"Bank deposit · {(x.Register is null ? "from safe" : $"from drawer ({x.Register})")}", $"{M(x.Amount)} · {(x.BagNo is null ? "" : $"bag {x.BagNo} · ")}{x.TakenBy}"));
        if (!deposits.Any()) summary.Add(new("Bank deposits", "none recorded"));

        var alerts = new List<Line>();
        // One line per shift while there are a few; many become one line (the tills named), so the alert stays readable.
        string Tills(IEnumerable<(string Register, string User, string Status, decimal? Variance)> xs) =>
            string.Join(", ", xs.Select(x => x.Register).Distinct().Take(4)) + (xs.Select(x => x.Register).Distinct().Count() > 4 ? "…" : "");
        if (s.VarianceAlerts)
        {
            var off = shifts.Where(x => x.Variance is { } v && Math.Abs(v) > tolerance).ToList();
            if (off.Count <= 5) foreach (var x in off) alerts.Add(new($"Cash variance · {x.Register} · {x.User}", M(x.Variance!.Value), true));
            else alerts.Add(new($"Cash variance on {off.Count} shifts · {Tills(off)}", M(off.Sum(x => x.Variance!.Value)), true));
        }
        if (s.NotCountedAlerts)
        {
            var nc = shifts.Where(x => x.Status == "not_counted").ToList();
            if (nc.Count is > 0 and <= 3) foreach (var x in nc) alerts.Add(new($"Shift not counted · {x.Register}", x.User, true));
            else if (nc.Count > 3) alerts.Add(new($"{nc.Count} shifts not counted", Tills(nc), true));
        }
        var delay = await c.QuerySingleOrDefaultAsync<(int Minutes, string? By)>("""
            select d.delayed_minutes, (select string_agg(distinct u.display_name, ', ') from audit_log l join app_user u on u.id = l.user_id
                                       where l.entity = 'day' and l.entity_id = d.id::text and l.action = 'close_delayed')
            from business_day d where d.branch_id = @b and d.date = @d
            """, a, tx);
        if (delay.Minutes > 0) alerts.Add(new("Closing delayed (customers waiting)", $"{delay.Minutes} min · by {delay.By}", false));
        if (s.VoidsOver is { } vLimit && voids.Value > vLimit) alerts.Add(new("Voided orders over the limit", $"{M(voids.Value)} (limit {M(vLimit)})", true));
        if (s.RefundsOver is { } rLimit && refunds.Total > rLimit) alerts.Add(new("Refunds over the limit", $"{M(refunds.Total)} (limit {M(rLimit)})", true));
        if (s.NoSalesOver is { } nLimit && noSales > nLimit) alerts.Add(new("No-sales over the limit", $"{noSales} (limit {nLimit})", true));
        if (s.DiscountPctOver is { } dLimit && discountPct > dLimit) alerts.Add(new("Discounts over the limit", $"{discountPct}% of sales (limit {dLimit}%)", true));

        var email = s.EmailEnabled && co.Smtp && s.Emails.Length > 0 ? "pending" : "none";
        async Task AddAsync(string kind, string title, List<Line> lines) =>
            await c.ExecuteAsync("""
                insert into notice (company_id, branch_id, business_date, kind, title, lines, email_status)
                values (@companyId, @branchId, @day, @kind, @title, cast(@lines as jsonb), @email)
                """, new { companyId, branchId, day, kind, title, lines = JsonSerializer.Serialize(lines, Web), email }, tx);
        await AddAsync("summary", $"Day summary · {day:ddd d MMM}", summary);
        if (alerts.Count > 0) await AddAsync("alert", $"{alerts.Count} alert{(alerts.Count == 1 ? "" : "s")} · {day:ddd d MMM}", alerts);
    }

    public static void Map(RouteGroupBuilder api)
    {
        // The bell: this company's notices for the branches this person has reports for (newest first), read or not.
        api.MapGet("/notices", async (HttpContext http, Db db, int? take) =>
        {
            var scope = await http.ScopeAsync(db);
            if (!scope.Can("reports.view")) scope.Require("day.manage");
            return await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var rows = (await c.QueryAsync<NoticeRow>("""
                    select n.id, n.branch_id, b.code as branch_code, b.name as branch_name, n.business_date, n.kind, n.title, n.lines::text as lines, n.email_status, n.created_at,
                           exists (select 1 from notice_read r where r.notice_id = n.id and r.user_id = @u) as is_read
                    from notice n join branch b on b.id = n.branch_id
                    where @admin or exists (select 1 from user_branch ub where ub.branch_id = n.branch_id and ub.user_id = @u)
                    order by n.created_at desc limit @take
                    """, new { u = scope.UserId, admin = scope.IsAdmin, take = Math.Clamp(take ?? 30, 1, 200) }, tx)).ToList();
                return new
                {
                    unread = rows.Count(r => !r.IsRead),
                    items = rows.Select(r => new { r.Id, r.BranchId, r.BranchCode, r.BranchName, r.BusinessDate, r.Kind, r.Title, lines = JsonDocument.Parse(r.Lines).RootElement, r.EmailStatus, r.CreatedAt, r.IsRead }),
                };
            });
        });

        api.MapPost("/notices/read", async (ReadBody body, HttpContext http, Db db, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            await db.Company(scope.CompanyId, (c, tx) => c.ExecuteAsync("""
                insert into notice_read (company_id, notice_id, user_id)
                select @co, n.id, @u from notice n where (@all or n.id = any(@ids)) on conflict do nothing
                """, new { co = scope.CompanyId, u = scope.UserId, all = body.Ids is null, ids = body.Ids ?? [] }, tx));
            return Results.Ok(new { ok = true });
        });

        api.MapGet("/notices/settings", async (HttpContext http, Db db) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("branch.manage");
            return await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var r = await c.QuerySingleAsync<(string Settings, string? Smtp)>("select alert_settings::text, smtp_settings::text from company where id = @id", new { id = scope.CompanyId }, tx);
                JsonElement? smtp = r.Smtp is null ? null : JsonSerializer.Deserialize<JsonElement>(r.Smtp);
                return new
                {
                    settings = Read(r.Settings),
                    smtp = smtp is { } j ? new { host = j.GetProperty("host").GetString(), port = j.GetProperty("port").GetInt32(), ssl = j.GetProperty("ssl").GetBoolean(),
                                                 user = j.TryGetProperty("user", out var u) ? u.GetString() : null, from = j.GetProperty("from").GetString(),
                                                 fromName = j.TryGetProperty("fromName", out var fn) ? fn.GetString() : null, hasPassword = j.TryGetProperty("password", out var p) && p.GetString() is not null } : null,
                };
            });
        });

        api.MapPut("/notices/settings", async (AlertSettings body, HttpContext http, Db db) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("branch.manage");
            var emails = (body.Emails ?? []).Select(e => e.Trim()).Where(e => e.Length > 0).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
            if (emails.Length > 20) throw new DomainException("Up to 20 email addresses.");
            foreach (var e in emails) if (!MailAddress.TryCreate(e, out _)) throw new DomainException($"\"{e}\" isn't an email address.");
            if (body.VoidsOver is < 0 || body.RefundsOver is < 0 || body.NoSalesOver is < 0 || body.DiscountPctOver is < 0 or > 100)
                throw new DomainException("Limits can't be negative (discounts: 0 to 100 %).");
            if (body.ReminderHours is < 1 or > 72) throw new DomainException("Remind after 1 to 72 hours.");
            if (!TimeOnly.TryParseExact(body.ReminderFrom, "HH:mm", out var rf) || !TimeOnly.TryParseExact(body.ReminderUntil, "HH:mm", out var ru) || rf >= ru)
                throw new DomainException("Sending hours: a start before the end, e.g. 08:00 to 22:00.");
            var s = body with { Emails = emails };
            await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var old = Read(await c.ExecuteScalarAsync<string>("select alert_settings::text from company where id = @id", new { id = scope.CompanyId }, tx));
                await c.ExecuteAsync("update company set alert_settings = cast(@json as jsonb) where id = @id", new { id = scope.CompanyId, json = JsonSerializer.Serialize(s, Web) }, tx);
                await Audit.RecordAsync(c, tx, scope.CompanyId, null, scope.UserId, "company", scope.CompanyId.ToString(), "alerts", "Daily summary and alerts changed",
                    [new("Email", old.EmailEnabled, s.EmailEnabled), new("Emails", string.Join(", ", old.Emails), string.Join(", ", s.Emails)),
                     new("Voids over", old.VoidsOver, s.VoidsOver), new("Refunds over", old.RefundsOver, s.RefundsOver), new("No-sales over", old.NoSalesOver, s.NoSalesOver),
                     new("Discounts over %", old.DiscountPctOver, s.DiscountPctOver), new("Approval reminders", old.ApprovalReminders, s.ApprovalReminders),
                     new("Remind after hours", old.ReminderHours, s.ReminderHours), new("Sending hours", $"{old.ReminderFrom}-{old.ReminderUntil}", $"{s.ReminderFrom}-{s.ReminderUntil}")]);
                return 0;
            });
            return Results.Ok(s);
        });

        // Email (SMTP) for the company: administrators only; the password is kept protected and never sent back.
        api.MapPut("/notices/smtp", async (SmtpBody body, HttpContext http, Db db, IDataProtectionProvider dp) =>
        {
            var scope = await http.ScopeAsync(db);
            if (!scope.IsAdmin) throw new ForbiddenException("Only administrators set up email.");
            if (string.IsNullOrWhiteSpace(body.Host) || body.Port is < 1 or > 65535) throw new DomainException("Enter the mail server and its port.");
            if (!MailAddress.TryCreate(body.From?.Trim(), out _)) throw new DomainException("Enter the address emails come from.");
            var protector = dp.CreateProtector("OnePos.Smtp.Password.v1");
            await db.Company(scope.CompanyId, async (c, tx) =>
            {
                string? keep = null;
                if (body.Password is null)
                {
                    var old = await c.ExecuteScalarAsync<string?>("select smtp_settings::text from company where id = @id", new { id = scope.CompanyId }, tx);
                    if (old is not null && JsonSerializer.Deserialize<JsonElement>(old).TryGetProperty("password", out var p)) keep = p.GetString();
                }
                var json = JsonSerializer.Serialize(new
                {
                    host = body.Host.Trim(), port = body.Port, ssl = body.Ssl, user = string.IsNullOrWhiteSpace(body.User) ? null : body.User.Trim(), from = body.From.Trim(),
                    fromName = string.IsNullOrWhiteSpace(body.FromName) ? null : body.FromName.Trim(),
                    password = body.Password is null ? keep : body.Password.Length == 0 ? null : protector.Protect(body.Password),
                }, Web);
                await c.ExecuteAsync("update company set smtp_settings = cast(@json as jsonb) where id = @id", new { id = scope.CompanyId, json }, tx);
                await Audit.RecordAsync(c, tx, scope.CompanyId, null, scope.UserId, "company", scope.CompanyId.ToString(), "smtp", $"Email server set to {body.Host.Trim()}:{body.Port}");
                return 0;
            });
            return Results.Ok(new { ok = true });
        });

        api.MapDelete("/notices/smtp", async (HttpContext http, Db db) =>
        {
            var scope = await http.ScopeAsync(db);
            if (!scope.IsAdmin) throw new ForbiddenException("Only administrators set up email.");
            await db.Company(scope.CompanyId, (c, tx) => c.ExecuteAsync("update company set smtp_settings = null where id = @id", new { id = scope.CompanyId }, tx));
            return Results.Ok(new { ok = true });
        });

        api.MapPost("/notices/smtp/test", async (TestBody body, HttpContext http, Db db, IDataProtectionProvider dp) =>
        {
            var scope = await http.ScopeAsync(db);
            if (!scope.IsAdmin) throw new ForbiddenException("Only administrators set up email.");
            if (!MailAddress.TryCreate(body.To?.Trim(), out var to)) throw new DomainException("Enter an email address to send the test to.");
            var smtp = await db.Company(scope.CompanyId, (c, tx) => c.ExecuteScalarAsync<string?>("select smtp_settings::text from company where id = @id", new { id = scope.CompanyId }, tx))
                       ?? throw new DomainException("Set up the email server first.");
            try
            {
                await Mailer.SendAsync(smtp, dp, [to.Address], "One POS test email", "<p>Email from One POS works. Daily summaries and alerts will arrive like this.</p>");
            }
            catch (Exception e) when (e is SmtpException or InvalidOperationException or System.Security.Cryptography.CryptographicException)
            {
                throw new DomainException($"The mail server said: {e.Message}");
            }
            return Results.Ok(new { ok = true });
        });
    }

    /// <summary>Sends email through the company's mail server.</summary>
    public static class Mailer
    {
        public static async Task SendAsync(string smtpJson, IDataProtectionProvider dp, string[] to, string subject, string html)
        {
            var j = JsonSerializer.Deserialize<JsonElement>(smtpJson);
            using var client = new SmtpClient(j.GetProperty("host").GetString(), j.GetProperty("port").GetInt32())
            {
                EnableSsl = j.GetProperty("ssl").GetBoolean(), DeliveryMethod = SmtpDeliveryMethod.Network, Timeout = 20_000,
            };
            var user = j.TryGetProperty("user", out var u) ? u.GetString() : null;
            var pw = j.TryGetProperty("password", out var p) ? p.GetString() : null;
            if (user is not null)
                client.Credentials = new NetworkCredential(user, pw is null ? "" : dp.CreateProtector("OnePos.Smtp.Password.v1").Unprotect(pw));
            // The sender's name as people see it (e.g. "European Bakery POS"); "One POS" when none is set.
            var name = j.TryGetProperty("fromName", out var fn) && fn.GetString() is { Length: > 0 } n ? n : "One POS";
            using var msg = new MailMessage { From = new MailAddress(j.GetProperty("from").GetString()!, name), Subject = subject, Body = html, IsBodyHtml = true };
            foreach (var t in to) msg.To.Add(t);
            await client.SendMailAsync(msg);
        }
    }

    /// <summary>
    /// The bell, live: listens for the database's signal on every new notice (0089) and tells that company's open screens to re-read
    /// it ("notices.changed"), whichever part of One POS made the notice. A lost connection is opened again after a few seconds.
    /// </summary>
    public sealed class Listener(IConfiguration config, Live live, ILogger<Listener> logger) : BackgroundService
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
                    c.Notification += (_, e) =>
                    {
                        var parts = e.Payload.Split(':');
                        if (parts.Length == 2 && Guid.TryParse(parts[0], out var companyId) && Guid.TryParse(parts[1], out var branchId))
                            _ = live.ToCompany(companyId, "notices.changed", new { branchId });
                    };
                    await c.ExecuteAsync("listen onepos_notice");
                    while (!stop.IsCancellationRequested) await c.WaitAsync(stop);
                }
                catch (Exception ex) when (ex is not OperationCanceledException) { logger.LogWarning(ex, "Notice listener lost its connection"); }
                await Task.Delay(TimeSpan.FromSeconds(5), stop).ContinueWith(_ => { });
            }
        }
    }

    /// <summary>Every minute: notices waiting to be emailed go out (a failure is kept on the notice and not retried).</summary>
    public sealed class Sender(Db db, IDataProtectionProvider dp, IConfiguration config, ILogger<Sender> logger) : BackgroundService
    {
        private static readonly SemaphoreSlim Signal = new(0, 1);

        /// <summary>Send now instead of at the next minute (an approval request: someone is waiting at the till).</summary>
        public static void Wake() { try { Signal.Release(); } catch (SemaphoreFullException) { } }

        protected override async Task ExecuteAsync(CancellationToken stop)
        {
            while (!stop.IsCancellationRequested)
            {
                try { await SendPendingAsync(); }
                catch (Exception e) when (e is not OperationCanceledException) { logger.LogWarning(e, "Sending notices failed"); }
                try { await Signal.WaitAsync(TimeSpan.FromMinutes(1), stop); } catch (OperationCanceledException) { break; }
            }
        }

        private async Task SendPendingAsync()
        {
            var companies = await db.Platform((c, tx) => c.QueryAsync<(Guid Id, string Smtp, string Settings, string Name)>(
                "select id, smtp_settings::text, alert_settings::text, name from company where smtp_settings is not null", transaction: tx));
            foreach (var co in companies)
            {
                var s = Read(co.Settings);
                var pending = await db.Company(co.Id, (c, tx) => c.QueryAsync<(Guid Id, string Title, string Lines, string Branch, string[]? To, string? Link, Guid? ApprovalId)>("""
                    select n.id, n.title, n.lines::text, b.name, n.email_to, n.link, n.approval_id from notice n join branch b on b.id = n.branch_id where n.email_status = 'pending' order by n.created_at limit 20
                    """, transaction: tx));
                // The web app's address (PublicUrl, e.g. https://…/onepos): a notice with a page gets a button to it.
                var web = config["PublicUrl"]?.TrimEnd('/');
                foreach (var n in pending)
                {
                    string status = "sent", error = "";
                    try
                    {
                        var lines = JsonSerializer.Deserialize<Line[]>(n.Lines, Web) ?? [];
                        var html = new StringBuilder($"<h2 style=\"font-family:sans-serif\">{WebUtility.HtmlEncode(co.Name)} · {WebUtility.HtmlEncode(n.Branch)}</h2><p style=\"font-family:sans-serif\">{WebUtility.HtmlEncode(n.Title)}</p><table style=\"font-family:sans-serif;border-collapse:collapse\">");
                        foreach (var l in lines)
                            html.Append($"<tr><td style=\"padding:4px 12px 4px 0;color:#555\">{WebUtility.HtmlEncode(l.Label)}</td><td style=\"padding:4px 0;{(l.Warn ? "color:#c0262d;font-weight:600" : "")}\">{WebUtility.HtmlEncode(l.Value)}</td></tr>");
                        html.Append("</table>");
                        if (n.Link is not null && !string.IsNullOrEmpty(web))
                            html.Append($"<p style=\"margin:20px 0\"><a href=\"{WebUtility.HtmlEncode(web + n.Link)}\" style=\"font-family:sans-serif;background:#3b3fd8;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none\">Open in One POS</a></p>");
                        const string footer = "<p style=\"font-family:sans-serif;color:#888;font-size:12px\">One POS by AWS Distribution</p>";
                        if (n.ApprovalId is { } approvalId)
                        {
                            // A discount request: one email per address, each with its own code (then only the code's hash is kept).
                            var codes = await db.Company(co.Id, (c, tx) => c.QueryAsync<(Guid Id, string Email, string Code)>(
                                "select id, email, code from approval_code where approval_id = @approvalId and code is not null", new { approvalId }, tx));
                            foreach (var k in codes)
                            {
                                var body = html.ToString() + "<p style=\"font-family:sans-serif;margin:16px 0 4px\">Or give the cashier this code:</p>"
                                    + $"<p style=\"font-family:monospace;font-size:28px;font-weight:700;letter-spacing:6px;margin:0\">{k.Code}</p>"
                                    + "<p style=\"font-family:sans-serif;color:#555;font-size:13px\">Typed at the till, it approves this discount on this order only, once, within 24 hours. It's yours: the record shows it was your code.</p>"
                                    + footer;
                                await Mailer.SendAsync(co.Smtp, dp, [k.Email], $"{n.Branch}: {n.Title}", body);
                                await db.Company(co.Id, (c, tx) => c.ExecuteAsync("update approval_code set code = null, sent_at = now() where id = @Id", new { k.Id }, tx));
                            }
                        }
                        else
                        {
                            html.Append(footer);
                            // Its own addresses (a wastage request to the branch's approver), else the company's alert list.
                            var to = n.To is { Length: > 0 } ? n.To : s.Emails;
                            if (to.Length > 0) await Mailer.SendAsync(co.Smtp, dp, to, $"{n.Branch}: {n.Title}", html.ToString());
                        }
                    }
                    catch (Exception e) when (e is SmtpException or InvalidOperationException or FormatException or System.Security.Cryptography.CryptographicException)
                    {
                        status = "failed"; error = e.Message;
                        logger.LogWarning("Emailing notice {Notice} failed: {Error}", n.Id, e.Message);
                    }
                    await db.Company(co.Id, (c, tx) => c.ExecuteAsync("update notice set email_status = @status, email_error = nullif(@error, '') where id = @id", new { status, error, id = n.Id }, tx));
                }
            }
        }
    }
}
