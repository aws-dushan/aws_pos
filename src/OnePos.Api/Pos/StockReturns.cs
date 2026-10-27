using System.Globalization;
using System.Text.Json;
using System.Xml.Linq;
using Dapper;
using Microsoft.Data.SqlClient;
using Npgsql;
using OnePos.Api.Data;
using OnePos.Api.Erp;
using OnePos.Api.Platform;

namespace OnePos.Api.Pos;

/// <summary>
/// Returns to the location of origin (the factory's good location). Two kinds:
/// - variance: a delivery checked in with less than was sent (Stock: deliveries/check); the difference goes back by itself to where
///   the delivery came from.
/// - manual: the Returns tab; an item delivered here goes back to where its latest delivery came from.
/// Each return waits for the branch's wastage approver (company administrators can stand in); approved, it goes to FACTS at once as
/// a POSTED STV50 from the outlet to that location (usp_ONEPOS_PostWastageTransfer: batches FIFO, FACTS' own approval, as the
/// approver's FACTS username), after checking FACTS has the stock. Rejected, or cancelled while waiting, it never goes.
/// </summary>
public static class StockReturns
{
    public sealed record ReturnBody(string ItemCode, decimal Qty, string Reason, string? Note);
    public sealed record ApproveLine(Guid Id, decimal? Qty);
    public sealed record ApproveBody(ApproveLine[] Lines, string? Note);
    public sealed record RejectBody(Guid[] Ids, string Note);

    private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;
    private static readonly JsonSerializerOptions Web = new(JsonSerializerDefaults.Web);
    /// <summary>"short" is the variance's own; the others are chosen on the Returns tab.</summary>
    public static readonly Dictionary<string, string> Reasons = new()
    {
        ["short"] = "Short delivered", ["excess"] = "Not needed", ["damaged"] = "Damaged", ["wrong"] = "Wrong item", ["quality"] = "Quality", ["expiry"] = "Near expiry", ["other"] = "Other",
    };

    public sealed class ReturnRow
    {
        public Guid Id { get; set; }
        public Guid BranchId { get; set; }
        public DateOnly BusinessDate { get; set; }
        public string Source { get; set; } = "";
        public string DeliveryDocType { get; set; } = "";
        public string DeliveryDocNo { get; set; } = "";
        public int DeliveryLine { get; set; }
        public string ToLocation { get; set; } = "";
        public string ItemType { get; set; } = "";
        public string ItemCode { get; set; } = "";
        public string ItemName { get; set; } = "";
        public string? Unit { get; set; }
        public decimal Qty { get; set; }
        public decimal? RequestedQty { get; set; }
        public string Reason { get; set; } = "";
        public string? Note { get; set; }
        public string RecordedByName { get; set; } = "";
        public Guid RecordedBy { get; set; }
        public DateTime RecordedAt { get; set; }
        public string Approval { get; set; } = "";
        public string? DecidedByName { get; set; }
        public string? DecisionNote { get; set; }
        public string ErpStatus { get; set; } = "";
        public string? ErpDoc { get; set; }
        public string BranchCode { get; set; } = "";
        public string BranchName { get; set; } = "";
        public Guid? ApproverId { get; set; }
        public DateTime? RemindedAt { get; set; }
    }

    private const string RowSql = """
        select r.*, u.display_name as recorded_by_name, d.display_name as decided_by_name, b.code as branch_code, b.name as branch_name, b.wastage_approver_id as approver_id
        from stock_return r join branch b on b.id = r.branch_id join app_user u on u.id = r.recorded_by left join app_user d on d.id = r.decided_by
        """;

    /// <summary>A line of a delivery as FACTS has it.</summary>
    public sealed record DeliveryLine(int Line, string Code, string? Type, string Name, decimal Qty, string? Unit);
    /// <summary>A delivery into the branch's location as FACTS has it: where it came from, whether it's posted (only then has stock moved), its lines.</summary>
    public sealed record Delivery(string From, bool Posted, List<DeliveryLine> Lines);

