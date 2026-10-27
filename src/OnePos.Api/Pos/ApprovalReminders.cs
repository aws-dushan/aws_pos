using System.Globalization;
using System.Text.Json;
using Dapper;
using Npgsql;
using OnePos.Api.Platform;

namespace OnePos.Api.Pos;

/// <summary>
/// Approval reminders. Every quarter of an hour: wastage, marketing give-aways, returns and stock requests waiting for their approver
/// longer than the company's hours (alert settings, default 12) go to that approver in ONE email (and under the bell), at most once
/// in those hours per approver, and only within the sending hours (default 08:00 to 22:00, the branch's time). A reminder falling due
/// at night waits for the morning. It repeats until each is approved, rejected or cancelled.
/// </summary>
public sealed class ApprovalReminders(IConfiguration config, ILogger<ApprovalReminders> logger) : BackgroundService
{
    private static readonly JsonSerializerOptions Web = new(JsonSerializerDefaults.Web);
    private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

    private sealed class Waiting
    {
        public string Kind { get; set; } = "";
        public Guid Id { get; set; }
        public Guid BranchId { get; set; }
        public string BranchName { get; set; } = "";
        public string TimeZone { get; set; } = "";
        public Guid? ApproverId { get; set; }
        public string? Email { get; set; }
        public string What { get; set; } = "";
        public DateTime RecordedAt { get; set; }
    }

    protected override async Task ExecuteAsync(CancellationToken stop)
    {
        // Runs as the owner role: it spans every company (RLS would hide them from the app role).
        var owner = config.GetConnectionString("Owner");
        await Task.Delay(TimeSpan.FromMinutes(2), stop).ContinueWith(_ => { });
        while (!stop.IsCancellationRequested)
        {
            try
            {
                await using var c = new NpgsqlConnection(owner);
                await c.OpenAsync(stop);
                foreach (var (companyId, settings, smtp) in await c.QueryAsync<(Guid, string?, bool)>("select id, alert_settings::text, smtp_settings is not null from company where is_active"))
                {
                    var s = Notices.Read(settings);
                    if (!s.ApprovalReminders) continue;
                    var n = await RemindAsync(c, companyId, s, smtp);
                    if (n > 0) logger.LogInformation("Approval reminders: {Count} sent for company {Company}", n, companyId);
                }
            }
            catch (Exception ex) when (ex is not OperationCanceledException) { logger.LogWarning(ex, "Approval reminders failed"); }
            await Task.Delay(TimeSpan.FromMinutes(15), stop).ContinueWith(_ => { });
        }
    }

