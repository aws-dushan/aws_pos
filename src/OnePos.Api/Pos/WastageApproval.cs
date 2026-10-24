using System.Globalization;
using System.Net.Mail;
using System.Text.Json;
using System.Xml.Linq;
using Dapper;
using Npgsql;
using OnePos.Api.Data;
using OnePos.Api.Erp;
using OnePos.Api.Platform;

namespace OnePos.Api.Pos;

/// <summary>
/// Wastage approval. A branch with a wastage approver (a One POS user, the email the request goes to, and the approver's FACTS
/// username): wastage recorded there waits for that approver (company administrators can stand in). Approved, it goes to FACTS
/// at once as a POSTED STV50 to the branch's wastage location (usp_ONEPOS_PostWastageTransfer: batches FIFO, FACTS' own approval,
/// as the approver's FACTS username), never a draft; approving checks FACTS has the stock first. Rejected, it is taken off and
/// never sent. A branch without an approver works as before.
/// </summary>
public static class WastageApproval
{
    public sealed record ApproveLine(Guid Id, decimal? Qty);
    public sealed record ApproveBody(ApproveLine[] Lines, string? Note);
    public sealed record RejectBody(Guid[] Ids, string Note);

    private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;
    private static readonly JsonSerializerOptions Web = new(JsonSerializerDefaults.Web);
    private static readonly Dictionary<string, string> Reasons = new()
    {
        ["expired"] = "Expired", ["damaged"] = "Damaged", ["quality"] = "Quality", ["returned"] = "Returned", ["staff"] = "Staff meal", ["calibration"] = "Machine calibration", ["other"] = "Other",
    };

    public sealed record Setup(Guid? ApproverId, string? Email, string? FactsUser, string? Loc, string? Waste, string Connector, string Code, string Name);

    public static Task<Setup> SetupAsync(NpgsqlConnection c, NpgsqlTransaction tx, Guid branchId) =>
        c.QuerySingleAsync<Setup>("""
            select b.wastage_approver_id as ApproverId, b.wastage_approval_email as Email, b.wastage_facts_user as FactsUser, b.erp_location_code as Loc,
                   b.erp_waste_location as Waste, co.erp_connector as Connector, b.code as Code, b.name as Name
            from branch b join company co on co.id = b.company_id where b.id = @branchId
            """, new { branchId }, tx);

    /// <summary>Approval applies: an approver is set and the wastage can go to FACTS (linked branch, wastage location, a FACTS item).</summary>
    public static bool Applies(Setup s, string? itemCode) =>
        s.ApproverId is not null && s.Connector == "facts" && s.Loc is not null && s.Waste is not null && itemCode is not null;