    public static async Task<Delivery?> ReadDeliveryAsync(SqlConnection f, string loc, string docType, string docNo)
    {
        var args = new { loc, docType, docNo };
        var head = await f.QuerySingleOrDefaultAsync<(string From, DateTime? Posted)>("""
            select top 1 ltrim(rtrim(h.TSF_LOCATION_FM_DOCNO)), h.TSF_POSTED_TS from TRANSFER_HEADER h
            where h.TSF_DOCTYPE = @docType and h.TSF_DOCNO = @docNo and h.TSF_LOCATION_TO_DOCNO = @loc order by h.TSF_DOCDATE desc
            """, args, commandTimeout: 60);
        if (head.From is null) return null;
        var lines = (await f.QueryAsync<(int, string, string?, string, decimal, string?)>("""
            select d.TSFDET_DOCSRNO, ltrim(rtrim(d.TSFDET_STOCK_DOCNO)), nullif(ltrim(rtrim(d.TSFDET_STOCK_DOCTYPE)), ''), d.TSFDET_STOCK_DESC, d.TSFDET_QTY, ltrim(rtrim(d.TSFDET_UNIT_DOCNO))
            from TRANSFER_DETAILS d join TRANSFER_HEADER h on h.TSF_FYCODE = d.TSFDET_FYCODE and h.TSF_DOCTYPE = d.TSFDET_DOCTYPE and h.TSF_DOCNO = d.TSFDET_DOCNO
            where h.TSF_DOCTYPE = @docType and h.TSF_DOCNO = @docNo and h.TSF_LOCATION_TO_DOCNO = @loc
            """, args, commandTimeout: 60)).Select(x => new DeliveryLine(x.Item1, x.Item2, x.Item3, x.Item4.Trim(), x.Item5, x.Item6)).ToList();
        return new Delivery(head.From, head.Posted is not null, lines);
    }

    /// <summary>An item delivered here: its latest posted delivery, which says where a return of it goes.</summary>
    public sealed record Returnable(string Code, string Name, string? Type, string? Unit, string DocType, string DocNo, int Line, string From, string? FromName, DateTime Date);

    /// <summary>Items delivered into the location (posted, stock-moving transfers) in the last days, each with its latest delivery.</summary>
    public static async Task<List<Returnable>> ReturnablesAsync(SqlConnection f, string loc, DateTime since, string? code = null) =>
        (await f.QueryAsync<Returnable>("""
            select Code, Name, Type, Unit, DocType, DocNo, Line, [From], FromName, Date from (
              select ltrim(rtrim(d.TSFDET_STOCK_DOCNO)) as Code, ltrim(rtrim(d.TSFDET_STOCK_DESC)) as Name, nullif(ltrim(rtrim(d.TSFDET_STOCK_DOCTYPE)), '') as Type,
                     ltrim(rtrim(d.TSFDET_UNIT_DOCNO)) as Unit, h.TSF_DOCTYPE as DocType, h.TSF_DOCNO as DocNo, d.TSFDET_DOCSRNO as Line,
                     ltrim(rtrim(h.TSF_LOCATION_FM_DOCNO)) as [From], l.LOC_DESC as FromName, h.TSF_DOCDATE as Date,
                     row_number() over (partition by ltrim(rtrim(d.TSFDET_STOCK_DOCNO)) order by h.TSF_DOCDATE desc, h.TSF_DOCNO desc, d.TSFDET_DOCSRNO) as rn
              from TRANSFER_DETAILS d join TRANSFER_HEADER h on h.TSF_FYCODE = d.TSFDET_FYCODE and h.TSF_DOCTYPE = d.TSFDET_DOCTYPE and h.TSF_DOCNO = d.TSFDET_DOCNO
              left join LOCATION_MASTER l on l.LOC_DOCNO = h.TSF_LOCATION_FM_DOCNO left join DOCUMENT_MASTER dm on dm.DM_DOCNO = h.TSF_DOCTYPE
              where h.TSF_LOCATION_TO_DOCNO = @loc and h.TSF_POSTED_TS is not null and isnull(dm.DM_UPDATE_STOCK, 0) = 1 and h.TSF_DOCDATE >= @since
                and (@code is null or ltrim(rtrim(d.TSFDET_STOCK_DOCNO)) = @code)
            ) x where rn = 1 order by Name
            """, new { loc, since, code }, commandTimeout: 60)).ToList();

    /// <summary>The branch's returns against these deliveries ("STV50 8114"), for the Deliveries tab, newest first.</summary>
    public static async Task<List<ReturnRow>> ForDeliveriesAsync(NpgsqlConnection c, NpgsqlTransaction tx, Guid branchId, string[] docs) =>
        docs.Length == 0 ? [] : (await c.QueryAsync<ReturnRow>($"{RowSql} where r.branch_id = @branchId and r.delivery_doc_type || ' ' || r.delivery_doc_no = any(@docs) order by r.recorded_at desc",
            new { branchId, docs }, tx)).ToList();

