using System.Globalization;
using System.Net.Mail;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Xml.Linq;
using Dapper;
using Microsoft.Data.SqlClient;
using Npgsql;
using OnePos.Api.Data;
using OnePos.Api.Erp;
using OnePos.Api.Platform;

namespace OnePos.Api.Pos;

/// <summary>
/// Stock requests (STR50). An outlet asks a store (from the company's list, kept by an administrator) for any FACTS item; the request
/// waits for the branch's request approver (company administrators can stand in), who can change quantities, then approve or reject.
/// Approved, it goes to FACTS at once as a POSTED STR50 from the store to the outlet (usp_ONEPOS_PostTransferRequest), as the
/// approver's FACTS username. The store sends it with STV50s as today; those point back at the STR50's lines, so each line shows what
/// arrived. A branch without a request approver has no Requests tab.
/// </summary>
public static class StockRequests
{
    public sealed record NewLine(string ItemCode, decimal Qty);
    public sealed record RequestBody(string StoreCode, DateOnly? NeededBy, string? Note, NewLine[] Lines);
    public sealed record ApproveLine(Guid Id, decimal Qty);
    public sealed record ApproveBody(ApproveLine[] Lines, string? Note);
    public sealed record RejectBody(string Note);
    public sealed record StoreBody(string Code, string? Name, bool? IsActive);
    public sealed record ApprovalBody(Guid? ApproverId, string? Email, string? FactsUser);

    private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;
    private static readonly JsonSerializerOptions Web = new(JsonSerializerDefaults.Web);

    public sealed class RequestRow
    {
        public Guid Id { get; set; }
        public Guid BranchId { get; set; }
        public int Number { get; set; }
        public DateOnly BusinessDate { get; set; }
        public string StoreCode { get; set; } = "";
        public string StoreName { get; set; } = "";
        public DateOnly? NeededBy { get; set; }
        public string? Note { get; set; }
        public Guid RequestedBy { get; set; }
        public string RequestedByName { get; set; } = "";
        public DateTime RequestedAt { get; set; }
        public string Approval { get; set; } = "";
        public string? DecidedByName { get; set; }
        public string? DecisionNote { get; set; }
        public string ErpStatus { get; set; } = "";
        public string? ErpDoc { get; set; }
        public string BranchCode { get; set; } = "";
        public string BranchName { get; set; } = "";
        public string? Loc { get; set; }
        public Guid? ApproverId { get; set; }
        public string? FactsUser { get; set; }
        public DateTime? RemindedAt { get; set; }
    }

    public sealed class LineRow
    {
        public Guid Id { get; set; }
        public Guid RequestId { get; set; }
        public int Line { get; set; }
        public string ItemType { get; set; } = "";
        public string ItemCode { get; set; } = "";
        public string ItemName { get; set; } = "";
        public string? Unit { get; set; }
        public decimal Qty { get; set; }
        public decimal? RequestedQty { get; set; }
    }

    private const string RowSql = """
        select r.*, u.display_name as requested_by_name, d.display_name as decided_by_name, b.code as branch_code, b.name as branch_name,
               b.erp_location_code as loc, b.request_approver_id as approver_id, b.request_facts_user as facts_user
        from stock_request r join branch b on b.id = r.branch_id join app_user u on u.id = r.requested_by left join app_user d on d.id = r.decided_by
        """;

    /// <summary>The branch can ask for stock: FACTS-linked with its location, and a request approver who has a FACTS username.</summary>
    private static async Task<(bool On, string? Loc, string? Approver, string? Email)> SetupAsync(NpgsqlConnection c, NpgsqlTransaction tx, Guid branchId)
    {
        var s = await c.QuerySingleAsync<(string Connector, string? Loc, Guid? ApproverId, string? FactsUser, string? Email, string? Approver)>("""
            select co.erp_connector, b.erp_location_code, b.request_approver_id, b.request_facts_user, b.request_approval_email, u.display_name
            from branch b join company co on co.id = b.company_id left join app_user u on u.id = b.request_approver_id where b.id = @branchId
            """, new { branchId }, tx);
        return (s.Connector == "facts" && s.Loc is not null && s.ApproverId is not null && !string.IsNullOrWhiteSpace(s.FactsUser), s.Loc, s.Approver, s.Email);
    }