    private static async Task<int> RemindAsync(NpgsqlConnection c, Guid companyId, Notices.AlertSettings s, bool smtp)
    {
        var hours = Math.Clamp(s.ReminderHours, 1, 72);
        var (from, until) = (TimeOnly.Parse(s.ReminderFrom, Inv), TimeOnly.Parse(s.ReminderUntil, Inv));
        await using var tx = await c.BeginTransactionAsync();
        // Everything waiting longer than the hours, with its branch's approver for that kind and the email requests go to.
        var waiting = (await c.QueryAsync<Waiting>("""
            select case w.kind when 'marketing' then 'Marketing' else 'Wastage' end as kind, w.id, b.id as branch_id, b.name as branch_name, b.time_zone,
                   case w.kind when 'marketing' then b.marketing_approver_id else b.wastage_approver_id end as approver_id,
                   case w.kind when 'marketing' then b.marketing_approval_email else b.wastage_approval_email end as email,
                   trim(to_char(w.qty, 'FM999999990.###')) || ' ' || coalesce(w.unit, '') || ' ' || w.name || ' · ' || initcap(w.reason) || ' · ' || u.display_name as what, w.recorded_at
            from wastage w join branch b on b.id = w.branch_id join app_user u on u.id = w.recorded_by
            where w.company_id = @companyId and w.approval = 'waiting' and w.voided_at is null and w.recorded_at < now() - make_interval(hours => @hours)
            union all
            select 'Return', r.id, b.id, b.name, b.time_zone, b.wastage_approver_id, b.wastage_approval_email,
                   trim(to_char(r.qty, 'FM999999990.###')) || ' ' || coalesce(r.unit, '') || ' ' || r.item_name || ' back to ' || r.to_location || ' · ' || u.display_name, r.recorded_at
            from stock_return r join branch b on b.id = r.branch_id join app_user u on u.id = r.recorded_by
            where r.company_id = @companyId and r.approval = 'waiting' and r.recorded_at < now() - make_interval(hours => @hours)
            union all
            select 'Stock request', q.id, b.id, b.name, b.time_zone, b.request_approver_id, b.request_approval_email,
                   'REQ-' || q.number || ' · ' || (select count(*) from stock_request_line l where l.request_id = q.id) || ' items from ' || q.store_name || ' (' || q.store_code || ')'
                     || coalesce(' · needed by ' || to_char(q.needed_by, 'DD Mon'), '') || ' · ' || u.display_name, q.requested_at
            from stock_request q join branch b on b.id = q.branch_id join app_user u on u.id = q.requested_by
            where q.company_id = @companyId and q.approval = 'waiting' and q.requested_at < now() - make_interval(hours => @hours)
            """, new { companyId, hours }, tx)).ToList();
        // Only branches within the sending hours now (their own time); the rest wait for their morning.
        bool InHours(string tz) { var t = TimeOnly.FromDateTime(TimeZoneInfo.ConvertTimeFromUtc(DateTime.UtcNow, Zone(tz))); return t >= from && t < until; }
        var sent = 0;
        foreach (var g in waiting.Where(w => w.ApproverId is not null && InHours(w.TimeZone)).GroupBy(w => w.ApproverId!.Value))
        {
            var last = await c.ExecuteScalarAsync<DateTime?>("select sent_at from approval_reminder where company_id = @companyId and user_id = @u", new { companyId, u = g.Key }, tx);
            if (last is { } l && l > DateTime.UtcNow.AddHours(-hours)) continue;
            var items = g.OrderBy(w => w.BranchName).ThenBy(w => w.RecordedAt).ToList();
            var lines = new List<Notices.Line>();
            foreach (var b in items.GroupBy(w => w.BranchName))
            {
                lines.Add(new("Branch", b.Key));
                lines.AddRange(b.Select(w => new Notices.Line(w.Kind, $"{w.What.Replace("  ", " ")} · waiting {(int)(DateTime.UtcNow - w.RecordedAt.ToUniversalTime()).TotalHours} h", true)));
            }
            var emailTo = items.Select(w => w.Email).Where(e => !string.IsNullOrWhiteSpace(e)).Select(e => e!.Trim()).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
            var first = items[0];
            await c.ExecuteAsync("""
                insert into notice (company_id, branch_id, business_date, kind, title, lines, email_status, email_to, link)
                values (@companyId, @b, @day, 'reminder', @title, cast(@lines as jsonb), @email, @emailTo, '/approvals')
                """, new
                {
                    companyId, b = first.BranchId, day = BusinessClock.Today(first.TimeZone),
                    title = $"Reminder · {items.Count} waiting over {hours} hours for your approval",
                    lines = JsonSerializer.Serialize(lines, Web), email = smtp && emailTo.Length > 0 ? "pending" : "none", emailTo,
                }, tx);
            await c.ExecuteAsync("""
                insert into approval_reminder (company_id, user_id, sent_at) values (@companyId, @u, now())
                on conflict (company_id, user_id) do update set sent_at = excluded.sent_at
                """, new { companyId, u = g.Key }, tx);
            var ids = items.Select(w => w.Id).ToArray();
            await c.ExecuteAsync("update wastage set reminded_at = now() where id = any(@ids)", new { ids }, tx);
            await c.ExecuteAsync("update stock_return set reminded_at = now() where id = any(@ids)", new { ids }, tx);
            await c.ExecuteAsync("update stock_request set reminded_at = now() where id = any(@ids)", new { ids }, tx);
            sent++;
        }
        await tx.CommitAsync();
        return sent;
    }

    private static TimeZoneInfo Zone(string tz)
    {
        try { return TimeZoneInfo.FindSystemTimeZoneById(string.IsNullOrWhiteSpace(tz) ? "Asia/Dubai" : tz); }
        catch (TimeZoneNotFoundException) { return TimeZoneInfo.FindSystemTimeZoneById("Asia/Dubai"); }
    }
}