    /// <summary>Returns can be sent from this branch: FACTS-linked, with a wastage approver who has a FACTS username.</summary>
    public static bool CanReturn(WastageApproval.Setup s) => s.Connector == "facts" && s.Loc is not null && s.ApproverId is not null && !string.IsNullOrWhiteSpace(s.FactsUser);

    public sealed record NewLine(string DocType, string DocNo, int Line, string To, string Type, string Code, string Name, string? Unit, decimal Qty);

    /// <summary>Records returns (same transaction) waiting for the branch's approver, who gets them under the bell and by email.</summary>
    public static async Task<int> CreateAsync(NpgsqlConnection c, NpgsqlTransaction tx, Scope scope, WastageApproval.Setup s, string source, string reason, string? note, List<NewLine> lines)
    {
        if (lines.Count == 0) return 0;
        var day = await Days.DateAsync(c, tx, scope.Branch);
        foreach (var l in lines)
            await c.ExecuteAsync("""
                insert into stock_return (company_id, branch_id, business_date, source, delivery_doc_type, delivery_doc_no, delivery_line, to_location,
                                          item_type, item_code, item_name, unit, qty, reason, note, recorded_by)
                values (@co, @b, @day, @source, @DocType, @DocNo, @Line, @To, @Type, @Code, @Name, @Unit, @Qty, @reason, @note, @u)
                """, new { co = scope.CompanyId, b = scope.Branch, day, source, l.DocType, l.DocNo, l.Line, l.To, l.Type, l.Code, l.Name, l.Unit, l.Qty, reason, note, u = scope.UserId }, tx);
        var what = lines.Select(l => $"{l.Qty.ToString("0.###", Inv)} {l.Unit} {l.Name}".Replace("  ", " ")).ToList();
        var to = string.Join(", ", lines.Select(l => l.To).Distinct());
        var against = string.Join(", ", lines.Select(l => $"{l.DocType} {l.DocNo}").Distinct());
        await Audit.RecordAsync(c, tx, scope.CompanyId, scope.Branch, scope.UserId, "return", against, "recorded",
            $"Return to {to} ({Reasons[reason]}, against {against}): {string.Join(", ", what)}", note: note);
        var by = await c.ExecuteScalarAsync<string?>("select display_name from app_user where id = @u", new { u = scope.UserId }, tx) ?? "";
        var noticeLines = new List<Notices.Line> { new("Back to", to), new("Delivery", against), new("Reason", Reasons[reason]), new("Recorded by", by), new("Branch", s.Name) };
        noticeLines.AddRange(what.Select(w => new Notices.Line("Item", w)));
        if (note is not null) noticeLines.Add(new("Note", note));
        var smtp = await c.ExecuteScalarAsync<bool>("select smtp_settings is not null from company where id = @co", new { co = scope.CompanyId }, tx);
        var emailTo = s.Email is { Length: > 0 } e ? new[] { e } : [];
        await c.ExecuteAsync("""
            insert into notice (company_id, branch_id, business_date, kind, title, lines, email_status, email_to, link)
            values (@co, @b, @day, 'return', @title, cast(@lines as jsonb), @email, @emailTo, '/approvals')
            """, new
            {
                co = scope.CompanyId, b = scope.Branch, day, title = $"Return to approve · {what.Count} item{(what.Count == 1 ? "" : "s")} back to {to}",
                lines = JsonSerializer.Serialize(noticeLines, Web), email = smtp && emailTo.Length > 0 ? "pending" : "none", emailTo,
            }, tx);
        return lines.Count;
    }

    /// <summary>
    /// A delivery (re)checked in: its variance goes back. Earlier variance returns still waiting are cancelled and made again from
    /// this count; once one was approved the count can't change any more (it went back in FACTS). Answers how many lines go back.
    /// </summary>
    public static async Task<int> VarianceAsync(NpgsqlConnection c, NpgsqlTransaction tx, Scope scope, WastageApproval.Setup s, string? master,
        string docType, string docNo, Delivery d, IReadOnlyDictionary<int, decimal> received)
    {
        if (await c.ExecuteScalarAsync<bool>("""
                select exists (select 1 from stock_return where branch_id = @b and delivery_doc_type = @docType and delivery_doc_no = @docNo and source = 'variance' and approval = 'approved')
                """, new { b = scope.Branch, docType, docNo }, tx))
            throw new DomainException($"The difference on {docType} {docNo} was approved and went back in FACTS; its check-in can't change any more.");
        await c.ExecuteAsync("""
            update stock_return set approval = 'cancelled', decided_by = @u, decided_at = now(), decision_note = 'Checked in again'
            where branch_id = @b and delivery_doc_type = @docType and delivery_doc_no = @docNo and source = 'variance' and approval = 'waiting'
            """, new { b = scope.Branch, docType, docNo, u = scope.UserId }, tx);
        if (!d.Posted || !CanReturn(s)) return 0;
        var lines = d.Lines.Where(l => received.TryGetValue(l.Line, out var got) && got < l.Qty)
            .Select(l => new NewLine(docType, docNo, l.Line, d.From, (l.Type ?? master ?? "SMBK").ToUpperInvariant(), l.Code, l.Name, l.Unit, l.Qty - received[l.Line])).ToList();
        return await CreateAsync(c, tx, scope, s, "variance", "short", null, lines);
    }

    /// <summary>Undo check-in: its waiting variance returns go too; refused once one was approved (posted in FACTS).</summary>
    public static async Task UncheckAsync(NpgsqlConnection c, NpgsqlTransaction tx, Scope scope, string docType, string docNo)
    {
        if (await c.ExecuteScalarAsync<bool>("""
                select exists (select 1 from stock_return where branch_id = @b and delivery_doc_type = @docType and delivery_doc_no = @docNo and source = 'variance' and approval = 'approved')
                """, new { b = scope.Branch, docType, docNo }, tx))
            throw new DomainException("The difference on this delivery was approved and went back in FACTS; the check-in can't be undone.");
        await c.ExecuteAsync("""
            update stock_return set approval = 'cancelled', decided_by = @u, decided_at = now(), decision_note = 'Check-in undone'
            where branch_id = @b and delivery_doc_type = @docType and delivery_doc_no = @docNo and source = 'variance' and approval = 'waiting'
            """, new { b = scope.Branch, docType, docNo, u = scope.UserId }, tx);
    }

    private static bool MayDecide(Scope scope, Guid? approverId) => scope.IsAdmin || approverId == scope.UserId;

    public static void Map(RouteGroupBuilder api)
    {
        // The Returns tab: the branch's returns (both kinds) over the last days, and who approves them.
        api.MapGet("/stock/returns", async (HttpContext http, Db db, int? days) =>
        {
            var scope = await http.ScopeAsync(db);
            if (!scope.Can("kitchen.view") && !scope.Can("facts.post")) scope.Require("pos.sell");
            return await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var s = await WastageApproval.SetupAsync(c, tx, scope.Branch);
                var rows = await c.QueryAsync<ReturnRow>($"{RowSql} where r.branch_id = @b and r.recorded_at >= now() - make_interval(days => @days) order by r.recorded_at desc",
                    new { b = scope.Branch, days = Math.Clamp(days ?? 30, 1, 180) }, tx);
                var approver = s.ApproverId is { } a ? await c.ExecuteScalarAsync<string?>("select display_name from app_user where id = @a", new { a }, tx) : null;
                return new
                {
                    linked = s.Connector == "facts" && s.Loc is not null, location = s.Loc, canReturn = CanReturn(s), approver,
                    returns = rows.Select(r => new
                    {
                        r.Id, r.Source, r.DeliveryDocType, r.DeliveryDocNo, r.ToLocation, r.ItemCode, r.ItemName, r.Qty, r.RequestedQty, r.Unit, r.Reason, r.Note,
                        r.RecordedByName, r.RecordedAt, r.Approval, r.DecidedByName, r.DecisionNote, r.ErpStatus, r.ErpDoc, r.RemindedAt,
                    }),
                };
            });
        });