    /// <summary>Just recorded (same transaction): waits for the branch's approver, who gets it under the bell and by email.</summary>
    public static async Task RequestAsync(NpgsqlConnection c, NpgsqlTransaction tx, Guid companyId, Guid branchId, Guid wastageId)
    {
        var s = await SetupAsync(c, tx, branchId);
        var w = await c.QuerySingleAsync<(string Name, decimal Qty, string? Unit, string Reason, string? Note, decimal? Value, DateOnly Day, string By, string? Code)>("""
            select w.name, w.qty, w.unit, w.reason, w.note, w.cost_value, w.business_date, u.display_name, i.erp_item_code
            from wastage w join app_user u on u.id = w.recorded_by left join menu_item i on i.id = w.item_id where w.id = @wastageId
            """, new { wastageId }, tx);
        if (!Applies(s, w.Code)) return;
        await c.ExecuteAsync("update wastage set approval = 'waiting' where id = @wastageId", new { wastageId }, tx);
        var cur = await c.ExecuteScalarAsync<string>("select base_currency from company where id = @companyId", new { companyId }, tx);
        var lines = new List<Notices.Line>
        {
            new("Item", w.Name), new("Quantity", $"{w.Qty.ToString("0.###", Inv)} {w.Unit}".Trim()), new("Reason", Reasons.GetValueOrDefault(w.Reason, w.Reason)),
            new("Value", w.Value is { } v ? $"{cur} {v:N2}" : "–"), new("Recorded by", w.By), new("Branch", s.Name),
        };
        if (!string.IsNullOrWhiteSpace(w.Note)) lines.Add(new("Note", w.Note!));
        var smtp = await c.ExecuteScalarAsync<bool>("select smtp_settings is not null from company where id = @companyId", new { companyId }, tx);
        var to = s.Email is { Length: > 0 } e ? new[] { e } : [];
        await c.ExecuteAsync("""
            insert into notice (company_id, branch_id, business_date, kind, title, lines, email_status, email_to, link)
            values (@companyId, @branchId, @day, 'wastage', @title, cast(@lines as jsonb), @email, @to, '/approvals')
            """, new
            {
                companyId, branchId, day = w.Day, title = $"Wastage to approve · {w.Qty.ToString("0.###", Inv)} × {w.Name}",
                lines = JsonSerializer.Serialize(lines, Web), email = smtp && to.Length > 0 ? "pending" : "none", to,
            }, tx);
    }

    private sealed class WaitingRow
    {
        public Guid Id { get; set; }
        public Guid BranchId { get; set; }
        public string BranchCode { get; set; } = "";
        public string BranchName { get; set; } = "";
        public DateOnly BusinessDate { get; set; }
        public Guid ItemId { get; set; }
        public string Name { get; set; } = "";
        public decimal Qty { get; set; }
        public string? Unit { get; set; }
        public string Reason { get; set; } = "";
        public string? Note { get; set; }
        public decimal? CostValue { get; set; }
        public string RecordedByName { get; set; } = "";
        public DateTime RecordedAt { get; set; }
        public string? ItemCode { get; set; }
        public string? ItemType { get; set; }
        public string? ErpUnit { get; set; }
        public Guid? ApproverId { get; set; }
    }

    private const string WaitingSql = """
        select w.id, w.branch_id, b.code as branch_code, b.name as branch_name, w.business_date, w.item_id, w.name, w.qty, w.unit, w.reason, w.note, w.cost_value,
               u.display_name as recorded_by_name, w.recorded_at, i.erp_item_code as item_code, i.erp_item_type as item_type, i.erp_unit, b.wastage_approver_id as approver_id
        from wastage w join branch b on b.id = w.branch_id join app_user u on u.id = w.recorded_by left join menu_item i on i.id = w.item_id
        where w.approval = 'waiting' and w.voided_at is null
        """;

    private static bool MayDecide(Scope scope, Guid? approverId) => scope.IsAdmin || approverId == scope.UserId;

    public static void Map(RouteGroupBuilder api)
    {
        // Waiting for me: the branches I approve wastage for (an administrator sees all).
        api.MapGet("/wastage/approvals", async (HttpContext http, Db db) =>
        {
            var scope = await http.ScopeAsync(db);
            return await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var rows = (await c.QueryAsync<WaitingRow>($"{WaitingSql} and (@admin or b.wastage_approver_id = @u) order by w.recorded_at",
                    new { admin = scope.IsAdmin, u = scope.UserId }, tx)).ToList();
                var cur = await c.ExecuteScalarAsync<string>("select base_currency from company where id = @co", new { co = scope.CompanyId }, tx);
                var approver = await c.ExecuteScalarAsync<bool>("select exists (select 1 from branch where wastage_approver_id = @u)", new { u = scope.UserId }, tx);
                return new
                {
                    currency = cur, isApprover = approver || scope.IsAdmin,
                    items = rows.Select(r => new { r.Id, r.BranchId, r.BranchCode, r.BranchName, r.BusinessDate, r.Name, r.Qty, r.Unit, r.Reason, r.Note, r.CostValue, r.RecordedByName, r.RecordedAt }),
                };
            });
        });

