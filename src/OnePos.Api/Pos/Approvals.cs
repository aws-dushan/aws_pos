using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Dapper;
using Npgsql;
using OnePos.Api.Data;
using OnePos.Api.Platform;

namespace OnePos.Api.Pos;

/// <summary>
/// Approvals (REQ APR-01 … APR-04). An action above the cashier's limit answers "approval required" (403 with an approval object).
/// The till then asks for one: a manager's PIN on the same till approves it at once; without one, the request waits for a manager
/// anywhere (phone, back office, head office) to approve or reject it, live. The till sends the action again with X-Approval-Id;
/// the approval covers that one action (same cashier, kind, order or shift, up to the amount) within 15 minutes, once.
/// </summary>
public static class Approvals
{
    public const string Header = "X-Approval-Id";
    private static readonly string[] Kinds = ["discount", "refund", "cash_out"];
    private static readonly TimeSpan ValidFor = TimeSpan.FromMinutes(15);
    private static readonly ConcurrentDictionary<string, (int Count, DateTime Until)> PinFailures = new();

    public sealed record RequestBody(string Kind, decimal Amount, bool? Late, Guid? OrderId, Guid? ShiftId, string Summary, string? Reason, string? Pin, string? Code = null);
    /// <summary>How long an emailed discount code works (for its order, up to its %, once).</summary>
    private static readonly TimeSpan CodeValidFor = TimeSpan.FromHours(24);
    private static string CodeHash(Guid approvalId, string code) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes($"{approvalId}:{code}")));
    public sealed record DecideBody(bool Approve, string? Note);

    public sealed class Row
    {
        public Guid Id { get; set; }
        public Guid CompanyId { get; set; }
        public Guid BranchId { get; set; }
        public string? BranchCode { get; set; }
        public Guid? RegisterId { get; set; }
        public string? RegisterName { get; set; }
        public string Kind { get; set; } = "";
        public Guid? OrderId { get; set; }
        public int? OrderNumber { get; set; }
        public Guid? ShiftId { get; set; }
        public decimal Amount { get; set; }
        public bool Late { get; set; }
        public string Summary { get; set; } = "";
        public string? Reason { get; set; }
        public Guid RequestedBy { get; set; }
        public string? RequestedByName { get; set; }
        public DateTime RequestedAt { get; set; }
        public string Status { get; set; } = "";
        public string? Via { get; set; }
        public string? DecidedByName { get; set; }
        public DateTime? DecidedAt { get; set; }
        public string? Note { get; set; }
    }

    private const string RowSql = """
        select a.*, b.code as branch_code, r.name as register_name, o.number as order_number, u.display_name as requested_by_name,
               coalesce(d.display_name, a.approved_email) as decided_by_name
        from approval a join branch b on b.id = a.branch_id left join register r on r.id = a.register_id left join pos_order o on o.id = a.order_id
        join app_user u on u.id = a.requested_by left join app_user d on d.id = a.decided_by
        """;

    /// <summary>
    /// Whether an approval sent with the request (X-Approval-Id) covers this action; if so it's used up. Otherwise the action needs one:
    /// throws "approval required" with what to ask for.
    /// </summary>
    public static async Task RequireAsync(NpgsqlConnection c, NpgsqlTransaction tx, HttpContext http, Scope scope, string kind, decimal amount, string message,
        bool late = false, Guid? orderId = null, Guid? shiftId = null)
    {
        if (Guid.TryParse(http.Request.Headers[Header].ToString(), out var id))
        {
            var a = await c.QuerySingleOrDefaultAsync<Row>($"{RowSql} where a.id = @id and a.status = 'approved' for update of a", new { id }, tx);
            if (a is not null && a.Kind == kind && a.BranchId == scope.Branch && a.RequestedBy == scope.UserId && a.Amount >= amount && (a.Late || !late)
                && (a.OrderId is null || a.OrderId == orderId) && (a.ShiftId is null || a.ShiftId == shiftId) && a.DecidedAt > DateTime.UtcNow - ValidFor)
            {
                await c.ExecuteAsync("update approval set status = 'used', used_at = now() where id = @id", new { id }, tx);
                await Audit.RecordAsync(c, tx, scope.CompanyId, scope.Branch, scope.UserId, "approval", id.ToString(), "used", $"Approved by {a.DecidedByName}: {a.Summary}");
                return;
            }
        }
        throw new ApprovalRequiredException(message, kind, amount, late, orderId, shiftId);
    }

    /// <summary>Whether this person may approve it: they could do it themselves (permission and limit), and it isn't their own request.</summary>
    private static string? CannotApprove(Scope s, Row a)
    {
        if (s.UserId == a.RequestedBy) return "You can't approve your own request.";
        var ok = a.Kind switch
        {
            "discount" => s.Can("pos.discount") && !(s.Limit("maxDiscountPct") < a.Amount),
            "refund" => s.Can("pos.refund") && !(s.Limit("maxRefund") < a.Amount) && (!a.Late || s.Can("day.manage")),
            "cash_out" => (s.Can("day.manage") || s.Can("day.shift")) && !(s.Limit("maxCashOut") < a.Amount),
            _ => false,
        };
        return ok ? null : "Your role can't approve this (it's above your own limit or outside your permissions).";
    }

    /// <summary>
    /// A discount request sent to a manager: emailed to the branch's discount approval addresses, if it has any, each with its own
    /// code (the bell shows the request without codes). Returns whether an email is waiting to go out.
    /// </summary>
    private static async Task<bool> EmailDiscountAsync(NpgsqlConnection c, NpgsqlTransaction tx, Guid companyId, Row a)
    {
        var b = await c.QuerySingleAsync<(string Name, string Zone, string[]? To, bool Smtp)>("""
            select b.name, b.time_zone, b.discount_approval_emails, co.smtp_settings is not null from branch b join company co on co.id = b.company_id where b.id = @id
            """, new { id = a.BranchId }, tx);
        if (b.To is not { Length: > 0 }) return false;
        var lines = new List<Notices.Line>
        {
            new("Discount", $"{a.Amount:0.##} %"), new("Asked by", a.RequestedByName ?? ""), new("Branch", b.Name),
        };
        if (a.OrderNumber is { } n) lines.Insert(1, new("Order", $"#{n}"));
        if (a.RegisterName is { } r) lines.Add(new("Till", r));
        if (!string.IsNullOrWhiteSpace(a.Reason)) lines.Add(new("Reason", a.Reason!));
        await c.ExecuteAsync("""
            insert into notice (company_id, branch_id, business_date, kind, title, lines, email_status, email_to, link, approval_id)
            values (@companyId, @branch, (now() at time zone @zone)::date, 'approval', @title, cast(@lines as jsonb), @email, @to, '/approvals', @approvalId)
            """, new
            {
                companyId, branch = a.BranchId, zone = b.Zone, title = $"Discount to approve · {a.Summary}",
                lines = JsonSerializer.Serialize(lines, new JsonSerializerOptions(JsonSerializerDefaults.Web)), email = b.Smtp ? "pending" : "none", to = b.To, approvalId = b.Smtp && a.OrderId is not null ? a.Id : (Guid?)null,
            }, tx);
        if (!b.Smtp || a.OrderId is null) return false;
        // Each address its own code, so the record shows whose code approved it.
        foreach (var to in b.To)
        {
            var code = RandomNumberGenerator.GetInt32(0, 1_000_000).ToString("D6");
            await c.ExecuteAsync("insert into approval_code (company_id, approval_id, email, code, code_hash) values (@companyId, @id, @to, @code, @hash)",
                new { companyId, id = a.Id, to, code, hash = CodeHash(a.Id, code) }, tx);
        }
        return true;
    }

    /// <summary>A branch's discount approval addresses, checked when saved (none: no email).</summary>
    public static string[]? CleanEmails(string[]? emails)
    {
        var list = (emails ?? []).Select(e => e.Trim()).Where(e => e.Length > 0).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        if (list.Length > 10) throw new DomainException("Up to 10 email addresses.");
        foreach (var e in list) if (!System.Net.Mail.MailAddress.TryCreate(e, out _)) throw new DomainException($"\"{e}\" isn't an email address.");
        return list.Length == 0 ? null : list;
    }

    private static bool Approver(Scope s) => s.Can("day.manage") || s.Can("pos.refund") || s.Can("pos.discount") && s.Limit("maxDiscountPct") is null;

    public static void Map(RouteGroupBuilder api)
    {
        // Ask for an approval. With a manager's PIN it's decided here and now; otherwise it waits for a manager.
        api.MapPost("/approvals", async (RequestBody body, HttpContext http, Db db, Pins pins, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            var kind = (body.Kind ?? "").Trim().ToLowerInvariant();
            if (!Kinds.Contains(kind)) throw new DomainException("Approvals are for discounts, refunds and cash out.");
            if (string.IsNullOrWhiteSpace(body.Summary)) throw new DomainException("Say what needs approving.");
            Scope? approver = null;
            if (!string.IsNullOrWhiteSpace(body.Pin))
            {
                var slot = $"{scope.Branch:N}|{scope.UserId:N}";
                if (PinFailures.TryGetValue(slot, out var f) && f.Count >= Pins.MaxFailures && f.Until > DateTime.UtcNow)
                    throw new DomainException("Too many wrong PINs. Send the request to a manager instead, or wait a few minutes.");
                var lookup = pins.Lookup(scope.CompanyId, body.Pin.Trim());
                var who = await db.Platform((c, tx) => c.QuerySingleOrDefaultAsync<(Guid Id, bool IsAdmin)>("""
                    select u.id, u.is_admin from user_company uc join app_user u on u.id = uc.user_id
                    where uc.company_id = @co and uc.pin_lookup = @lookup and u.is_active
                    """, new { co = scope.CompanyId, lookup }, tx));
                if (who.Id == Guid.Empty)
                {
                    PinFailures.AddOrUpdate(slot, _ => (1, DateTime.UtcNow.Add(Pins.Lockout)), (_, old) => (old.Until < DateTime.UtcNow ? 1 : old.Count + 1, DateTime.UtcNow.Add(Pins.Lockout)));
                    throw new DomainException("Wrong PIN.");
                }
                PinFailures.TryRemove(slot, out _);
                try { approver = await RequestContext.LoadScopeAsync(db, who.Id, who.IsAdmin, scope.CompanyId, scope.Branch); }
                catch (ForbiddenException) { throw new ForbiddenException("That manager doesn't work at this branch."); }
            }
            // A code from a manager's approval email: any not-yet-used code of a discount request on this order, from the last 24 hours,
            // for at least this %. (A request a manager already approved, rejected or used gives no codes any more.)
            (Guid Id, Guid ApprovalId, string Email) code = default;
            if (approver is null && !string.IsNullOrWhiteSpace(body.Code))
            {
                if (kind != "discount" || body.OrderId is null) throw new DomainException("An emailed code approves a discount on an order.");
                var slot = $"code|{scope.Branch:N}|{scope.UserId:N}";
                if (PinFailures.TryGetValue(slot, out var f) && f.Count >= Pins.MaxFailures && f.Until > DateTime.UtcNow)
                    throw new DomainException("Too many wrong codes. Ask the manager to approve it in One POS instead, or wait a few minutes.");
                var typed = body.Code.Trim();
                var candidates = await db.Company(scope.CompanyId, (c, tx) => c.QueryAsync<(Guid Id, Guid ApprovalId, string Email, string Hash)>("""
                    select ac.id, ac.approval_id, ac.email, ac.code_hash from approval_code ac join approval a on a.id = ac.approval_id
                    where a.order_id = @order and a.branch_id = @b and a.kind = 'discount' and a.status in ('pending','cancelled') and a.amount >= @amount
                      and ac.used_at is null and ac.created_at > now() - @valid
                    """, new { order = body.OrderId, b = scope.Branch, amount = Money.Round(body.Amount), valid = CodeValidFor }, tx));
                var hit = candidates.FirstOrDefault(x => CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(x.Hash), Encoding.ASCII.GetBytes(CodeHash(x.ApprovalId, typed))));
                if (hit.Id == Guid.Empty)
                {
                    PinFailures.AddOrUpdate(slot, _ => (1, DateTime.UtcNow.Add(Pins.Lockout)), (_, old) => (old.Until < DateTime.UtcNow ? 1 : old.Count + 1, DateTime.UtcNow.Add(Pins.Lockout)));
                    throw new DomainException("That code doesn't work: it's wrong, already used, for another order or a smaller discount, or older than 24 hours.");
                }
                PinFailures.TryRemove(slot, out _);
                code = (hit.Id, hit.ApprovalId, hit.Email);
            }
            var emailed = false;
            var row = await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var id = await c.ExecuteScalarAsync<Guid>("""
                    insert into approval (company_id, branch_id, register_id, kind, order_id, shift_id, amount, late, summary, reason, requested_by)
                    values (@co, @b, @reg, @kind, @order, @shift, @amount, @late, @summary, @reason, @u) returning id
                    """, new { co = scope.CompanyId, b = scope.Branch, reg = scope.RegisterId, kind, order = body.OrderId, shift = body.ShiftId, amount = Money.Round(body.Amount),
                               late = body.Late == true, summary = body.Summary.Trim(), reason = string.IsNullOrWhiteSpace(body.Reason) ? null : body.Reason.Trim(), u = scope.UserId }, tx);
                var a = await c.QuerySingleAsync<Row>($"{RowSql} where a.id = @id", new { id }, tx);
                if (approver is not null)
                {
                    if (CannotApprove(approver, a) is { } why) throw new ForbiddenException(why);
                    await c.ExecuteAsync("update approval set status = 'approved', via = 'pin', decided_by = @u, decided_at = now() where id = @id", new { id, u = approver.UserId }, tx);
                    await Audit.RecordAsync(c, tx, scope.CompanyId, scope.Branch, approver.UserId, "approval", id.ToString(), "approved", $"Approved with PIN at the till: {a.Summary}", note: a.Reason);
                }
                else if (code.Id != Guid.Empty)
                {
                    if (await c.ExecuteAsync("update approval_code set used_at = now() where id = @Id and used_at is null", new { code.Id }, tx) == 0)
                        throw new ConflictException("That code was just used.");
                    await c.ExecuteAsync("update approval set status = 'used', used_at = now() where id = @ApprovalId and status in ('pending','cancelled')", new { code.ApprovalId }, tx);
                    await c.ExecuteAsync("update approval set status = 'approved', via = 'code', approved_email = @Email, decided_at = now() where id = @id", new { id, code.Email }, tx);
                    await Audit.RecordAsync(c, tx, scope.CompanyId, scope.Branch, scope.UserId, "approval", id.ToString(), "approved", $"Approved with the code emailed to {code.Email}: {a.Summary}", note: a.Reason);
                }
                else
                {
                    await Audit.RecordAsync(c, tx, scope.CompanyId, scope.Branch, scope.UserId, "approval", id.ToString(), "requested", $"Approval requested: {a.Summary}", note: a.Reason);
                    if (kind == "discount") emailed = await EmailDiscountAsync(c, tx, scope.CompanyId, a);
                }
                return await c.QuerySingleAsync<Row>($"{RowSql} where a.id = @id", new { id }, tx);
            });
            if (emailed) Notices.Sender.Wake();   // the approval email goes out now, not at the next minute
            await live.ToBranch(scope.Branch, "approvals.changed", new { row.Id });
            await live.ToCompany(scope.CompanyId, "approvals.changed", new { row.Id });
            return Results.Ok(row);
        });

        // What's waiting: the branch's requests, or (all=true) every branch of the company this person can approve in.
        api.MapGet("/approvals", async (HttpContext http, Db db, bool? all, string? status) =>
        {
            var scope = await http.ScopeAsync(db);
            if (!Approver(scope)) throw new ForbiddenException("Your role doesn't approve requests.");
            var st = status is "approved" or "rejected" or "used" or "cancelled" or "all" ? status : "pending";
            return await db.Company(scope.CompanyId, async (c, tx) => (await c.QueryAsync<Row>($"""
                {RowSql}
                where (@st = 'all' or a.status = @st)
                  and (case when @all then (@admin or exists (select 1 from user_branch ub where ub.user_id = @u and ub.branch_id = a.branch_id)) else a.branch_id = @b end)
                  and a.requested_at > now() - interval '2 days'
                order by a.requested_at desc limit 100
                """, new { st, all = all == true, admin = scope.IsAdmin, u = scope.UserId, b = scope.BranchId }, tx)).ToList());
        });

        api.MapGet("/approvals/{id:guid}", async (Guid id, HttpContext http, Db db) =>
        {
            var scope = await http.ScopeAsync(db);
            return await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var a = await c.QuerySingleOrDefaultAsync<Row>($"{RowSql} where a.id = @id", new { id }, tx) ?? throw new NotFoundException("Approval not found.");
                if (a.RequestedBy != scope.UserId && !Approver(scope)) throw new ForbiddenException("This isn't your request.");
                return a;
            });
        });

        // A manager decides, from anywhere they can work in that branch.
        api.MapPost("/approvals/{id:guid}/decide", async (Guid id, DecideBody body, HttpContext http, Db db, Live live) =>
        {
            var me = await http.ScopeAsync(db);
            var a = await db.Company(me.CompanyId, (c, tx) => c.QuerySingleOrDefaultAsync<Row>($"{RowSql} where a.id = @id", new { id }, tx)) ?? throw new NotFoundException("Approval not found.");
            var scope = await RequestContext.LoadScopeAsync(db, me.UserId, me.IsAdmin, me.CompanyId, a.BranchId);
            if (body.Approve && CannotApprove(scope, a) is { } why) throw new ForbiddenException(why);
            // Rejecting is for those who could approve it (a supervisor can't turn down a discount above their own limit).
            if (!body.Approve && CannotApprove(scope, a) is { } whyNot) throw new ForbiddenException(whyNot.Replace("approve this", "answer this"));
            var row = await db.Company(me.CompanyId, async (c, tx) =>
            {
                var n = await c.ExecuteAsync("""
                    update approval set status = @st, via = 'remote', decided_by = @u, decided_at = now(), note = @note where id = @id and status = 'pending'
                    """, new { id, st = body.Approve ? "approved" : "rejected", u = me.UserId, note = string.IsNullOrWhiteSpace(body.Note) ? null : body.Note.Trim() }, tx);
                if (n == 0) throw new ConflictException("Someone already answered this request, or it was cancelled.");
                await Audit.RecordAsync(c, tx, me.CompanyId, a.BranchId, me.UserId, "approval", id.ToString(), body.Approve ? "approved" : "rejected",
                    $"{(body.Approve ? "Approved" : "Rejected")}: {a.Summary} (asked by {a.RequestedByName})", note: body.Note);
                return await c.QuerySingleAsync<Row>($"{RowSql} where a.id = @id", new { id }, tx);
            });
            await live.ToBranch(a.BranchId, "approvals.changed", new { row.Id });
            await live.ToCompany(me.CompanyId, "approvals.changed", new { row.Id });
            return Results.Ok(row);
        });

        api.MapPost("/approvals/{id:guid}/cancel", async (Guid id, HttpContext http, Db db, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var n = await c.ExecuteAsync("update approval set status = 'cancelled' where id = @id and requested_by = @u and status in ('pending','approved')", new { id, u = scope.UserId }, tx);
                if (n == 0) throw new DomainException("This request can't be cancelled any more.");
                return 0;
            });
            await live.ToBranch(scope.Branch, "approvals.changed", new { id });
            await live.ToCompany(scope.CompanyId, "approvals.changed", new { id });
            return Results.Ok(new { id });
        });
    }
}
