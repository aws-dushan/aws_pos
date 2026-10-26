using System.Globalization;
using System.Xml.Linq;
using Dapper;
using Npgsql;
using OnePos.Api.Data;
using OnePos.Api.Platform;

namespace OnePos.Api.Pos;

/// <summary>
/// Bills of materials for FACTS items (companies posting to FACTS). A BOM belongs to a FACTS item of the company, so every menu item
/// linked to that FACTS code uses it; it has versions, each valid from a date, listing the FACTS raw materials ONE unit uses. A menu
/// item whose FACTS item has a BOM valid that business day sells without stock of its own (it's made to order). At day close the
/// branch's sales of such items go to FACTS as one draft repacking voucher (RPO50): the finished items in, their raw materials out,
/// as finance makes them today; finance checks and posts it. A version a voucher has used is locked (history can't change).
/// </summary>
public static class Boms
{
    private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;
    public const string RepackingProc = "usp_ONEPOS_SaveRepacking";
    /// <summary>FACTS: one bill's repacking as a POSTED RPO50 (batches FIFO, FACTS' own approval).</summary>
    public const string PostRepackingProc = "usp_ONEPOS_PostRepacking";

    public sealed record LineBody(string ItemType, string ItemCode, string ItemName, string Unit, decimal Qty);
    public sealed record VersionBody(DateOnly ValidFrom, string? Note, LineBody[] Lines);
    public sealed record BomBody(string ItemType, string ItemCode, string ItemName, string Unit, VersionBody Version);

    private sealed class BomRow
    {
        public Guid Id { get; set; }
        public string ItemType { get; set; } = "";
        public string ItemCode { get; set; } = "";
        public string ItemName { get; set; } = "";
        public string Unit { get; set; } = "";
        public string? FactsDoc { get; set; }
        public DateTime? SyncedAt { get; set; }
        public DateOnly? EndedFrom { get; set; }
    }

    private sealed class VersionRow
    {
        public Guid Id { get; set; }
        public Guid BomId { get; set; }
        public DateOnly ValidFrom { get; set; }
        public string? Note { get; set; }
        public DateTime? LockedAt { get; set; }
    }

    private sealed class LineRow
    {
        public Guid VersionId { get; set; }
        public string ItemType { get; set; } = "";
        public string ItemCode { get; set; } = "";
        public string ItemName { get; set; } = "";
        public string Unit { get; set; } = "";
        public decimal Qty { get; set; }
    }

    /// <summary>Viewing: the menu's managers and finance; changing: the menu's managers.</summary>
    private static void RequireView(Scope s) { if (!s.Can("menu.manage") && !s.Can("facts.post")) s.Require("menu.manage"); }

    /// <summary>
    /// Whether this menu item is made to order on that day: its FACTS item has a BOM version valid then (and the BOM hadn't ended,
    /// see SyncFromFactsAsync). Such an item sells without stock of its own (its raw materials come off at day close).
    /// </summary>
    public static Task<bool> MadeToOrderAsync(NpgsqlConnection c, NpgsqlTransaction tx, Guid itemId, DateOnly day) =>
        c.ExecuteScalarAsync<bool>("""
            select exists (select 1 from menu_item i join bom b on b.item_code = i.erp_item_code and b.item_type = i.erp_item_type
                                       and (b.ended_from is null or b.ended_from > @day)
                           join bom_version v on v.bom_id = b.id and v.valid_from <= @day where i.id = @itemId)
            """, new { itemId, day }, tx);