    private static async Task<List<LineRow>> LinesAsync(NpgsqlConnection c, NpgsqlTransaction tx, Guid[] ids) =>
        ids.Length == 0 ? [] : (await c.QueryAsync<LineRow>("select * from stock_request_line where request_id = any(@ids) order by request_id, line", new { ids }, tx)).ToList();

    /// <summary>What arrived against posted requests: each STR50 line's "after document" quantity (FACTS adds every STV50 sent against it).</summary>
    private static async Task<Dictionary<(string Doc, int Line), decimal>> DeliveredAsync(FactsSync facts, Guid companyId, IEnumerable<string?> docs)
    {
        var nos = docs.Where(d => d is not null && d.StartsWith("STR50 ")).Select(d => d![6..]).Distinct().ToArray();
        if (nos.Length == 0) return [];
        try
        {
            await using var f = await facts.OpenAsync(companyId);
            var rows = await f.QueryAsync<(string DocNo, int Line, decimal After)>("""
                select ltrim(rtrim(d.TSFDET_DOCNO)), d.TSFDET_DOCSRNO, isnull(d.TSFDET_AFTER_DOC_QTY, 0) from TRANSFER_DETAILS d
                where d.TSFDET_DOCTYPE = 'STR50' and d.TSFDET_DOCNO in (select value from string_split(@nos, ','))
                """, new { nos = string.Join(',', nos) }, commandTimeout: 30);
            return rows.ToDictionary(r => ($"STR50 {r.DocNo}", r.Line), r => r.After);
        }
        catch (Exception e) when (e is SqlException or InvalidOperationException) { return []; }   // FACTS away: the list still shows
    }

    private static object Shape(RequestRow r, List<LineRow> lines, Dictionary<(string, int), decimal> delivered)
    {
        var mine = lines.Where(l => l.RequestId == r.Id).ToList();
        decimal? Got(LineRow l) => r.ErpDoc is { } d && delivered.TryGetValue((d, l.Line), out var q) ? q : null;
        var got = mine.Select(Got).ToList();
        // Posted: what the store sent so far, line by line.
        var delivery = r.ErpStatus != "posted" || got.All(g => g is null) ? null
            : mine.Zip(got).All(x => (x.Second ?? 0) >= x.First.Qty) ? "delivered" : got.Any(g => g > 0) ? "part" : "waiting";
        return new
        {
            r.Id, number = $"REQ-{r.Number}", r.BusinessDate, r.StoreCode, r.StoreName, r.NeededBy, r.Note, r.RequestedByName, r.RequestedAt,
            r.Approval, r.DecidedByName, r.DecisionNote, r.ErpStatus, r.ErpDoc, r.BranchName, delivery, r.RemindedAt,
            lines = mine.Select(l => new { l.Id, l.ItemCode, l.ItemName, l.Unit, l.Qty, l.RequestedQty, delivered = Got(l) }),
        };
    }

    private static bool MayDecide(Scope scope, Guid? approverId) => scope.IsAdmin || approverId == scope.UserId;

