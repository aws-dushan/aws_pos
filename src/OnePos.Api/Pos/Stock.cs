using System.Text.Json;
using Dapper;
using OnePos.Api.Data;
using OnePos.Api.Erp;
using OnePos.Api.Platform;

namespace OnePos.Api.Pos;

/// <summary>
/// Branch stock (REQ INV-04, INV-06). Wastage: what the branch throws away, by reason, in the business day; for a branch linked
/// to FACTS it waits to be posted to the outlet's wastage location (nothing is written to FACTS yet). Deliveries: transfers into
/// the branch's FACTS location, read from FACTS (read-only); the branch checks each one in and notes differences. Marketing: finished
/// goods given away (tasting, promotion, influencers, gifts) are recorded the same way (kind 'marketing'), wait for the branch's
/// wastage approver and, approved, go to FACTS as a posted MCV50 to the marketing expense account (WastageApproval).
/// </summary>
public static class Stock
{
    public sealed record WasteBody(Guid ItemId, decimal Qty, string Reason, string? Note, string? Kind = null);
    /// <summary>A line that arrived differently. `Line`: its line on the transfer (an item can be on it twice, e.g. two batches).</summary>
    public sealed record Difference(string Code, string Name, decimal Sent, decimal Received, string? Note, int? Line = null);
    public sealed record PostedBody(string Doc);
    public sealed record CheckBody(string DocType, string DocNo, bool AllOk, Difference[]? Differences, string? Note);
    public sealed record UncheckBody(string DocType, string DocNo, string Reason);

    private static readonly string[] Reasons = ["expired", "damaged", "quality", "returned", "staff", "calibration", "other"];
    private static readonly string[] MarketingReasons = ["tasting", "promotion", "influencer", "gift", "other"];

    public sealed class WasteRow
    {
        public Guid Id { get; set; }
        public DateOnly BusinessDate { get; set; }
        public Guid ItemId { get; set; }
        public string Name { get; set; } = "";
        public decimal Qty { get; set; }
        public string? Unit { get; set; }
        public string Reason { get; set; } = "";
        /// <summary>wastage | marketing (given away; posted as an MCV50 to the marketing expense account).</summary>
        public string Kind { get; set; } = "wastage";
        public string? Note { get; set; }
        public decimal? CostValue { get; set; }
        public string ErpStatus { get; set; } = "";
        public string? ErpDoc { get; set; }
        public string? RecordedByName { get; set; }
        public DateTime RecordedAt { get; set; }
        public DateTime? VoidedAt { get; set; }
        /// <summary>none | waiting (for the branch's wastage approver) | approved | rejected.</summary>
        public string Approval { get; set; } = "none";
        public decimal? RequestedQty { get; set; }
        public string? DecisionNote { get; set; }
        public string? DecidedByName { get; set; }
        /// <summary>The last approval reminder that listed it (waiting too long).</summary>
        public DateTime? RemindedAt { get; set; }
    }

    private const string WasteSql = """
        select w.*, u.display_name as recorded_by_name, d.display_name as decided_by_name from wastage w join app_user u on u.id = w.recorded_by
        left join app_user d on d.id = w.decided_by
        """;

    public sealed record SendBody(DateOnly? Date);