        // Approve (a quantity may be corrected): FACTS must hold the stock; then one posted STV50 per branch and day goes to FACTS.
        api.MapPost("/wastage/approvals/approve", async (ApproveBody body, HttpContext http, Db db, FactsSync facts, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            if (body.Lines is not { Length: > 0 }) throw new DomainException("Choose the wastage to approve.");
            var ids = body.Lines.Select(l => l.Id).Distinct().ToArray();
            var rows = await db.Company(scope.CompanyId, (c, tx) => c.QueryAsync<WaitingRow>($"{WaitingSql} and w.id = any(@ids)", new { ids }, tx));
            var list = rows.ToList();
            if (list.Count != ids.Length) throw new DomainException("Some of these were decided already, or taken off. Refresh and try again.");
            if (list.Any(r => !MayDecide(scope, r.ApproverId))) throw new ForbiddenException("You don't approve wastage for that branch.");
            var qtyOf = body.Lines.Where(l => l.Qty is not null).ToDictionary(l => l.Id, l => l.Qty!.Value);
            foreach (var (id, q) in qtyOf)
                if (q <= 0) throw new DomainException("A quantity must be above zero; reject it instead.");
            decimal Qty(WaitingRow r) => qtyOf.TryGetValue(r.Id, out var q) ? q : r.Qty;

            var setups = new Dictionary<Guid, Setup>();
            await db.Company(scope.CompanyId, async (c, tx) =>
            {
                foreach (var b in list.Select(r => r.BranchId).Distinct()) setups[b] = await SetupAsync(c, tx, b);
                return 0;
            });
            foreach (var r in list)
            {
                var s = setups[r.BranchId];
                if (!Applies(s, r.ItemCode)) throw new DomainException($"{s.Name} can't send wastage to FACTS (FACTS location or wastage location missing, or {r.Name} has no FACTS item).");
                if (string.IsNullOrWhiteSpace(s.FactsUser)) throw new DomainException($"Set the approver's FACTS username for {s.Name} first (Companies & branches).");
            }

            // FACTS must have the stock in its batches at the outlet (the posting takes them FIFO): checked before anything changes.
            var short_ = new List<string>();
            await using (var f = await facts.OpenAsync(scope.CompanyId))
            {
                foreach (var g in list.GroupBy(r => (r.BranchId, r.ItemCode, Unit: r.ErpUnit ?? r.Unit)))
                    if (await ShortAsync(f, g.Key.ItemCode!, setups[g.Key.BranchId].Loc!, g.Max(r => r.BusinessDate), g.Key.Unit, g.Sum(Qty), g.First().Name) is { } s)
                        short_.Add(s);
            }
            if (short_.Count > 0)
                throw new DomainException($"Not enough stock in FACTS: {string.Join("; ", short_)}. Approve less, or wait for the stock (e.g. a transfer) and approve then.");

            var posted = await db.Company(scope.CompanyId, async (c, tx) =>
            {
                // Still waiting (nobody decided it meanwhile).
                var locked = (await c.QueryAsync<Guid>("select id from wastage where id = any(@ids) and approval = 'waiting' and voided_at is null for update", new { ids }, tx)).ToList();
                if (locked.Count != ids.Length) throw new DomainException("Some of these were decided meanwhile. Refresh and try again.");
                var note = string.IsNullOrWhiteSpace(body.Note) ? null : body.Note.Trim();
                foreach (var r in list)
                {
                    var q = Qty(r);
                    if (q != r.Qty)
                    {
                        // A corrected quantity: its value and recipe follow.
                        var price = r.CostValue is { } v && r.Qty > 0 ? v / r.Qty : (decimal?)null;
                        await c.ExecuteAsync("update wastage set requested_qty = qty, qty = @q, cost_value = @value where id = @Id",
                            new { q, value = price is { } p ? Money.Round(p * q) : (decimal?)null, r.Id }, tx);
                        await Recipes.UnwasteItemAsync(c, tx, r.Id, scope.UserId);
                        await Recipes.WasteItemAsync(c, tx, scope.CompanyId, r.BranchId, r.BusinessDate, r.ItemId, q, r.Id, scope.UserId);
                    }
                    await c.ExecuteAsync("update wastage set approval = 'approved', decided_by = @u, decided_at = now(), decision_note = @note where id = @Id",
                        new { u = scope.UserId, note, r.Id }, tx);
                    await Audit.RecordAsync(c, tx, scope.CompanyId, r.BranchId, scope.UserId, "wastage", r.Id.ToString(), "approved",
                        $"Wastage approved: {q.ToString("0.###", Inv)} × {r.Name}{(q != r.Qty ? $" (asked {r.Qty.ToString("0.###", Inv)})" : "")}", note: note);
                }
                // One posted STV50 per branch and business day, as the branch approver's FACTS username.
                var n = 0;
                foreach (var g in list.GroupBy(r => (r.BranchId, r.BusinessDate)))
                {
                    var s = setups[g.Key.BranchId];
                    var postId = Guid.NewGuid();
                    var reference = $"One POS wastage {s.Code} {g.Key.BusinessDate:yyyy-MM-dd} W-{postId.ToString("N")[..8].ToUpperInvariant()}";
                    var xml = new XElement("data", new XElement("Transfer",
                        new XElement("DocDate", g.Key.BusinessDate.ToString("yyyy-MM-dd", Inv)), new XElement("FromLocation", s.Loc), new XElement("ToLocation", s.Waste),
                        new XElement("Reference", reference),
                        g.Select(r => new XElement("Line", new XElement("ItemType", r.ItemType ?? "SMBK"), new XElement("ItemCode", r.ItemCode), new XElement("ItemName", r.Name),
                            new XElement("Qty", Qty(r).ToString("0.###", Inv)), new XElement("Unit", r.ErpUnit ?? r.Unit ?? "PCS")))));
                    await c.ExecuteAsync("""
                        insert into erp_post (id, company_id, branch_id, kind, doc_no, business_date, amount, xml, status, facts_user)
                        values (@postId, @co, @b, 'wastage', @reference, @day, @amount, @xml, 'pending', @user)
                        """, new
                        {
                            postId, co = scope.CompanyId, b = g.Key.BranchId, reference, day = g.Key.BusinessDate, xml = xml.ToString(SaveOptions.DisableFormatting), user = s.FactsUser!.Trim(),
                            amount = (await c.ExecuteScalarAsync<decimal?>("select sum(cost_value) from wastage where id = any(@ids)", new { ids = g.Select(r => r.Id).ToArray() }, tx)) ?? 0,
                        }, tx);
                    await c.ExecuteAsync("update wastage set erp_post_id = @postId, erp_status = 'pending' where id = any(@ids)", new { postId, ids = g.Select(r => r.Id).ToArray() }, tx);
                    n++;
                }
                return n;
            });
            FactsPosting.Sender.Wake();
            foreach (var b in list.Select(r => r.BranchId).Distinct()) await live.ToBranch(b, "stock.changed");
            return Results.Ok(new { approved = list.Count, transfers = posted });
        });

        // Reject: taken off (its recipe goes back), never sent to FACTS; the reason is kept and shown to the branch.
        api.MapPost("/wastage/approvals/reject", async (RejectBody body, HttpContext http, Db db, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            if (body.Ids is not { Length: > 0 }) throw new DomainException("Choose the wastage to reject.");
            if (string.IsNullOrWhiteSpace(body.Note)) throw new DomainException("Say why it's rejected (the branch sees it).");
            var branches = await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var rows = (await c.QueryAsync<WaitingRow>($"{WaitingSql} and w.id = any(@ids) for update of w", new { ids = body.Ids.Distinct().ToArray() }, tx)).ToList();
                if (rows.Count != body.Ids.Distinct().Count()) throw new DomainException("Some of these were decided already, or taken off. Refresh and try again.");
                if (rows.Any(r => !MayDecide(scope, r.ApproverId))) throw new ForbiddenException("You don't approve wastage for that branch.");
                foreach (var r in rows)
                {
                    await c.ExecuteAsync("""
                        update wastage set approval = 'rejected', decided_by = @u, decided_at = now(), decision_note = @note, voided_at = now(), voided_by = @u, erp_status = 'none'
                        where id = @Id
                        """, new { u = scope.UserId, note = body.Note.Trim(), r.Id }, tx);
                    await Recipes.UnwasteItemAsync(c, tx, r.Id, scope.UserId);
                    await Audit.RecordAsync(c, tx, scope.CompanyId, r.BranchId, scope.UserId, "wastage", r.Id.ToString(), "rejected", $"Wastage rejected: {r.Qty.ToString("0.###", Inv)} × {r.Name}", note: body.Note.Trim());
                }
                return rows.Select(r => r.BranchId).Distinct().ToList();
            });
            foreach (var b in branches) await live.ToBranch(b, "stock.changed");
            return Results.Ok(new { rejected = body.Ids.Length });
        });
    }

    /// <summary>
    /// What's missing when FACTS' batches at the outlet don't hold this much of the item (received by that business day, as the
    /// posted transfer takes them FIFO), in the unit asked; null when they do. Used before approving wastage and returns.
    /// </summary>
    public static async Task<string?> ShortAsync(Microsoft.Data.SqlClient.SqlConnection f, string code, string loc, DateOnly day, string? unit, decimal need, string name)
    {
        var have = await f.QuerySingleAsync<(decimal Stock, decimal Factor)>("""
            select isnull((select sum(b.BATMST_CLSQTY) from dbo.fn_BatchNoUnique(@code, @loc) b
                           where b.BATMST_CLSQTY > 0 and (b.BATMST_SDOCDATE is null or b.BATMST_SDOCDATE < @day)), 0),
                   isnull((select top 1 u.STKU_FROM_QTY / nullif(u.STKU_TO_QTY, 0) from STOCK_UNIT u where u.STKU_DOCNO = @code and u.STKU_UNIT_DOCNO = @unit), 1)
            """, new { code, loc, day = day.ToDateTime(TimeOnly.MinValue).AddDays(1), unit = unit ?? "PCS" }, commandTimeout: 60);
        return need * have.Factor > have.Stock
            ? $"{name}: {need.ToString("0.###", Inv)} asked, only {(have.Factor == 0 ? 0 : have.Stock / have.Factor).ToString("0.###", Inv)} {unit} in stock at {loc}"
            : null;
    }

    /// <summary>A branch's approver settings, checked when saved: a user of the company, an email address, a FACTS username.</summary>
    public static (Guid? Approver, string? Email, string? FactsUser) Clean(Guid? approver, string? email, string? factsUser)
    {
        var e = string.IsNullOrWhiteSpace(email) ? null : email.Trim();
        if (e is not null && !MailAddress.TryCreate(e, out _)) throw new DomainException($"\"{e}\" isn't an email address.");
        var u = string.IsNullOrWhiteSpace(factsUser) ? null : factsUser.Trim();
        if (u is { Length: > 20 }) throw new DomainException("A FACTS username has at most 20 characters.");
        if (approver is not null && u is null) throw new DomainException("Enter the approver's FACTS username: approved wastage is posted in FACTS as that user.");
        return (approver, e, u);
    }
}