    public static void Map(RouteGroupBuilder api)
    {
        // The Requests tab: the branch's requests over the last days, the stores it can ask, and who approves.
        api.MapGet("/stock/requests", async (HttpContext http, Db db, FactsSync facts, int? days) =>
        {
            var scope = await http.ScopeAsync(db);
            if (!scope.Can("kitchen.view") && !scope.Can("facts.post")) scope.Require("pos.sell");
            var (setup, stores, rows, lines) = await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var s = await SetupAsync(c, tx, scope.Branch);
                var st = (await c.QueryAsync<(string Code, string Name)>("select code, name from request_store where is_active order by name", null, tx)).ToList();
                var rs = (await c.QueryAsync<RequestRow>($"{RowSql} where r.branch_id = @b and r.requested_at >= now() - make_interval(days => @days) order by r.requested_at desc",
                    new { b = scope.Branch, days = Math.Clamp(days ?? 14, 1, 180) }, tx)).ToList();
                return (s, st, rs, await LinesAsync(c, tx, rs.Select(r => r.Id).ToArray()));
            });
            var delivered = await DeliveredAsync(facts, scope.CompanyId, rows.Select(r => r.ErpDoc));
            return Results.Ok(new
            {
                enabled = setup.On, location = setup.Loc, approver = setup.Approver, stores = stores.Select(x => new { x.Code, x.Name }),
                requests = rows.Select(r => Shape(r, lines, delivered)),
            });
        });

        // Any FACTS item of the company's item master, by code or name, to ask for.
        api.MapGet("/stock/requests/items", async (string? q, HttpContext http, Db db, FactsSync facts) =>
        {
            var scope = await http.ScopeAsync(db);
            if (!scope.Can("kitchen.view")) scope.Require("pos.sell");
            var term = (q ?? "").Trim();
            if (term.Length < 2) return Results.Ok(Array.Empty<object>());
            var master = await db.Company(scope.CompanyId, (c, tx) => c.ExecuteScalarAsync<string?>("select facts_item_master from company where id = @id", new { id = scope.CompanyId }, tx));
            await using var f = await facts.OpenAsync(scope.CompanyId);
            var rows = await f.QueryAsync<(string Code, string Name, string Type, string Unit)>("""
                select top 30 ltrim(rtrim(m.STKMST_DOCNO)), m.STKMST_DESC, ltrim(rtrim(m.STKMST_DOCTYPE)), ltrim(rtrim(m.STKMST_UNIT_DOCNO))
                from STOCK_MASTER m
                where m.STKMST_ACTIVE_STATUS = 0 and (@master is null or m.STKMST_DOCTYPE = @master)
                  and (m.STKMST_DOCNO = @term or m.STKMST_DOCNO like @prefix or m.STKMST_DESC like @like)
                order by case when m.STKMST_DOCNO = @term then 0 when m.STKMST_DOCNO like @prefix then 1 else 2 end, m.STKMST_DESC
                """, new { master, term, prefix = term + "%", like = "%" + term.Replace("%", "[%]").Replace("_", "[_]") + "%" }, commandTimeout: 30);
            return Results.Ok(rows.Select(r => new { code = r.Code, name = r.Name.Trim(), type = r.Type, unit = r.Unit }));
        });

        // Ask a store for stock: it waits for the branch's request approver (under the bell and by email).
        api.MapPost("/stock/requests", async (RequestBody body, HttpContext http, Db db, FactsSync facts, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            if (!scope.Can("kitchen.view")) scope.Require("pos.sell");
            var lines = (body.Lines ?? []).Where(l => !string.IsNullOrWhiteSpace(l.ItemCode)).Select(l => l with { ItemCode = l.ItemCode.Trim() }).ToList();
            if (lines.Count == 0) throw new DomainException("Add at least one item.");
            if (lines.Any(l => l.Qty <= 0)) throw new DomainException("Every item needs a quantity above zero.");
            if (lines.GroupBy(l => l.ItemCode).Any(g => g.Count() > 1)) throw new DomainException("An item is listed twice: put its whole quantity on one line.");
            if (lines.Count > 200) throw new DomainException("At most 200 items in one request.");
            var note = string.IsNullOrWhiteSpace(body.Note) ? null : body.Note.Trim();
            if (note is { Length: > 150 }) throw new DomainException("Keep the note under 150 characters (the store sees it in FACTS).");
            var (setup, store, master, today) = await db.Company(scope.CompanyId, async (c, tx) => (
                await SetupAsync(c, tx, scope.Branch),
                (await c.QueryAsync<(string Code, string Name)>("select code, name from request_store where code = @code and is_active", new { code = (body.StoreCode ?? "").Trim() }, tx)).FirstOrDefault(),
                await c.ExecuteScalarAsync<string?>("select facts_item_master from company where id = @co", new { co = scope.CompanyId }, tx),
                await Days.DateAsync(c, tx, scope.Branch)));
            if (!setup.On) throw new DomainException("Requests need an approver: set this branch's request approver and their FACTS username (Companies & branches).");
            if (store.Code is null) throw new DomainException("Choose the store to ask.");
            if (store.Code == setup.Loc) throw new DomainException("That store is this branch's own location.");
            if (body.NeededBy is { } nb && nb < today) throw new DomainException("The needed-by date is already past.");

            // The items as FACTS has them (name, type, unit): a code FACTS doesn't know is refused.
            List<(string Code, string Name, string Type, string Unit)> known;
            await using (var f = await facts.OpenAsync(scope.CompanyId))
                known = (await f.QueryAsync<(string, string, string, string)>("""
                    select ltrim(rtrim(m.STKMST_DOCNO)), ltrim(rtrim(m.STKMST_DESC)), ltrim(rtrim(m.STKMST_DOCTYPE)), ltrim(rtrim(m.STKMST_UNIT_DOCNO)) from STOCK_MASTER m
                    where m.STKMST_ACTIVE_STATUS = 0 and (@master is null or m.STKMST_DOCTYPE = @master) and ltrim(rtrim(m.STKMST_DOCNO)) in (select value from string_split(@codes, ','))
                    """, new { master, codes = string.Join(',', lines.Select(l => l.ItemCode)) }, commandTimeout: 30)).ToList();
            var missing = lines.Where(l => known.All(k => k.Code != l.ItemCode)).Select(l => l.ItemCode).ToList();
            if (missing.Count > 0) throw new DomainException($"Not FACTS items (or not active): {string.Join(", ", missing)}.");

            var (id, number) = await db.Company(scope.CompanyId, async (c, tx) =>
            {
                await c.ExecuteAsync("select pg_advisory_xact_lock(hashtext('stock_request:' || @b::text))", new { b = scope.Branch }, tx);
                var n = await c.ExecuteScalarAsync<int>("select coalesce(max(number), 0) + 1 from stock_request where branch_id = @b", new { b = scope.Branch }, tx);
                var rid = await c.ExecuteScalarAsync<Guid>("""
                    insert into stock_request (company_id, branch_id, number, business_date, store_code, store_name, needed_by, note, requested_by)
                    values (@co, @b, @n, @today, @Code, @Name, @neededBy, @note, @u) returning id
                    """, new { co = scope.CompanyId, b = scope.Branch, n, today, store.Code, store.Name, neededBy = body.NeededBy, note, u = scope.UserId }, tx);
                var i = 0;
                foreach (var l in lines)
                {
                    var k = known.First(x => x.Code == l.ItemCode);
                    await c.ExecuteAsync("""
                        insert into stock_request_line (company_id, request_id, line, item_type, item_code, item_name, unit, qty)
                        values (@co, @rid, @line, @Type, @Code, @Name, @Unit, @qty)
                        """, new { co = scope.CompanyId, rid, line = ++i, k.Type, k.Code, k.Name, k.Unit, qty = l.Qty }, tx);
                }
                var what = lines.Select(l => { var k = known.First(x => x.Code == l.ItemCode); return $"{l.Qty.ToString("0.###", Inv)} {k.Unit} {k.Name}"; }).ToList();
                await Audit.RecordAsync(c, tx, scope.CompanyId, scope.Branch, scope.UserId, "stock_request", rid.ToString(), "recorded",
                    $"REQ-{n} to {store.Name} ({store.Code}): {lines.Count} item{(lines.Count == 1 ? "" : "s")}", note: note);
                var (by, branchName) = await c.QuerySingleAsync<(string, string)>("select (select display_name from app_user where id = @u), (select name from branch where id = @b)", new { u = scope.UserId, b = scope.Branch }, tx);
                var noticeLines = new List<Notices.Line> { new("From store", $"{store.Name} ({store.Code})"), new("Requested by", by), new("Branch", branchName) };
                if (body.NeededBy is { } need) noticeLines.Add(new("Needed by", need.ToString("dd MMM yyyy", Inv)));
                if (note is not null) noticeLines.Add(new("Note", note));
                noticeLines.AddRange(what.Select(w => new Notices.Line("Item", w)));
                var smtp = await c.ExecuteScalarAsync<bool>("select smtp_settings is not null from company where id = @co", new { co = scope.CompanyId }, tx);
                var emailTo = setup.Email is { Length: > 0 } e ? new[] { e } : [];
                await c.ExecuteAsync("""
                    insert into notice (company_id, branch_id, business_date, kind, title, lines, email_status, email_to, link)
                    values (@co, @b, @today, 'request', @title, cast(@lines as jsonb), @email, @emailTo, '/approvals')
                    """, new
                    {
                        co = scope.CompanyId, b = scope.Branch, today, title = $"Stock request to approve · REQ-{n} · {lines.Count} item{(lines.Count == 1 ? "" : "s")} from {store.Name}",
                        lines = JsonSerializer.Serialize(noticeLines, Web), email = smtp && emailTo.Length > 0 ? "pending" : "none", emailTo,
                    }, tx);
                return (rid, n);
            });
            await live.ToBranch(scope.Branch, "stock.changed");
            return Results.Ok(new { id, number = $"REQ-{number}" });
        });

        // Changed my mind, while it waits: the person who asked, or a manager.
        api.MapPost("/stock/requests/{id:guid}/cancel", async (Guid id, HttpContext http, Db db, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var r = await c.QuerySingleOrDefaultAsync<RequestRow>($"{RowSql} where r.id = @id and r.branch_id = @b for update of r", new { id, b = scope.Branch }, tx)
                    ?? throw new NotFoundException("Request not found.");
                if (r.Approval != "waiting") throw new DomainException(r.Approval == "approved" ? "This was approved and posted in FACTS; ask the store to cancel it there." : "This request was decided already.");
                if (!scope.Can("day.manage") && r.RequestedBy != scope.UserId) throw new ForbiddenException("Only a manager can cancel someone else's request.");
                await c.ExecuteAsync("update stock_request set approval = 'cancelled', decided_by = @u, decided_at = now() where id = @id", new { id, u = scope.UserId }, tx);
                await Audit.RecordAsync(c, tx, scope.CompanyId, scope.Branch, scope.UserId, "stock_request", id.ToString(), "cancelled", $"REQ-{r.Number} cancelled");
                return 0;
            });
            await live.ToBranch(scope.Branch, "stock.changed");
            return Results.Ok(new { id });
        });

        // Waiting for me: the branches I approve requests for (an administrator sees all), each line with the stock at the outlet and the store.
        api.MapGet("/requests/approvals", async (HttpContext http, Db db, FactsSync facts) =>
        {
            var scope = await http.ScopeAsync(db);
            var (isApprover, rows, lines) = await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var rs = (await c.QueryAsync<RequestRow>($"{RowSql} where r.approval = 'waiting' and (@admin or b.request_approver_id = @u) order by r.requested_at",
                    new { admin = scope.IsAdmin, u = scope.UserId }, tx)).ToList();
                var approver = scope.IsAdmin || await c.ExecuteScalarAsync<bool>("select exists (select 1 from branch where request_approver_id = @u)", new { u = scope.UserId }, tx);
                return (approver, rs, await LinesAsync(c, tx, rs.Select(r => r.Id).ToArray()));
            });
            // Stock now in FACTS (batches with stock, in the item's base unit) at the outlet and at the store asked.
            var stock = new Dictionary<(string Loc, string Code), decimal>();
            if (rows.Count > 0)
                try
                {
                    await using var f = await facts.OpenAsync(scope.CompanyId);
                    foreach (var g in rows.SelectMany(r => new[] { r.Loc, r.StoreCode }.Where(l => l is not null).Select(loc => (Loc: loc!, r.Id))).GroupBy(x => x.Loc))
                    {
                        var codes = string.Join(',', lines.Where(l => g.Any(x => x.Id == l.RequestId)).Select(l => l.ItemCode).Distinct());
                        foreach (var (code, qty) in await f.QueryAsync<(string, decimal)>("""
                                select value, (select isnull(sum(b.BATMST_CLSQTY), 0) from dbo.fn_BatchNoUnique(value, @loc) b where b.BATMST_CLSQTY > 0) from string_split(@codes, ',')
                                """, new { loc = g.Key, codes }, commandTimeout: 60))
                            stock[(g.Key, code)] = qty;
                    }
                }
                catch (Exception e) when (e is SqlException or InvalidOperationException) { }   // FACTS away: decide without the stock figures
            decimal? At(string? loc, string code) => loc is not null && stock.TryGetValue((loc, code), out var q) ? q : null;
            return Results.Ok(new
            {
                isApprover,
                items = rows.Select(r => new
                {
                    r.Id, number = $"REQ-{r.Number}", r.BranchName, r.StoreCode, r.StoreName, r.NeededBy, r.Note, r.RequestedByName, r.RequestedAt,
                    lines = lines.Where(l => l.RequestId == r.Id).Select(l => new { l.Id, l.ItemCode, l.ItemName, l.Unit, l.Qty, atOutlet = At(r.Loc, l.ItemCode), atStore = At(r.StoreCode, l.ItemCode) }),
                }),
            });
        });

        // Approve, with quantities as the approver set them (0 takes a line off): posted in FACTS as an STR50 straight away.
        api.MapPost("/requests/approvals/{id:guid}/approve", async (Guid id, ApproveBody body, HttpContext http, Db db, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            var branchId = await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var r = await c.QuerySingleOrDefaultAsync<RequestRow>($"{RowSql} where r.id = @id for update of r", new { id }, tx) ?? throw new NotFoundException("Request not found.");
                if (r.Approval != "waiting") throw new DomainException("This request was decided already, or cancelled. Refresh and try again.");
                if (!MayDecide(scope, r.ApproverId)) throw new ForbiddenException("You don't approve requests for that branch.");
                if (r.Loc is null || string.IsNullOrWhiteSpace(r.FactsUser)) throw new DomainException($"Set the request approver's FACTS username for {r.BranchName} first (Companies & branches).");
                var lines = await LinesAsync(c, tx, [id]);
                var qtyOf = (body.Lines ?? []).ToDictionary(l => l.Id, l => l.Qty);
                if (qtyOf.Values.Any(q => q < 0)) throw new DomainException("A quantity can't be below zero.");
                decimal Qty(LineRow l) => qtyOf.TryGetValue(l.Id, out var q) ? q : l.Qty;
                var keep = lines.Where(l => Qty(l) > 0).ToList();
                if (keep.Count == 0) throw new DomainException("Every quantity is zero: reject the request instead.");
                var note = string.IsNullOrWhiteSpace(body.Note) ? null : body.Note.Trim();

                // Lines taken off go; the rest are numbered again in order (their numbers are the STR50's lines).
                await c.ExecuteAsync("delete from stock_request_line where request_id = @id and not (id = any(@keep))", new { id, keep = keep.Select(l => l.Id).ToArray() }, tx);
                await c.ExecuteAsync("update stock_request_line set line = -line where request_id = @id", new { id }, tx);
                var i = 0;
                foreach (var l in keep)
                    await c.ExecuteAsync("update stock_request_line set line = @n, requested_qty = case when @q <> qty then coalesce(requested_qty, qty) end, qty = @q where id = @Id",
                        new { n = ++i, q = Qty(l), l.Id }, tx);
                var changed = lines.Where(l => Qty(l) != l.Qty).Select(l => $"{l.ItemName} {l.Qty.ToString("0.###", Inv)} → {Qty(l).ToString("0.###", Inv)}").ToList();
                await c.ExecuteAsync("update stock_request set approval = 'approved', decided_by = @u, decided_at = now(), decision_note = @note where id = @id", new { id, u = scope.UserId, note }, tx);
                await Audit.RecordAsync(c, tx, scope.CompanyId, r.BranchId, scope.UserId, "stock_request", id.ToString(), "approved",
                    $"REQ-{r.Number} approved: {keep.Count} item{(keep.Count == 1 ? "" : "s")} from {r.StoreCode}{(changed.Count > 0 ? $" (changed: {string.Join("; ", changed)})" : "")}", note: note);

                // The narration the store sees in FACTS: our number, when it's needed, and the outlet's note.
                var reference = $"One POS {r.BranchCode} REQ-{r.Number}{(r.NeededBy is { } nb ? $" for {nb.ToString("dd MMM", Inv)}" : "")}{(r.Note is { } n ? $" · {n}" : "")}";
                if (reference.Length > 200) reference = reference[..197] + "...";
                var day = await Days.DateAsync(c, tx, r.BranchId);
                var xml = new XElement("data", new XElement("Transfer",
                    new XElement("DocDate", day.ToString("yyyy-MM-dd", Inv)), new XElement("FromLocation", r.StoreCode), new XElement("ToLocation", r.Loc),
                    new XElement("Reference", reference),
                    keep.Select(l => new XElement("Line", new XElement("ItemType", l.ItemType), new XElement("ItemCode", l.ItemCode), new XElement("ItemName", l.ItemName),
                        new XElement("Qty", Qty(l).ToString("0.###", Inv)), new XElement("Unit", l.Unit ?? "PCS")))));
                var postId = Guid.NewGuid();
                await c.ExecuteAsync("""
                    insert into erp_post (id, company_id, branch_id, kind, doc_no, business_date, amount, xml, status, facts_user)
                    values (@postId, @co, @b, 'request', @docNo, @day, 0, @xml, 'pending', @user)
                    """, new { postId, co = scope.CompanyId, b = r.BranchId, docNo = $"{r.BranchCode} REQ-{r.Number}", day, xml = xml.ToString(SaveOptions.DisableFormatting), user = r.FactsUser!.Trim() }, tx);
                await c.ExecuteAsync("update stock_request set erp_post_id = @postId, erp_status = 'pending' where id = @id", new { postId, id }, tx);
                return r.BranchId;
            });
            FactsPosting.Sender.Wake();
            await live.ToBranch(branchId, "stock.changed");
            return Results.Ok(new { id });
        });

        // Reject: nothing goes to FACTS; the reason is shown to the branch.
        api.MapPost("/requests/approvals/{id:guid}/reject", async (Guid id, RejectBody body, HttpContext http, Db db, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            if (string.IsNullOrWhiteSpace(body.Note)) throw new DomainException("Say why it's rejected (the branch sees it).");
            var branchId = await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var r = await c.QuerySingleOrDefaultAsync<RequestRow>($"{RowSql} where r.id = @id for update of r", new { id }, tx) ?? throw new NotFoundException("Request not found.");
                if (r.Approval != "waiting") throw new DomainException("This request was decided already, or cancelled. Refresh and try again.");
                if (!MayDecide(scope, r.ApproverId)) throw new ForbiddenException("You don't approve requests for that branch.");
                await c.ExecuteAsync("update stock_request set approval = 'rejected', decided_by = @u, decided_at = now(), decision_note = @note where id = @id",
                    new { id, u = scope.UserId, note = body.Note.Trim() }, tx);
                await Audit.RecordAsync(c, tx, scope.CompanyId, r.BranchId, scope.UserId, "stock_request", id.ToString(), "rejected", $"REQ-{r.Number} rejected", note: body.Note.Trim());
                return r.BranchId;
            });
            await live.ToBranch(branchId, "stock.changed");
            return Results.Ok(new { id });
        });

        // The stores outlets can ask (FACTS locations), kept by an administrator; one switched off stays in old requests.
        api.MapGet("/companies/{companyId:guid}/request-stores", async (Guid companyId, HttpContext http, Db db) =>
        {
            var scope = await http.ScopeAsync(db, companyId);
            scope.Require("branch.manage");
            var rows = await db.Company(companyId, (c, tx) => c.QueryAsync<(Guid Id, string Code, string Name, bool IsActive)>(
                "select id, code, name, is_active from request_store order by is_active desc, name", null, tx));
            return Results.Ok(rows.Select(x => new { x.Id, x.Code, x.Name, x.IsActive }));
        });

        // Add a store, or change its name or switch it on/off: the code must be a FACTS location (its FACTS name is the default name).
        api.MapPut("/companies/{companyId:guid}/request-stores", async (Guid companyId, StoreBody body, HttpContext http, Db db, FactsSync facts) =>
        {
            var scope = await http.ScopeAsync(db, companyId);
            scope.Require("branch.manage");
            var code = (body.Code ?? "").Trim().ToUpperInvariant();
            if (!Regex.IsMatch(code, "^[A-Z0-9._-]{1,20}$")) throw new DomainException("Enter the store's FACTS location code (e.g. 5ALK1).");
            string? factsName;
            await using (var f = await facts.OpenAsync(companyId))
                factsName = await f.ExecuteScalarAsync<string?>("select ltrim(rtrim(LOC_DESC)) from LOCATION_MASTER where ltrim(rtrim(LOC_DOCNO)) = @code", new { code }, commandTimeout: 30);
            if (factsName is null) throw new DomainException($"{code} isn't a FACTS location.");
            var name = string.IsNullOrWhiteSpace(body.Name) ? factsName : body.Name.Trim();
            await db.Company(companyId, async (c, tx) =>
            {
                var old = (await c.QueryAsync<(string Name, bool IsActive)>("select name, is_active from request_store where code = @code", new { code }, tx)).Select(x => ((string Name, bool IsActive)?)x).FirstOrDefault();
                await c.ExecuteAsync("""
                    insert into request_store (company_id, code, name, is_active) values (@co, @code, @name, coalesce(@active, true))
                    on conflict (company_id, code) do update set name = excluded.name, is_active = coalesce(@active, request_store.is_active)
                    """, new { co = companyId, code, name, active = body.IsActive }, tx);
                await Audit.RecordAsync(c, tx, companyId, null, scope.UserId, "request_store", code, old is null ? "created" : "changed", $"Request store {code}: {name}",
                    [new("Name", old?.Name, name), new("Active", old?.IsActive, body.IsActive ?? old?.IsActive ?? true)]);
                return 0;
            });
            return Results.Ok(new { code, name });
        });

        // Who approves this branch's requests (null approver: off, no Requests tab), where requests are emailed, and the FACTS username
        // the approved STR50 is posted as.
        api.MapPut("/branches/{id:guid}/request-approval", async (Guid id, ApprovalBody body, HttpContext http, Db db, Live live) =>
        {
            var companyId = await db.Platform((c, tx) => c.ExecuteScalarAsync<Guid?>("select company_id from branch where id = @id", new { id }, tx))
                            ?? throw new NotFoundException("Branch not found.");
            var scope = await http.ScopeAsync(db, companyId);
            scope.Require("branch.manage");
            var email = string.IsNullOrWhiteSpace(body.Email) ? null : body.Email.Trim();
            if (email is not null && !MailAddress.TryCreate(email, out _)) throw new DomainException($"\"{email}\" isn't an email address.");
            var factsUser = string.IsNullOrWhiteSpace(body.FactsUser) ? null : body.FactsUser.Trim();
            if (factsUser is { Length: > 20 }) throw new DomainException("A FACTS username has at most 20 characters.");
            var approver = body.ApproverId;
            await db.Company(companyId, async (c, tx) =>
            {
                var old = await c.QuerySingleAsync<(string Code, Guid? Approver, string? Email, string? FactsUser)>(
                    "select code, request_approver_id, request_approval_email, request_facts_user from branch where id = @id for update", new { id }, tx);
                string? name = null;
                if (approver is { } a)
                {
                    name = await c.ExecuteScalarAsync<string?>(
                        "select u.display_name from app_user u where u.id = @a and u.is_active and (u.is_admin or exists (select 1 from user_company uc where uc.user_id = u.id and uc.company_id = @companyId))",
                        new { a, companyId }, tx) ?? throw new DomainException("Choose an active user of this company as the approver.");
                    if (email is null) throw new DomainException($"Enter the email {name}'s stock requests go to.");
                    if (factsUser is null) throw new DomainException("Enter the approver's FACTS username: approved requests are posted in FACTS as that user.");
                }
                var on = approver is not null;
                await c.ExecuteAsync("update branch set request_approver_id = @approver, request_approval_email = @email, request_facts_user = @factsUser where id = @id",
                    new { approver, email = on ? email : null, factsUser = on ? factsUser : null, id }, tx);
                var oldName = old.Approver is { } o ? await c.ExecuteScalarAsync<string?>("select display_name from app_user where id = @o", new { o }, tx) : null;
                await Audit.RecordAsync(c, tx, companyId, id, scope.UserId, "branch", id.ToString(), "changed", $"Branch {old.Code}: stock requests {(on ? "set" : "off")}",
                [
                    new("Request approver", oldName, name), new("Approval email", old.Email, on ? email : null), new("FACTS username", old.FactsUser, on ? factsUser : null),
                ]);
                return 0;
            });
            await live.ToCompany(companyId, "branches.changed");
            return Results.Ok(new { ok = true });
        });
    }
}