    public static void Map(RouteGroupBuilder api)
    {
        api.MapGet("/stock/wastage", async (HttpContext http, Db db, DateOnly? date, string? kind) =>
        {
            var scope = await http.ScopeAsync(db);
            // Finance reads it too: it posts the wastage in FACTS and notes the document.
            if (!scope.Can("kitchen.view") && !scope.Can("facts.post")) scope.Require("pos.sell");
            return await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var day = date ?? await Days.DateAsync(c, tx, scope.Branch);
                var k = kind == "marketing" ? "marketing" : "wastage";
                var rows = (await c.QueryAsync<WasteRow>($"{WasteSql} where w.branch_id = @b and w.business_date = @day and w.kind = @k order by w.recorded_at desc", new { b = scope.Branch, day, k }, tx)).ToList();
                var live = rows.Where(r => r.VoidedAt is null).ToList();
                return new
                {
                    date = day, wastage = rows,
                    byReason = live.GroupBy(r => r.Reason).Select(g => new { reason = g.Key, lines = g.Count(), value = g.Sum(r => r.CostValue ?? 0) }),
                    total = live.Sum(r => r.CostValue ?? 0),
                    erpLinked = await c.ExecuteScalarAsync<bool>("select erp_location_code is not null from branch where id = @b", new { b = scope.Branch }, tx),
                    // How wastage reaches FACTS: finance enters it, or One POS sends a draft STV50 (to the branch's wastage location).
                    // Wastage approval at this branch: who approves (then it's posted in FACTS once approved).
                    approver = await c.ExecuteScalarAsync<string?>("select u.display_name from branch b join app_user u on u.id = b.wastage_approver_id where b.id = @b and b.erp_location_code is not null and b.erp_waste_location is not null", new { b = scope.Branch }, tx),
                    factsWastage = await c.ExecuteScalarAsync<string>("select case when co.facts_wastage = 'draft' and b.erp_waste_location is not null then 'draft' else 'finance' end from branch b join company co on co.id = b.company_id where b.id = @b", new { b = scope.Branch }, tx),
                    // Marketing: who approves it here (null = it can't be recorded: no approver, or the branch isn't linked to FACTS).
                    marketingApprover = await c.ExecuteScalarAsync<string?>("""
                        select u.display_name from branch b join company co on co.id = b.company_id join app_user u on u.id = b.marketing_approver_id
                        where b.id = @b and co.erp_connector = 'facts' and b.marketing_account is not null and b.erp_location_code is not null
                        """, new { b = scope.Branch }, tx),
                };
            });
        });

        api.MapPost("/stock/wastage", async (WasteBody body, HttpContext http, Db db, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            if (!scope.Can("kitchen.view")) scope.Require("pos.sell");
            var reason = (body.Reason ?? "").Trim().ToLowerInvariant();
            var marketing = body.Kind == "marketing";
            if (!(marketing ? MarketingReasons : Reasons).Contains(reason)) throw new DomainException(marketing ? "Choose what it was given away for." : "Choose why it was thrown away.");
            if (reason == "other" && string.IsNullOrWhiteSpace(body.Note)) throw new DomainException("Say what happened.");
            var row = await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var item = await c.QuerySingleOrDefaultAsync<(Guid Id, string Name, decimal Price, decimal? BranchPrice, int Decimals, string? Unit, string? Code)>("""
                    select i.id, i.name, i.price, bi.price, i.qty_decimals, i.erp_unit, i.erp_item_code from menu_item i
                    left join branch_item bi on bi.item_id = i.id and bi.branch_id = @b where i.id = @ItemId
                    """, new { b = scope.Branch, body.ItemId }, tx);
                if (item.Id == Guid.Empty) throw new DomainException("That item isn't on the menu.");
                Orders.CheckQty(body.Qty, item.Decimals, item.Name);
                var day = (await Days.CurrentAsync(c, tx, scope.Branch, scope.UserId)).Date;
                var linked = await c.ExecuteScalarAsync<bool>("select erp_location_code is not null from branch where id = @b", new { b = scope.Branch }, tx);
                if (marketing)
                {
                    // Marketing always goes to FACTS (an MCV50 once approved): FACTS must be set up for it.
                    var on = await c.ExecuteScalarAsync<bool>("""
                        select co.erp_connector = 'facts' and b.marketing_account is not null and b.marketing_approver_id is not null
                        from branch b join company co on co.id = b.company_id where b.id = @b
                        """, new { b = scope.Branch }, tx);
                    if (!on || !linked) throw new DomainException("Marketing isn't set up at this branch: its FACTS location, marketing approver and expense account (Companies & branches).");
                    if (item.Code is null) throw new DomainException($"{item.Name} has no FACTS item, so it can't go to FACTS as marketing.");
                }
                var price = item.BranchPrice ?? item.Price;
                var id = await c.ExecuteScalarAsync<Guid>("""
                    insert into wastage (company_id, branch_id, business_date, item_id, name, qty, unit, reason, note, cost_value, erp_status, recorded_by, kind)
                    values (@co, @b, @day, @itemId, @name, @qty, @unit, @reason, @note, @value, @erp, @u, @kind) returning id
                    """, new
                    {
                        co = scope.CompanyId, b = scope.Branch, day, itemId = item.Id, name = item.Name, qty = body.Qty, unit = item.Unit, reason,
                        note = string.IsNullOrWhiteSpace(body.Note) ? null : body.Note.Trim(), value = price > 0 ? Money.Round(price * body.Qty) : (decimal?)null,
                        erp = linked && item.Code is not null ? "pending" : "none", u = scope.UserId, kind = marketing ? "marketing" : "wastage",
                    }, tx);
                await Recipes.WasteItemAsync(c, tx, scope.CompanyId, scope.Branch, day, item.Id, body.Qty, id, scope.UserId);
                await Audit.RecordAsync(c, tx, scope.CompanyId, scope.Branch, scope.UserId, "wastage", id.ToString(), "recorded", $"{(marketing ? "Marketing" : "Wastage")}: {body.Qty:0.###} × {item.Name} ({reason})", note: body.Note);
                // A branch with a wastage approver: it waits for them (bell and email); approved, it is posted in FACTS.
                await WastageApproval.RequestAsync(c, tx, scope.CompanyId, scope.Branch, id);
                return await c.QuerySingleAsync<WasteRow>($"{WasteSql} where w.id = @id", new { id }, tx);
            });
            await live.ToBranch(scope.Branch, "stock.changed");
            return Results.Ok(row);
        });

        // A mistake: the person who recorded it (same day) or a manager takes it off. Posted wastage stays (correct it in the ERP).
        api.MapPost("/stock/wastage/{id:guid}/void", async (Guid id, HttpContext http, Db db, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var w = await c.QuerySingleOrDefaultAsync<(Guid By, DateOnly Day, string Erp, DateTime? Voided, string Name)>(
                    "select recorded_by, business_date, erp_status, voided_at, name from wastage where id = @id and branch_id = @b for update", new { id, b = scope.Branch }, tx);
                if (w.By == Guid.Empty) throw new NotFoundException("Wastage record not found.");
                if (w.Voided is not null) throw new DomainException("Already taken off.");
                if (w.Erp == "posted") throw new DomainException("This was posted to the ERP; correct it there.");
                if (await c.ExecuteScalarAsync<string>("select approval from wastage where id = @id", new { id }, tx) == "approved")
                    throw new DomainException("This was approved and goes to FACTS as a posted transfer; correct it in FACTS (Cancel Posting).");
                if (w.Erp == "draft" || await c.ExecuteScalarAsync<bool>("select erp_post_id is not null from wastage where id = @id", new { id }, tx))
                    throw new DomainException("This went to FACTS in a draft transfer: finance takes the line off there.");
                var today = await Days.DateAsync(c, tx, scope.Branch);
                if (!scope.Can("day.manage") && (w.By != scope.UserId || w.Day != today)) throw new ForbiddenException("Only a manager can take off someone else's (or an earlier day's) wastage.");
                await c.ExecuteAsync("update wastage set voided_at = now(), voided_by = @u, erp_status = 'none' where id = @id", new { id, u = scope.UserId }, tx);
                await Recipes.UnwasteItemAsync(c, tx, id, scope.UserId);
                await Audit.RecordAsync(c, tx, scope.CompanyId, scope.Branch, scope.UserId, "wastage", id.ToString(), "voided", $"Wastage of {w.Name} taken off");
                return 0;
            });
            await live.ToBranch(scope.Branch, "stock.changed");
            return Results.Ok(new { id });
        });

        // What finance moved to the branch's wastage location in FACTS (STV transfers, read-only), and the branch's wastage matched
        // to it: a pending line takes the first unmatched transfer line of the same item and quantity on or after its day.
        api.MapGet("/stock/wastage/moves", async (HttpContext http, Db db, FactsSync facts, Live live, int? days) =>
        {
            var scope = await http.ScopeAsync(db);
            if (!scope.Can("kitchen.view") && !scope.Can("facts.post")) scope.Require("pos.sell");
            var br = await db.Company(scope.CompanyId, (c, tx) => c.QuerySingleAsync<(string? Loc, string? Waste, string Tz)>(
                "select erp_location_code, erp_waste_location, time_zone from branch where id = @b", new { b = scope.Branch }, tx));
            if (br.Loc is null || br.Waste is null) return Results.Ok(new { linked = false, location = br.Loc, wasteLocation = br.Waste, moves = Array.Empty<object>(), matched = 0 });
            var since = BusinessClock.Today(br.Tz).AddDays(-Math.Clamp(days ?? 7, 1, 60));
            List<(string DocType, string DocNo, DateTime DocDate, DateTime? PostedAt)> heads;
            List<(string DocType, string DocNo, int Line, string Code, string Name, decimal Qty, string? Unit, string? Batch)> lines;
            await using (var f = await facts.OpenAsync(scope.CompanyId))
            {
                var args = new { loc = br.Loc, waste = br.Waste, since = since.ToDateTime(TimeOnly.MinValue) };
                heads = (await f.QueryAsync<(string, string, DateTime, DateTime?)>("""
                    select h.TSF_DOCTYPE, h.TSF_DOCNO, h.TSF_DOCDATE, h.TSF_POSTED_TS from TRANSFER_HEADER h
                    where h.TSF_LOCATION_FM_DOCNO = @loc and h.TSF_LOCATION_TO_DOCNO = @waste and h.TSF_DOCDATE >= @since order by h.TSF_DOCDATE desc
                    """, args, commandTimeout: 60)).ToList();
                lines = heads.Count == 0 ? [] : (await f.QueryAsync<(string, string, int, string, string, decimal, string?, string?)>("""
                    select d.TSFDET_DOCTYPE, d.TSFDET_DOCNO, d.TSFDET_DOCSRNO, ltrim(rtrim(d.TSFDET_STOCK_DOCNO)), d.TSFDET_STOCK_DESC, d.TSFDET_QTY, d.TSFDET_UNIT_DOCNO, d.TSFDET_BATCH_DOCNO
                    from TRANSFER_DETAILS d join TRANSFER_HEADER h on h.TSF_FYCODE = d.TSFDET_FYCODE and h.TSF_DOCTYPE = d.TSFDET_DOCTYPE and h.TSF_DOCNO = d.TSFDET_DOCNO
                    where h.TSF_LOCATION_FM_DOCNO = @loc and h.TSF_LOCATION_TO_DOCNO = @waste and h.TSF_DOCDATE >= @since
                    """, args, commandTimeout: 60)).ToList();
            }
            var dateOf = heads.ToDictionary(h => (h.DocType, h.DocNo), h => DateOnly.FromDateTime(h.DocDate));
            // One POS' drafts that finance has posted since.
            var postedDocs = heads.Where(h => h.PostedAt is not null).Select(h => $"{h.DocType} {h.DocNo}").ToArray();
            if (postedDocs.Length > 0)
                await db.Company(scope.CompanyId, (c, tx) => c.ExecuteAsync(
                    "update wastage set erp_status = 'posted', erp_matched_at = now() where branch_id = @b and erp_status = 'draft' and erp_doc = any(@postedDocs)",
                    new { b = scope.Branch, postedDocs }, tx));
            var (matched, byLine) = await db.Company(scope.CompanyId, async (c, tx) =>
            {
                // Transfer lines already matched (to anything), and the branch's wastage still waiting for finance.
                var used = (await c.QueryAsync<(string Doc, int Line, string Name, string? By)>("""
                    select w.erp_doc, w.erp_doc_line, w.name, u.display_name from wastage w left join app_user u on u.id = w.recorded_by
                    where w.branch_id = @b and w.erp_doc_line is not null
                    """, new { b = scope.Branch }, tx)).ToDictionary(x => (x.Doc, x.Line), x => (x.Name, x.By));
                var pending = (await c.QueryAsync<(Guid Id, string Name, decimal Qty, DateOnly Day, string? Code)>("""
                    select w.id, w.name, w.qty, w.business_date, i.erp_item_code from wastage w left join menu_item i on i.id = w.item_id
                    where w.branch_id = @b and w.kind = 'wastage' and w.voided_at is null and w.erp_status = 'pending' and w.business_date >= @from order by w.recorded_at
                    """, new { b = scope.Branch, from = since.AddDays(-7) }, tx)).ToList();
                var n = 0;
                foreach (var w in pending.Where(p => p.Code is not null))
                {
                    var hit = lines.Where(l => l.Code == w.Code && l.Qty == w.Qty && dateOf[(l.DocType, l.DocNo)] >= w.Day && !used.ContainsKey(($"{l.DocType} {l.DocNo}", l.Line)))
                        .OrderBy(l => dateOf[(l.DocType, l.DocNo)]).ThenBy(l => l.DocNo).ThenBy(l => l.Line).FirstOrDefault();
                    if (hit.Code is null) continue;
                    var doc = $"{hit.DocType} {hit.DocNo}";
                    await c.ExecuteAsync("update wastage set erp_status = 'posted', erp_doc = @doc, erp_doc_line = @line, erp_matched_at = now() where id = @Id",
                        new { doc, line = hit.Line, w.Id }, tx);
                    await Audit.RecordAsync(c, tx, scope.CompanyId, scope.Branch, scope.UserId, "wastage", w.Id.ToString(), "posted",
                        $"Wastage matched to FACTS {doc} line {hit.Line} (moved to {br.Waste}{(hit.Batch is null ? "" : $", batch {hit.Batch}")})");
                    used[(doc, hit.Line)] = (w.Name, null);
                    n++;
                }
                return (n, used);
            });
            if (matched > 0) await live.ToBranch(scope.Branch, "stock.changed");
            return Results.Ok(new
            {
                linked = true, location = br.Loc, wasteLocation = br.Waste, matched,
                moves = heads.Select(h => new
                {
                    docType = h.DocType, docNo = h.DocNo, date = h.DocDate, posted = h.PostedAt is not null,
                    lines = lines.Where(l => l.DocType == h.DocType && l.DocNo == h.DocNo).OrderBy(l => l.Line).Select(l => new
                    {
                        line = l.Line, code = l.Code, name = l.Name, qty = l.Qty, unit = l.Unit, batch = l.Batch,
                        matched = byLine.TryGetValue(($"{h.DocType} {h.DocNo}", l.Line), out var m) ? m.Name : null,
                    }),
                }),
            });
        });

        // Send now: the day's wastage still waiting goes to FACTS as one draft STV50 now, instead of at the night's day close.
        api.MapPost("/stock/wastage/send", async (SendBody body, HttpContext http, Db db, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            if (!scope.Can("facts.post")) scope.Require("day.manage");
            var n = await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var day = body.Date ?? await Days.DateAsync(c, tx, scope.Branch);
                var lines = await FactsPosting.EnqueueWastageAsync(c, tx, scope.Branch, day);
                if (lines > 0) await Audit.RecordAsync(c, tx, scope.CompanyId, scope.Branch, scope.UserId, "wastage", null, "sent", $"Wastage of {day:dd MMM} sent to FACTS as a draft transfer ({lines} lines)");
                return lines;
            });
            if (n == 0) throw new DomainException("Nothing to send: no wastage waiting (with a FACTS item) for that day, or wastage isn't sent as drafts.");
            FactsPosting.Sender.Wake();
            await live.ToBranch(scope.Branch, "stock.changed");
            return Results.Ok(new { lines = n });
        });

        // Finance posts wastage in FACTS (a transfer to the outlet's wastage location, by FIFO batch) and notes its document here.
        api.MapPost("/stock/wastage/{id:guid}/posted", async (Guid id, PostedBody body, HttpContext http, Db db, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            if (!scope.Can("facts.post")) scope.Require("day.manage");
            var doc = (body.Doc ?? "").Trim();
            if (doc.Length is 0 or > 40) throw new DomainException("Enter the FACTS document (e.g. STV50 8114).");
            await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var n = await c.ExecuteAsync("update wastage set erp_status = 'posted', erp_doc = @doc, erp_matched_at = now() where id = @id and branch_id = @b and voided_at is null", new { id, doc, b = scope.Branch }, tx);
                if (n == 0) throw new NotFoundException("Wastage record not found.");
                await Audit.RecordAsync(c, tx, scope.CompanyId, scope.Branch, scope.UserId, "wastage", id.ToString(), "posted", $"Wastage posted in FACTS as {doc}");
                return 0;
            });
            await live.ToBranch(scope.Branch, "stock.changed");
            return Results.Ok(new { id, doc });
        });

        // Transfers into this branch's FACTS location over the last days (read from FACTS), with the branch's check of each.
        api.MapGet("/stock/deliveries", async (HttpContext http, Db db, FactsSync facts, int? days) =>
        {
            var scope = await http.ScopeAsync(db);
            if (!scope.Can("kitchen.view") && !scope.Can("facts.post")) scope.Require("pos.sell");
            var (loc, tz) = await db.Company(scope.CompanyId, (c, tx) => c.QuerySingleAsync<(string? Loc, string Tz)>("select erp_location_code, time_zone from branch where id = @b", new { b = scope.Branch }, tx));
            if (loc is null) return Results.Ok(new { linked = false, location = (string?)null, deliveries = Array.Empty<object>() });
            // FACTS keeps local times: from the start of the branch's day, that many days back.
            var since = BusinessClock.Today(tz).AddDays(-Math.Clamp(days ?? 7, 1, 60)).ToDateTime(TimeOnly.MinValue);
            List<(string DocType, string DocNo, DateTime DocDate, string From, string? FromName, string? Narration, decimal Qty, DateTime? PostedAt, bool MovesStock, string? TypeName)> heads;
            List<(string DocType, string DocNo, int SrNo, string Code, string Name, decimal Qty, string? Unit)> lines;
            await using (var f = await facts.OpenAsync(scope.CompanyId))
            {
                // Only transfers that move stock (the ERP's own flag) are deliveries; requests (orders the branch placed) are listed apart.
                heads = (await f.QueryAsync<(string, string, DateTime, string, string?, string?, decimal, DateTime?, bool, string?)>("""
                    select h.TSF_DOCTYPE, h.TSF_DOCNO, h.TSF_DOCDATE, ltrim(rtrim(h.TSF_LOCATION_FM_DOCNO)), l.LOC_DESC, h.TSF_NARRATION, isnull(h.TSF_TOTAL_QTY, 0), h.TSF_POSTED_TS,
                           cast(case when isnull(dm.DM_UPDATE_STOCK, 0) = 1 then 1 else 0 end as bit), dm.DM_DESC
                    from TRANSFER_HEADER h left join LOCATION_MASTER l on l.LOC_DOCNO = h.TSF_LOCATION_FM_DOCNO
                    left join DOCUMENT_MASTER dm on dm.DM_DOCNO = h.TSF_DOCTYPE
                    where h.TSF_LOCATION_TO_DOCNO = @loc and h.TSF_DOCDATE >= @since order by h.TSF_DOCDATE desc
                    """, new { loc, since }, commandTimeout: 60)).ToList();
                lines = heads.Count == 0 ? [] : (await f.QueryAsync<(string, string, int, string, string, decimal, string?)>("""
                    select d.TSFDET_DOCTYPE, d.TSFDET_DOCNO, d.TSFDET_DOCSRNO, ltrim(rtrim(d.TSFDET_STOCK_DOCNO)), d.TSFDET_STOCK_DESC, d.TSFDET_QTY, d.TSFDET_UNIT_DOCNO
                    from TRANSFER_DETAILS d join TRANSFER_HEADER h on h.TSF_FYCODE = d.TSFDET_FYCODE and h.TSF_DOCTYPE = d.TSFDET_DOCTYPE and h.TSF_DOCNO = d.TSFDET_DOCNO
                    where h.TSF_LOCATION_TO_DOCNO = @loc and h.TSF_DOCDATE >= @since
                    """, new { loc, since }, commandTimeout: 60)).ToList();
            }
            var checks = (await db.Company(scope.CompanyId, (c, tx) => c.QueryAsync<(string DocType, string DocNo, string By, DateTime At, bool AllOk, string? Differences, string? Note)>("""
                select d.erp_doc_type, d.erp_doc_no, u.display_name, d.checked_at, d.all_ok, d.differences::text, d.note
                from delivery_check d join app_user u on u.id = d.checked_by where d.branch_id = @b
                """, new { b = scope.Branch }, tx))).ToDictionary(x => (x.DocType, x.DocNo));
            // What goes back from these deliveries (their differences, and returns against them), and who approves it.
            var (returns, returnApprover) = await db.Company(scope.CompanyId, async (c, tx) => (
                await StockReturns.ForDeliveriesAsync(c, tx, scope.Branch, heads.Where(h => h.MovesStock).Select(h => $"{h.DocType} {h.DocNo}").ToArray()),
                await c.ExecuteScalarAsync<string?>("""
                    select u.display_name from branch b join app_user u on u.id = b.wastage_approver_id where b.id = @b and nullif(trim(b.wastage_facts_user), '') is not null
                    """, new { b = scope.Branch }, tx)));
            return Results.Ok(new
            {
                linked = true, location = loc, returnApprover,
                requests = heads.Where(h => !h.MovesStock).Select(h => new
                {
                    docType = h.DocType, docNo = h.DocNo, typeName = h.TypeName, date = h.DocDate, from = h.From, fromName = h.FromName, narration = h.Narration, totalQty = h.Qty,
                    items = lines.Count(l => l.DocType == h.DocType && l.DocNo == h.DocNo),
                }),
                deliveries = heads.Where(h => h.MovesStock).Select(h => new
                {
                    docType = h.DocType, docNo = h.DocNo, date = h.DocDate, from = h.From, fromName = h.FromName, narration = h.Narration, totalQty = h.Qty, posted = h.PostedAt is not null,
                    lines = lines.Where(l => l.DocType == h.DocType && l.DocNo == h.DocNo).OrderBy(l => l.SrNo).Select(l => new { line = l.SrNo, code = l.Code, name = l.Name, qty = l.Qty, unit = l.Unit }),
                    check = checks.TryGetValue((h.DocType, h.DocNo), out var k)
                        ? new { by = k.By, at = k.At, allOk = k.AllOk, differences = k.Differences is null ? (JsonElement?)null : JsonDocument.Parse(k.Differences).RootElement, note = k.Note }
                        : null,
                    returns = returns.Where(r => r.DeliveryDocType == h.DocType && r.DeliveryDocNo == h.DocNo).Select(r => new
                    {
                        r.Id, r.Source, line = r.DeliveryLine, r.ItemName, r.Qty, r.RequestedQty, r.Unit, r.Reason, r.Note, r.ToLocation, r.RecordedByName, r.RecordedAt,
                        r.Approval, r.DecidedByName, r.DecisionNote, r.ErpStatus, r.ErpDoc,
                    }),
                }),
            });
        });

        // Check a delivery in: what was received per line (at most what was sent). The difference goes back by itself to where the
        // delivery came from, waiting for the branch's wastage approver (StockReturns).
        api.MapPost("/stock/deliveries/check", async (CheckBody body, HttpContext http, Db db, FactsSync facts, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            if (!scope.Can("kitchen.view")) scope.Require("pos.sell");
            if (string.IsNullOrWhiteSpace(body.DocType) || string.IsNullOrWhiteSpace(body.DocNo)) throw new DomainException("Which delivery?");
            var docType = body.DocType.Trim();
            var docNo = body.DocNo.Trim();
            var (s, master) = await db.Company(scope.CompanyId, async (c, tx) => (await WastageApproval.SetupAsync(c, tx, scope.Branch),
                await c.ExecuteScalarAsync<string?>("select b.facts_item_master from branch b where b.id = @b", new { b = scope.Branch }, tx)));
            if (s.Loc is null) throw new DomainException("This branch has no ERP stock location.");
            StockReturns.Delivery delivery;
            await using (var f = await facts.OpenAsync(scope.CompanyId))
                delivery = await StockReturns.ReadDeliveryAsync(f, s.Loc, docType, docNo) ?? throw new NotFoundException($"{docType} {docNo} isn't a delivery into {s.Loc}.");
            // Sent is what FACTS says; received is at most that.
            var received = new Dictionary<int, decimal>();
            foreach (var d in body.Differences ?? [])
            {
                var l = (d.Line is { } n ? delivery.Lines.FirstOrDefault(x => x.Line == n) : delivery.Lines.FirstOrDefault(x => x.Code == d.Code))
                    ?? throw new DomainException($"{d.Name} isn't on {docType} {docNo}.");
                if (d.Received < 0) throw new DomainException($"{l.Name}: received can't be below zero.");
                if (d.Received > l.Qty) throw new DomainException($"{l.Name}: at most the {l.Qty:0.###} delivered can be received.");
                received[l.Line] = d.Received;
            }
            var diffs = delivery.Lines.Where(l => received.TryGetValue(l.Line, out var got) && got != l.Qty)
                .Select(l => new Difference(l.Code, l.Name, l.Qty, received[l.Line], null, l.Line)).ToArray();
            var back = await db.Company(scope.CompanyId, async (c, tx) =>
            {
                await c.ExecuteAsync("""
                    insert into delivery_check (company_id, branch_id, erp_doc_type, erp_doc_no, checked_by, all_ok, differences, note)
                    values (@co, @b, @t, @n, @u, @ok, cast(@diffs as jsonb), @note)
                    on conflict (branch_id, erp_doc_type, erp_doc_no) do update set checked_by = excluded.checked_by, checked_at = now(), all_ok = excluded.all_ok,
                      differences = excluded.differences, note = excluded.note
                    """, new
                    {
                        co = scope.CompanyId, b = scope.Branch, t = docType, n = docNo, u = scope.UserId, ok = diffs.Length == 0,
                        diffs = diffs.Length == 0 ? null : JsonSerializer.Serialize(diffs, new JsonSerializerOptions(JsonSerializerDefaults.Web)),
                        note = string.IsNullOrWhiteSpace(body.Note) ? null : body.Note.Trim(),
                    }, tx);
                await Audit.RecordAsync(c, tx, scope.CompanyId, scope.Branch, scope.UserId, "delivery", $"{docType} {docNo}", "checked",
                    diffs.Length == 0 ? $"Delivery {docType} {docNo} received as sent" : $"Delivery {docType} {docNo} received with {diffs.Length} difference(s)", note: body.Note);
                return await StockReturns.VarianceAsync(c, tx, scope, s, master, docType, docNo, delivery, received);
            });
            // A shortage goes back in FACTS straight away (posted STV50, no approval).
            if (back > 0) FactsPosting.Sender.Wake();
            await live.ToBranch(scope.Branch, "stock.changed");
            // Whether the difference went back, and why not when it didn't.
            return Results.Ok(new
            {
                ok = true, differences = diffs.Length, returned = back,
                notReturned = diffs.Length == 0 || back > 0 ? null
                    : !delivery.Posted ? "This delivery isn't posted in FACTS yet, so the difference wasn't sent back; ask the sender to correct the transfer."
                    : "This branch has no wastage approver with a FACTS username, so the difference wasn't sent back (Companies & branches).",
            });
        });

        // Undo a check-in made by mistake (a manager): the delivery shows as not checked again. Only One POS's record goes; FACTS is untouched.
        api.MapPost("/stock/deliveries/uncheck", async (UncheckBody body, HttpContext http, Db db, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("day.manage");
            if (string.IsNullOrWhiteSpace(body.Reason)) throw new DomainException("Say why the check-in is undone.");
            await db.Company(scope.CompanyId, async (c, tx) =>
            {
                await StockReturns.UncheckAsync(c, tx, scope, body.DocType.Trim(), body.DocNo.Trim());
                var was = await c.QuerySingleOrDefaultAsync<(string By, DateTime At)>("""
                    delete from delivery_check d using app_user u
                    where u.id = d.checked_by and d.branch_id = @b and d.erp_doc_type = @t and d.erp_doc_no = @n
                    returning u.display_name, d.checked_at
                    """, new { b = scope.Branch, t = body.DocType.Trim(), n = body.DocNo.Trim() }, tx);
                if (was.By is null) throw new NotFoundException("This delivery isn't checked in.");
                await Audit.RecordAsync(c, tx, scope.CompanyId, scope.Branch, scope.UserId, "delivery", $"{body.DocType} {body.DocNo}", "check_reversed",
                    $"Delivery {body.DocType} {body.DocNo} check-in undone (checked in by {was.By} on {was.At:dd MMM HH:mm} UTC)", note: body.Reason.Trim());
                return 0;
            });
            await live.ToBranch(scope.Branch, "stock.changed");
            return Results.Ok(new { ok = true });
        });
    }
}