        // What can go back: items delivered here in the last 60 days, each with where its latest delivery came from (read from FACTS).
        api.MapGet("/stock/returns/items", async (HttpContext http, Db db, FactsSync facts) =>
        {
            var scope = await http.ScopeAsync(db);
            if (!scope.Can("kitchen.view")) scope.Require("pos.sell");
            var (loc, tz) = await db.Company(scope.CompanyId, (c, tx) => c.QuerySingleAsync<(string? Loc, string Tz)>("select erp_location_code, time_zone from branch where id = @b", new { b = scope.Branch }, tx));
            if (loc is null) return Results.Ok(Array.Empty<Returnable>());
            await using var f = await facts.OpenAsync(scope.CompanyId);
            return Results.Ok(await ReturnablesAsync(f, loc, BusinessClock.Today(tz).AddDays(-60).ToDateTime(TimeOnly.MinValue)));
        });

        // Send an item back to where its latest delivery came from: it waits for the branch's wastage approver.
        api.MapPost("/stock/returns", async (ReturnBody body, HttpContext http, Db db, FactsSync facts, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            if (!scope.Can("kitchen.view")) scope.Require("pos.sell");
            var code = (body.ItemCode ?? "").Trim();
            if (code.Length == 0) throw new DomainException("Choose the item.");
            if (body.Qty <= 0) throw new DomainException("Enter how much goes back.");
            var reason = (body.Reason ?? "").Trim().ToLowerInvariant();
            if (reason == "short" || !Reasons.ContainsKey(reason)) throw new DomainException("Choose why it goes back.");
            var note = string.IsNullOrWhiteSpace(body.Note) ? null : body.Note.Trim();
            if (reason == "other" && note is null) throw new DomainException("Say why it goes back.");
            var (s, master, tz) = await db.Company(scope.CompanyId, async (c, tx) => (await WastageApproval.SetupAsync(c, tx, scope.Branch),
                await c.ExecuteScalarAsync<string?>("select facts_item_master from company where id = @co", new { co = scope.CompanyId }, tx),
                await c.ExecuteScalarAsync<string>("select time_zone from branch where id = @b", new { b = scope.Branch }, tx) ?? "Asia/Dubai"));
            if (!CanReturn(s)) throw new DomainException("Returns need an approver: set this branch's wastage approver and their FACTS username (Companies & branches).");
            Returnable? item;
            await using (var f = await facts.OpenAsync(scope.CompanyId))
                item = (await ReturnablesAsync(f, s.Loc!, BusinessClock.Today(tz).AddDays(-60).ToDateTime(TimeOnly.MinValue), code)).FirstOrDefault();
            if (item is null) throw new DomainException("That item wasn't delivered here in the last 60 days, so there's no location to send it back to.");
            var n = await db.Company(scope.CompanyId, (c, tx) => CreateAsync(c, tx, scope, s, "manual", reason, note,
                [new(item.DocType, item.DocNo, item.Line, item.From, (item.Type ?? master ?? "SMBK").ToUpperInvariant(), item.Code, item.Name, item.Unit, body.Qty)]));
            await live.ToBranch(scope.Branch, "stock.changed");
            return Results.Ok(new { lines = n, to = item.From });
        });