    public static void Map(RouteGroupBuilder api)
    {
        // The company's items from FACTS (menu items linked to a FACTS code, one row per FACTS item), each with its BOM if it has one.
        api.MapGet("/boms", async (HttpContext http, Db db) =>
        {
            var scope = await http.ScopeAsync(db);
            RequireView(scope);
            return await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var today = scope.BranchId is { } b ? await Days.DateAsync(c, tx, b) : BusinessClock.Today("Asia/Dubai");
                var boms = (await c.QueryAsync<BomRow>("select id, item_type, item_code, item_name, unit, facts_doc, synced_at, ended_from from bom", transaction: tx)).ToList();
                var lastSync = await c.QuerySingleOrDefaultAsync<(DateTime? At, bool? Ok, string? Message)>(
                    "select finished_at, ok, message from erp_sync where kind = 'boms' order by started_at desc limit 1", transaction: tx);
                var versions = (await c.QueryAsync<VersionRow>("select id, bom_id, valid_from, note, locked_at from bom_version order by valid_from desc", transaction: tx)).ToList();
                var lines = (await c.QueryAsync<LineRow>("select version_id, item_type, item_code, item_name, unit, qty from bom_line order by sort", transaction: tx)).ToList();
                var menu = (await c.QueryAsync<(string Type, string Code, string? ErpName, string? Unit, string Name)>("""
                    select erp_item_type, erp_item_code, erp_name, erp_unit, name from menu_item
                    where erp_item_code is not null and erp_item_type is not null and is_active order by name
                    """, transaction: tx)).ToList();
                // Every FACTS item on the menu, plus any BOM whose item isn't (any more).
                var keys = menu.Select(m => (m.Type, m.Code)).Concat(boms.Select(x => (x.ItemType, x.ItemCode))).Distinct().ToList();
                var rows = keys.Select(k =>
                {
                    var onMenu = menu.Where(m => m.Type == k.Item1 && m.Code == k.Item2).ToList();
                    var bm = boms.FirstOrDefault(x => x.ItemType == k.Item1 && x.ItemCode == k.Item2);
                    var vs = bm is null ? [] : versions.Where(v => v.BomId == bm.Id).ToList();
                    return new
                    {
                        itemType = k.Item1, itemCode = k.Item2,
                        itemName = bm?.ItemName ?? onMenu.Select(m => m.ErpName).FirstOrDefault(n => !string.IsNullOrWhiteSpace(n)) ?? onMenu[0].Name,
                        unit = bm?.Unit ?? onMenu.Select(m => m.Unit).FirstOrDefault(u => !string.IsNullOrWhiteSpace(u)) ?? "PCS",
                        menuItems = onMenu.Select(m => m.Name).ToArray(),
                        bom = bm is null ? null : new
                        {
                            bm.Id, bm.FactsDoc, bm.SyncedAt, bm.EndedFrom,
                            currentVersionId = bm.EndedFrom <= today ? null : vs.FirstOrDefault(v => v.ValidFrom <= today)?.Id,
                            versions = vs.Select(v => new
                            {
                                v.Id, v.ValidFrom, validTo = vs.Where(x => x.ValidFrom > v.ValidFrom).Select(x => (DateOnly?)x.ValidFrom.AddDays(-1)).LastOrDefault(),
                                v.Note, locked = v.LockedAt is not null,
                                lines = lines.Where(l => l.VersionId == v.Id).Select(l => new { l.ItemType, l.ItemCode, l.ItemName, l.Unit, l.Qty }),
                            }),
                        },
                    };
                }).OrderBy(r => r.bom is null).ThenBy(r => r.itemName).ToList();
                return Results.Ok(new { today, items = rows, lastSync = new { at = lastSync.At, ok = lastSync.Ok, message = lastSync.Message } });
            });
        });

        api.MapPost("/boms", async (BomBody body, HttpContext http, Db db) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("menu.manage");
            var type = Req(body.ItemType, "item type").ToUpperInvariant();
            var code = Req(body.ItemCode, "item code");
            return await db.Company(scope.CompanyId, async (c, tx) =>
            {
                if (await c.ExecuteScalarAsync<bool>("select exists (select 1 from bom where item_type = @type and item_code = @code)", new { type, code }, tx))
                    throw new DomainException($"{code} already has a BOM: add a new version to it instead.");
                var id = await c.ExecuteScalarAsync<Guid>("""
                    insert into bom (company_id, item_type, item_code, item_name, unit, created_by) values (@co, @type, @code, @name, @unit, @user) returning id
                    """, new { co = scope.CompanyId, type, code, name = Req(body.ItemName, "item name"), unit = Req(body.Unit, "unit"), user = scope.UserId }, tx);
                await SaveVersionAsync(c, tx, scope, id, null, body.Version, firstVersion: true);
                await Audit.RecordAsync(c, tx, scope.CompanyId, scope.BranchId, scope.UserId, "bom", id.ToString(), "created", $"BOM for {code} {body.ItemName} created");
                return Results.Ok(new { id });
            });
        });

        // A new version from a date (the recipe changes from then on; earlier days keep the version they had).
        api.MapPost("/boms/{id:guid}/versions", async (Guid id, VersionBody body, HttpContext http, Db db) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("menu.manage");
            return await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var vid = await SaveVersionAsync(c, tx, scope, id, null, body, firstVersion: false);
                return Results.Ok(new { id = vid });
            });
        });

        // A version not used yet can still be corrected (or moved to another date); a used one is locked.
        api.MapPut("/boms/versions/{vid:guid}", async (Guid vid, VersionBody body, HttpContext http, Db db) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("menu.manage");
            return await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var bomId = await c.ExecuteScalarAsync<Guid?>("select bom_id from bom_version where id = @vid", new { vid }, tx) ?? throw new NotFoundException("That BOM version no longer exists.");
                await SaveVersionAsync(c, tx, scope, bomId, vid, body, firstVersion: false);
                return Results.Ok(new { id = vid });
            });
        });

        api.MapDelete("/boms/versions/{vid:guid}", async (Guid vid, HttpContext http, Db db) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("menu.manage");
            return await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var v = await c.QuerySingleOrDefaultAsync<VersionRow>("select id, bom_id, valid_from, note, locked_at from bom_version where id = @vid for update", new { vid }, tx)
                        ?? throw new NotFoundException("That BOM version no longer exists.");
                if (v.LockedAt is not null) throw new DomainException("This version was used in a repacking voucher sent to FACTS, so it can't be deleted. Add a new version instead.");
                await c.ExecuteAsync("delete from bom_version where id = @vid", new { vid }, tx);
                // Its last version gone: the BOM itself goes (nothing used it).
                if (!await c.ExecuteScalarAsync<bool>("select exists (select 1 from bom_version where bom_id = @BomId)", new { v.BomId }, tx))
                    await c.ExecuteAsync("delete from bom where id = @BomId", new { v.BomId }, tx);
                await Audit.RecordAsync(c, tx, scope.CompanyId, scope.BranchId, scope.UserId, "bom", v.BomId.ToString(), "version_deleted", $"BOM version from {v.ValidFrom:dd MMM yyyy} deleted");
                return Results.Ok(new { ok = true });
            });
        });

        // Raw materials to pick for a BOM: FACTS items of type RM (raw material) or PM (packaging material), by code or name.
        api.MapGet("/erp/stock-items", async (string? q, HttpContext http, Db db, Erp.FactsSync erp) =>
        {
            var scope = await http.ScopeAsync(db);
            RequireView(scope);
            var term = (q ?? "").Trim();
            if (term.Length < 2) return Results.Ok(Array.Empty<object>());
            var master = await db.Company(scope.CompanyId, (c, tx) => c.ExecuteScalarAsync<string?>("select facts_item_master from company where id = @id", new { id = scope.CompanyId }, tx));
            await using var f = await erp.OpenAsync(scope.CompanyId);
            var rows = await f.QueryAsync<(string Code, string Name, string Type, string Unit, string? Kind)>("""
                select top 30 ltrim(rtrim(m.STKMST_DOCNO)), m.STKMST_DESC, ltrim(rtrim(m.STKMST_DOCTYPE)), ltrim(rtrim(m.STKMST_UNIT_DOCNO)), ltrim(rtrim(m.STKMST_STTYPE))
                from STOCK_MASTER m
                where m.STKMST_ACTIVE_STATUS = 0 and (@master is null or m.STKMST_DOCTYPE = @master) and m.STKMST_STTYPE in ('RM', 'PM')
                  and (m.STKMST_DOCNO = @term or m.STKMST_DOCNO like @prefix or m.STKMST_DESC like @like)
                order by case when m.STKMST_DOCNO = @term then 0 when m.STKMST_DOCNO like @prefix then 1 else 2 end, m.STKMST_DESC
                """, new { master, term, prefix = term + "%", like = "%" + term.Replace("%", "[%]").Replace("_", "[_]") + "%" }, commandTimeout: 30);
            return Results.Ok(rows.Select(r => new { code = r.Code, name = r.Name.Trim(), type = r.Type, unit = r.Unit, kind = r.Kind }));
        });

    }

    private static async Task<Guid> SaveVersionAsync(NpgsqlConnection c, NpgsqlTransaction tx, Scope scope, Guid bomId, Guid? versionId, VersionBody body, bool firstVersion)
    {
        var lines = (body.Lines ?? []).Where(l => !string.IsNullOrWhiteSpace(l.ItemCode)).ToList();
        if (lines.Count == 0) throw new DomainException("Add at least one raw material.");
        if (lines.Any(l => l.Qty <= 0)) throw new DomainException("Every raw material needs a quantity above zero (per one unit sold).");
        if (lines.GroupBy(l => (l.ItemType.Trim().ToUpperInvariant(), l.ItemCode.Trim())).Any(g => g.Count() > 1)) throw new DomainException("A raw material is listed twice: put its whole quantity on one line.");
        var bom = await c.QuerySingleOrDefaultAsync<BomRow>("select id, item_type, item_code, item_name, unit from bom where id = @bomId", new { bomId }, tx)
                  ?? throw new NotFoundException("That BOM no longer exists.");
        if (lines.Any(l => l.ItemCode.Trim() == bom.ItemCode && l.ItemType.Trim().Equals(bom.ItemType, StringComparison.OrdinalIgnoreCase)))
            throw new DomainException("An item can't be a raw material of itself.");
        // A date already sent to FACTS keeps the version it was sent with: a new or moved version starts after the last day that used one.
        var lastUsed = await c.ExecuteScalarAsync<DateOnly?>("select max(used_until) from bom_version where bom_id = @bomId", new { bomId }, tx);
        if (!firstVersion && lastUsed is { } lu && body.ValidFrom <= lu)
            throw new DomainException($"Sales up to {lu:dd MMM yyyy} were already sent to FACTS with the current version: start the new one on {lu.AddDays(1):dd MMM yyyy} or later.");
        if (versionId is { } vid)
        {
            var locked = await c.ExecuteScalarAsync<bool>("select locked_at is not null from bom_version where id = @vid for update", new { vid }, tx);
            if (locked) throw new DomainException("This version was used in a repacking voucher sent to FACTS, so it can't change. Add a new version instead.");
        }
        if (await c.ExecuteScalarAsync<bool>("select exists (select 1 from bom_version where bom_id = @bomId and valid_from = @from and id <> coalesce(@vid, '00000000-0000-0000-0000-000000000000'::uuid))",
                new { bomId, from = body.ValidFrom, vid = versionId }, tx))
            throw new DomainException($"There is already a version from {body.ValidFrom:dd MMM yyyy}: change that one, or pick another date.");
        var id = versionId ?? await c.ExecuteScalarAsync<Guid>("""
            insert into bom_version (company_id, bom_id, valid_from, note, created_by) values (@co, @bomId, @from, @note, @user) returning id
            """, new { co = scope.CompanyId, bomId, from = body.ValidFrom, note = Opt(body.Note), user = scope.UserId }, tx);
        if (versionId is not null)
        {
            await c.ExecuteAsync("update bom_version set valid_from = @from, note = @note where id = @id", new { id, from = body.ValidFrom, note = Opt(body.Note) }, tx);
            await c.ExecuteAsync("delete from bom_line where version_id = @id", new { id }, tx);
        }
        var sort = 0;
        foreach (var l in lines)
            await c.ExecuteAsync("""
                insert into bom_line (company_id, version_id, sort, item_type, item_code, item_name, unit, qty) values (@co, @id, @sort, @type, @code, @name, @unit, @qty)
                """, new { co = scope.CompanyId, id, sort = ++sort, type = l.ItemType.Trim().ToUpperInvariant(), code = l.ItemCode.Trim(), name = Req(l.ItemName, "raw material name"),
                           unit = Req(l.Unit, "unit"), qty = Math.Round(l.Qty, 6, MidpointRounding.AwayFromZero) }, tx);
        if (!firstVersion)
            await Audit.RecordAsync(c, tx, scope.CompanyId, scope.BranchId, scope.UserId, "bom", bomId.ToString(), versionId is null ? "version_added" : "version_changed",
                $"BOM {bom.ItemCode} {bom.ItemName}: version from {body.ValidFrom:dd MMM yyyy} {(versionId is null ? "added" : "changed")} ({lines.Count} raw material{(lines.Count == 1 ? "" : "s")})");
        return id;
    }

    /// <summary>
    /// Day close: the branch's sales of made-to-order items (a BOM valid that day) as one draft FACTS repacking voucher (RPO50) — the
    /// finished items in, the raw materials they used out — where the company sends them so. Items sold, not less returns (refunds
    /// aren't posted to FACTS, so this matches the POS51 sales there). The versions used are locked.
    /// </summary>
    public static async Task<int> EnqueueRepackingAsync(NpgsqlConnection c, NpgsqlTransaction tx, Guid branchId, DateOnly day)
    {
        var b = await RepackingBranchAsync(c, tx, branchId);
        if (b.Mode != "draft" || b.Connector != "facts" || b.Loc is null) return 0;
        var n = 1 + await c.ExecuteScalarAsync<int>("select count(*)::int from erp_post where branch_id = @branchId and kind = 'repacking' and business_date = @day", new { branchId, day }, tx);
        return await EnqueueRepackingAsync(c, tx, b, branchId, day, null, $"One POS repacking {b.Code} {day:yyyy-MM-dd} #{n}");
    }

    /// <summary>
    /// A bill was paid: its made-to-order items as one RPO50, POSTED in FACTS (usp_ONEPOS_PostRepacking gives the raw materials their
    /// batches FIFO), where the company sends repacking per bill. Queued before the bill so FACTS has the finished items' batches
    /// when the sale is saved. Only where the bill itself goes to FACTS.
    /// </summary>
    public static async Task<int> EnqueueBillRepackingAsync(NpgsqlConnection c, NpgsqlTransaction tx, Guid orderId)
    {
        var o = await c.QuerySingleOrDefaultAsync<(Guid Branch, DateOnly Day, string? InvoiceNo)>("""
            select o.branch_id, o.business_date, o.invoice_no from pos_order o join branch b on b.id = o.branch_id
            where o.id = @orderId and b.facts_post_from is not null and o.business_date >= b.facts_post_from
            """, new { orderId }, tx);
        if (o.Branch == Guid.Empty) return 0;
        var b = await RepackingBranchAsync(c, tx, o.Branch);
        if (b.Mode != "posted" || b.Connector != "facts" || b.Loc is null) return 0;
        return await EnqueueRepackingAsync(c, tx, b, o.Branch, o.Day, orderId, $"One POS repacking {o.InvoiceNo ?? orderId.ToString()[..8]}");
    }

    private static Task<(Guid Company, string Mode, string Connector, string? Loc, string Code)> RepackingBranchAsync(NpgsqlConnection c, NpgsqlTransaction tx, Guid branchId) =>
        c.QuerySingleOrDefaultAsync<(Guid Company, string Mode, string Connector, string? Loc, string Code)>("""
            select b.company_id, co.facts_repacking, co.erp_connector, b.erp_location_code, b.code
            from branch b join company co on co.id = b.company_id where b.id = @branchId
            """, new { branchId }, tx);

    /// <summary>The day's (or one bill's) items with a BOM valid that day as one RPO50 in the FACTS queue; the versions used are locked.</summary>
    private static async Task<int> EnqueueRepackingAsync(NpgsqlConnection c, NpgsqlTransaction tx, (Guid Company, string Mode, string Connector, string? Loc, string Code) b,
        Guid branchId, DateOnly day, Guid? orderId, string reference)
    {
        var sold = (await c.QueryAsync<(Guid VersionId, string Type, string Code, string Name, string Unit, decimal Qty)>("""
            with v as (
              select distinct on (bv.bom_id) bv.id, bv.bom_id from bom_version bv where bv.valid_from <= @day order by bv.bom_id, bv.valid_from desc)
            select v.id, bm.item_type, bm.item_code, bm.item_name, bm.unit, sum(l.qty)
            from order_line l join pos_order o on o.id = l.order_id
            -- The line's item, or for a combo each chosen item (FACTS sells those, not the combo).
            cross join lateral (select l.item_id union all
                                select (m->>'itemId')::uuid from jsonb_array_elements(l.modifiers) m where m->>'itemId' is not null) s(item_id)
            join menu_item i on i.id = s.item_id
            join bom bm on bm.item_code = i.erp_item_code and bm.item_type = i.erp_item_type and (bm.ended_from is null or bm.ended_from > @day)
            join v on v.bom_id = bm.id
            where o.branch_id = @branchId and o.business_date = @day and o.status in ('paid','refunded') and not l.is_void and l.qty > 0
              and (cast(@orderId as uuid) is null or o.id = @orderId)
            group by v.id, bm.item_type, bm.item_code, bm.item_name, bm.unit
            order by bm.item_name
            """, new { branchId, day, orderId }, tx)).ToList();
        if (sold.Count == 0) return 0;
        var lines = (await c.QueryAsync<LineRow>("select version_id, item_type, item_code, item_name, unit, qty from bom_line where version_id = any(@ids) order by sort",
            new { ids = sold.Select(s => s.VersionId).ToArray() }, tx)).ToList();
        var xml = new XElement("data", new XElement("Repacking",
            new XElement("DocDate", day.ToString("yyyy-MM-dd", Inv)), new XElement("Location", b.Loc), new XElement("Reference", reference),
            sold.Select(s => new XElement("Item",
                new XElement("ItemType", s.Type), new XElement("ItemCode", s.Code), new XElement("ItemName", s.Name),
                new XElement("Qty", s.Qty.ToString("0.###", Inv)), new XElement("Unit", s.Unit),
                lines.Where(l => l.VersionId == s.VersionId).Select(l => new XElement("Material",
                    new XElement("ItemType", l.ItemType), new XElement("ItemCode", l.ItemCode), new XElement("ItemName", l.ItemName),
                    new XElement("Qty", Math.Round(l.Qty * s.Qty, 3, MidpointRounding.AwayFromZero).ToString("0.###", Inv)), new XElement("Unit", l.Unit)))))));
        var added = await c.ExecuteAsync("""
            insert into erp_post (company_id, branch_id, kind, order_id, doc_no, business_date, amount, xml, status)
            values (@Company, @branchId, 'repacking', @orderId, @reference, @day, 0, @xml, 'pending')
            on conflict (doc_no) where kind = 'repacking' do nothing
            """, new { b.Company, branchId, orderId, reference, day, xml = xml.ToString(SaveOptions.DisableFormatting) }, tx);
        if (added == 0) return 0;
        await c.ExecuteAsync("update bom_version set locked_at = coalesce(locked_at, now()), used_until = greatest(used_until, @day) where id = any(@ids)",
            new { ids = sold.Select(s => s.VersionId).ToArray(), day }, tx);
        return sold.Count;
    }

    /// <summary>
    /// BOMs from FACTS: each finished item's newest outlet bill of materials (BOMO50), as quantities for ONE unit (a raw material listed
    /// twice is added up). A BOM is made for an item new to One POS; when FACTS' recipe differs from One POS' latest version, a new
    /// version starts today (tomorrow if today's sales already went to FACTS), or today's not-yet-sent version is corrected.
    /// Only active FACTS BOMs count (BOM_ACTIVE_STATUS 0, as FACTS marks active rows). A BOM from FACTS that FACTS no longer has
    /// active ends from the same day a new version would start: from then its item sells from its own stock. Active again un-ends it.
    /// </summary>
    public static async Task<object> SyncFromFactsAsync(Db db, Microsoft.Data.SqlClient.SqlConnection f, Guid companyId)
    {
        var (master, tz) = await db.Company(companyId, async (c, tx) => (
            await c.ExecuteScalarAsync<string?>("select facts_item_master from company where id = @companyId", new { companyId }, tx),
            await c.ExecuteScalarAsync<string?>("select time_zone from branch where company_id = @companyId order by is_active desc, code limit 1", new { companyId }, tx) ?? "Asia/Dubai"));
        var hasActive = await f.ExecuteScalarAsync<int?>("select COL_LENGTH('BOM_HEADER', 'BOM_ACTIVE_STATUS')") is not null;
        var active = hasActive ? " and isnull(BOM_ACTIVE_STATUS, 0) = 0" : "";
        var rows = (await f.QueryAsync<(string DocNo, string Fg, string FgName, string? FgType, decimal Made, string? Unit, DateTime Date, string Rm, string RmName, string? RmType, decimal Qty, string? RmUnit)>($"""
            with h as (
              select BOM_DOCNO, BOM_DOCTYPE, BOM_FYCODE, ltrim(rtrim(BOM_STOCK_DOCNO)) as fg, BOM_STOCK_DESC, nullif(ltrim(rtrim(BOM_STOCK_DOCTYPE)), '') as fg_type,
                     BOM_QTY, ltrim(rtrim(BOM_UNIT_DOCNO)) as unit, BOM_DOCDATE,
                     row_number() over (partition by ltrim(rtrim(BOM_STOCK_DOCNO)) order by BOM_DOCDATE desc, BOM_DOCNO desc) as rn
              from BOM_HEADER where BOM_DOCTYPE = 'BOMO50' and BOM_QTY > 0{active})
            select ltrim(rtrim(h.BOM_DOCNO)), h.fg, h.BOM_STOCK_DESC, h.fg_type, h.BOM_QTY, h.unit, h.BOM_DOCDATE,
                   ltrim(rtrim(d.BOMDET_STOCK_DOCNO)), d.BOMDET_STOCK_DESC, nullif(ltrim(rtrim(d.BOMDET_STOCK_DOCTYPE)), ''), d.BOMDET_QTY, ltrim(rtrim(d.BOMDET_UNIT_DOCNO))
            from h join BOM_DETAILS d on d.BOMDET_DOCNO = h.BOM_DOCNO and d.BOMDET_DOCTYPE = h.BOM_DOCTYPE and d.BOMDET_FYCODE = h.BOM_FYCODE
            where h.rn = 1 and d.BOMDET_QTY > 0
            order by h.fg, d.BOMDET_DOCSRNO
            """, commandTimeout: 60)).ToList();
        var today = BusinessClock.Today(tz);
        int made = 0, changed = 0, same = 0;
        foreach (var g in rows.GroupBy(r => r.Fg))
        {
            var h = g.First();
            var type = (h.FgType ?? master ?? "SMBK").ToUpperInvariant();
            var lines = g.GroupBy(r => r.Rm).Select(x => (Type: (x.First().RmType ?? master ?? "SMBK").ToUpperInvariant(), Code: x.Key, Name: x.First().RmName.Trim(),
                    Unit: x.First().RmUnit ?? "PCS", Qty: Math.Round(x.Sum(r => r.Qty) / h.Made, 6, MidpointRounding.AwayFromZero)))
                .Where(l => l.Qty > 0 && l.Code != h.Fg).ToList();
            if (lines.Count == 0) continue;
            var doc = $"BOMO50 {h.DocNo}";
            var outcome = await db.Company(companyId, async (c, tx) =>
            {
                var bomId = await c.ExecuteScalarAsync<Guid?>("select id from bom where item_type = @type and item_code = @Fg for update", new { type, h.Fg }, tx);
                var isNew = bomId is null;
                bomId ??= await c.ExecuteScalarAsync<Guid>(
                    "insert into bom (company_id, item_type, item_code, item_name, unit, facts_doc, synced_at) values (@companyId, @type, @Fg, @name, @unit, @doc, now()) returning id",
                    new { companyId, type, h.Fg, name = h.FgName.Trim(), unit = h.Unit ?? "PCS", doc }, tx);
                await c.ExecuteAsync("update bom set item_name = @name, unit = @unit, facts_doc = @doc, synced_at = now(), ended_from = null where id = @bomId",
                    new { bomId, name = h.FgName.Trim(), unit = h.Unit ?? "PCS", doc }, tx);
                var latest = await c.QuerySingleOrDefaultAsync<VersionRow>("select id, bom_id, valid_from, note, locked_at from bom_version where bom_id = @bomId order by valid_from desc limit 1", new { bomId }, tx);
                if (latest is not null)
                {
                    var have = (await c.QueryAsync<(string Code, decimal Qty)>("select item_code, qty from bom_line where version_id = @Id", new { latest.Id }, tx))
                        .OrderBy(x => x.Code).ToList();
                    if (have.SequenceEqual(lines.Select(l => (l.Code, l.Qty)).OrderBy(x => x.Code))) return "same";
                }
                // Where it starts: the FACTS document's date for a first version; otherwise today, after any day already sent with the old one.
                var usedUntil = await c.ExecuteScalarAsync<DateOnly?>("select max(used_until) from bom_version where bom_id = @bomId", new { bomId }, tx);
                var from = latest is null ? DateOnly.FromDateTime(h.Date) : today;
                if (usedUntil is { } u && from <= u) from = u.AddDays(1);
                Guid vid;
                if (latest is not null && latest.ValidFrom == from && latest.LockedAt is null)
                {
                    vid = latest.Id;
                    await c.ExecuteAsync("update bom_version set note = @doc where id = @vid", new { vid, doc }, tx);
                    await c.ExecuteAsync("delete from bom_line where version_id = @vid", new { vid }, tx);
                }
                else
                    vid = await c.ExecuteScalarAsync<Guid>("insert into bom_version (company_id, bom_id, valid_from, note) values (@companyId, @bomId, @from, @doc) returning id",
                        new { companyId, bomId, from, doc }, tx);
                var sort = 0;
                foreach (var l in lines)
                    await c.ExecuteAsync("insert into bom_line (company_id, version_id, sort, item_type, item_code, item_name, unit, qty) values (@companyId, @vid, @sort, @Type, @Code, @Name, @Unit, @Qty)",
                        new { companyId, vid, sort = ++sort, l.Type, l.Code, l.Name, l.Unit, l.Qty }, tx);
                return isNew ? "made" : "changed";
            });
            if (outcome == "made") made++; else if (outcome == "changed") changed++; else same++;
        }
        // FACTS answering no BOMs at all is more likely a fault than every BOM gone: then nothing is ended.
        var ended = rows.Count == 0 ? 0 : await db.Company(companyId, (c, tx) => c.ExecuteAsync("""
            update bom b set ended_from = greatest(@today, coalesce((select max(used_until) from bom_version v where v.bom_id = b.id) + 1, @today))
            where b.facts_doc is not null and b.ended_from is null and not (b.item_code = any(@codes))
            """, new { today, codes = rows.Select(r => r.Fg).Distinct().ToArray() }, tx));
        return new { boms = made + changed + same, made, changed, unchanged = same, ended };
    }

    private static string Req(string? v, string what) => string.IsNullOrWhiteSpace(v) ? throw new DomainException($"The {what} is missing.") : v.Trim();
    private static string? Opt(string? v) => string.IsNullOrWhiteSpace(v) ? null : v.Trim();
}