        // Changed my mind, while it waits: the person who asked, or a manager.
        api.MapPost("/stock/returns/{id:guid}/cancel", async (Guid id, HttpContext http, Db db, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var r = await c.QuerySingleOrDefaultAsync<ReturnRow>($"{RowSql} where r.id = @id and r.branch_id = @b for update of r", new { id, b = scope.Branch }, tx)
                    ?? throw new NotFoundException("Return not found.");
                if (r.Approval != "waiting") throw new DomainException(r.Approval == "approved" ? "This was approved and posted in FACTS; correct it there." : "This return was decided already.");
                if (r.Source == "variance") throw new DomainException("This is a delivery's difference: change the delivery's check-in instead.");
                if (!scope.Can("day.manage") && r.RecordedBy != scope.UserId) throw new ForbiddenException("Only a manager can cancel someone else's return.");
                await c.ExecuteAsync("update stock_return set approval = 'cancelled', decided_by = @u, decided_at = now() where id = @id", new { id, u = scope.UserId }, tx);
                await Audit.RecordAsync(c, tx, scope.CompanyId, scope.Branch, scope.UserId, "return", id.ToString(), "cancelled", $"Return of {r.Qty.ToString("0.###", Inv)} × {r.ItemName} cancelled");
                return 0;
            });
            await live.ToBranch(scope.Branch, "stock.changed");
            return Results.Ok(new { id });
        });

        // Waiting for me: the branches I approve wastage (and so returns) for; an administrator sees all.
        api.MapGet("/returns/approvals", async (HttpContext http, Db db) =>
        {
            var scope = await http.ScopeAsync(db);
            return await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var rows = await c.QueryAsync<ReturnRow>($"{RowSql} where r.approval = 'waiting' and (@admin or b.wastage_approver_id = @u) order by r.recorded_at",
                    new { admin = scope.IsAdmin, u = scope.UserId }, tx);
                var approver = await c.ExecuteScalarAsync<bool>("select exists (select 1 from branch where wastage_approver_id = @u)", new { u = scope.UserId }, tx);
                return new
                {
                    isApprover = approver || scope.IsAdmin,
                    items = rows.Select(r => new { r.Id, r.Source, r.BranchName, r.DeliveryDocType, r.DeliveryDocNo, r.ToLocation, r.ItemCode, r.ItemName, r.Qty, r.Unit, r.Reason, r.Note, r.RecordedByName, r.RecordedAt }),
                };
            });
        });

        // Approve (a quantity may be lowered): FACTS must hold the stock; then one posted STV50 per destination goes back.
        api.MapPost("/returns/approvals/approve", async (ApproveBody body, HttpContext http, Db db, FactsSync facts, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            if (body.Lines is not { Length: > 0 }) throw new DomainException("Choose the returns to approve.");
            var ids = body.Lines.Select(l => l.Id).Distinct().ToArray();
            var list = (await db.Company(scope.CompanyId, (c, tx) => c.QueryAsync<ReturnRow>($"{RowSql} where r.approval = 'waiting' and r.id = any(@ids)", new { ids }, tx))).ToList();
            if (list.Count != ids.Length) throw new DomainException("Some of these were decided already, or cancelled. Refresh and try again.");
            if (list.Any(r => !MayDecide(scope, r.ApproverId))) throw new ForbiddenException("You don't approve returns for that branch.");
            var qtyOf = body.Lines.Where(l => l.Qty is not null).ToDictionary(l => l.Id, l => l.Qty!.Value);
            foreach (var r in list)
                if (qtyOf.TryGetValue(r.Id, out var q) && (q <= 0 || q > r.Qty))
                    throw new DomainException(q <= 0 ? "A quantity must be above zero; reject it instead." : $"{r.ItemName}: approve at most the {r.Qty.ToString("0.###", Inv)} asked.");
            decimal Qty(ReturnRow r) => qtyOf.TryGetValue(r.Id, out var q) ? q : r.Qty;

            var setups = new Dictionary<Guid, WastageApproval.Setup>();
            await db.Company(scope.CompanyId, async (c, tx) =>
            {
                foreach (var b in list.Select(r => r.BranchId).Distinct()) setups[b] = await WastageApproval.SetupAsync(c, tx, b);
                return 0;
            });
            foreach (var s in setups.Values)
            {
                if (s.Connector != "facts" || s.Loc is null) throw new DomainException($"{s.Name} has no FACTS stock location.");
                if (string.IsNullOrWhiteSpace(s.FactsUser)) throw new DomainException($"Set the approver's FACTS username for {s.Name} first (Companies & branches).");
            }

            // FACTS must have the stock in its batches at the outlet (the posting takes them FIFO): checked before anything changes.
            var short_ = new List<string>();
            await using (var f = await facts.OpenAsync(scope.CompanyId))
                foreach (var g in list.GroupBy(r => (r.BranchId, r.ItemCode, r.Unit)))
                    if (await WastageApproval.ShortAsync(f, g.Key.ItemCode, setups[g.Key.BranchId].Loc!, g.Max(r => r.BusinessDate), g.Key.Unit, g.Sum(Qty), g.First().ItemName) is { } m)
                        short_.Add(m);
            if (short_.Count > 0) throw new DomainException($"Not enough stock in FACTS: {string.Join("; ", short_)}. Approve less, or approve once FACTS has it.");

            var transfers = await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var locked = (await c.QueryAsync<Guid>("select id from stock_return where id = any(@ids) and approval = 'waiting' for update", new { ids }, tx)).ToList();
                if (locked.Count != ids.Length) throw new DomainException("Some of these were decided meanwhile. Refresh and try again.");
                var note = string.IsNullOrWhiteSpace(body.Note) ? null : body.Note.Trim();
                foreach (var r in list)
                {
                    var q = Qty(r);
                    await c.ExecuteAsync("""
                        update stock_return set approval = 'approved', decided_by = @u, decided_at = now(), decision_note = @note,
                          requested_qty = case when @q <> qty then qty end, qty = @q where id = @Id
                        """, new { u = scope.UserId, note, q, r.Id }, tx);
                    await Audit.RecordAsync(c, tx, scope.CompanyId, r.BranchId, scope.UserId, "return", r.Id.ToString(), "approved",
                        $"Return approved: {q.ToString("0.###", Inv)} × {r.ItemName} back to {r.ToLocation}{(q != r.Qty ? $" (asked {r.Qty.ToString("0.###", Inv)})" : "")}", note: note);
                }
                // One posted STV50 per branch, destination and day, from the outlet back to the location of origin.
                var n = 0;
                foreach (var g in list.GroupBy(r => (r.BranchId, r.ToLocation, r.BusinessDate)))
                {
                    var s = setups[g.Key.BranchId];
                    var postId = Guid.NewGuid();
                    var against = string.Join(", ", g.Select(r => $"{r.DeliveryDocType} {r.DeliveryDocNo}").Distinct());
                    var reference = $"One POS return {s.Code} R-{postId.ToString("N")[..8].ToUpperInvariant()} ({against})";
                    if (reference.Length > 200) reference = reference[..197] + "...";
                    var xml = new XElement("data", new XElement("Transfer",
                        new XElement("DocDate", g.Key.BusinessDate.ToString("yyyy-MM-dd", Inv)), new XElement("FromLocation", s.Loc), new XElement("ToLocation", g.Key.ToLocation),
                        new XElement("Reference", reference),
                        g.Select(r => new XElement("Line", new XElement("ItemType", r.ItemType), new XElement("ItemCode", r.ItemCode), new XElement("ItemName", r.ItemName),
                            new XElement("Qty", Qty(r).ToString("0.###", Inv)), new XElement("Unit", r.Unit ?? "PCS")))));
                    await c.ExecuteAsync("""
                        insert into erp_post (id, company_id, branch_id, kind, doc_no, business_date, amount, xml, status, facts_user)
                        values (@postId, @co, @b, 'return', @reference, @day, 0, @xml, 'pending', @user)
                        """, new { postId, co = scope.CompanyId, b = g.Key.BranchId, reference, day = g.Key.BusinessDate, xml = xml.ToString(SaveOptions.DisableFormatting), user = s.FactsUser!.Trim() }, tx);
                    await c.ExecuteAsync("update stock_return set erp_post_id = @postId, erp_status = 'pending' where id = any(@ids)", new { postId, ids = g.Select(r => r.Id).ToArray() }, tx);
                    n++;
                }
                return n;
            });
            FactsPosting.Sender.Wake();
            foreach (var b in list.Select(r => r.BranchId).Distinct()) await live.ToBranch(b, "stock.changed");
            return Results.Ok(new { approved = list.Count, transfers });
        });

        // Reject: it stays at the branch and never goes to FACTS; the reason is shown to the branch.
        api.MapPost("/returns/approvals/reject", async (RejectBody body, HttpContext http, Db db, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            if (body.Ids is not { Length: > 0 }) throw new DomainException("Choose the returns to reject.");
            if (string.IsNullOrWhiteSpace(body.Note)) throw new DomainException("Say why it's rejected (the branch sees it).");
            var ids = body.Ids.Distinct().ToArray();
            var branches = await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var rows = (await c.QueryAsync<ReturnRow>($"{RowSql} where r.approval = 'waiting' and r.id = any(@ids) for update of r", new { ids }, tx)).ToList();
                if (rows.Count != ids.Length) throw new DomainException("Some of these were decided already, or cancelled. Refresh and try again.");
                if (rows.Any(r => !MayDecide(scope, r.ApproverId))) throw new ForbiddenException("You don't approve returns for that branch.");
                foreach (var r in rows)
                {
                    await c.ExecuteAsync("update stock_return set approval = 'rejected', decided_by = @u, decided_at = now(), decision_note = @note where id = @Id",
                        new { u = scope.UserId, note = body.Note.Trim(), r.Id }, tx);
                    await Audit.RecordAsync(c, tx, scope.CompanyId, r.BranchId, scope.UserId, "return", r.Id.ToString(), "rejected", $"Return rejected: {r.Qty.ToString("0.###", Inv)} × {r.ItemName}", note: body.Note.Trim());
                }
                return rows.Select(r => r.BranchId).Distinct().ToList();
            });
            foreach (var b in branches) await live.ToBranch(b, "stock.changed");
            return Results.Ok(new { rejected = ids.Length });
        });
    }
}
