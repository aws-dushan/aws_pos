using System.Text.Json;
using Dapper;
using Microsoft.Data.SqlClient;
using Npgsql;
using OnePos.Api.Data;
using OnePos.Api.Platform;

namespace OnePos.Api.Erp;

/// <summary>
/// The FACTS item and stock sync (REQ ERP-02 … ERP-05). It only reads FACTS (ApplicationIntent=ReadOnly, SELECTs only).
/// Items: STOCK_MASTER of the company's item type, item master (e.g. SMBK) and/or division, sub-category (STK_GRP2) as the menu category. A new item arrives
/// switched off at every branch and without a price; a renamed item keeps its One POS name;
/// an item gone from FACTS (inactive or sale-blocked) is switched off. Stock: each branch's FACTS location (STOCK_LOCATION_MASTER).
/// "Switch on what sells here": the items the branch's location sold in FACTS's POS documents over the last days.
/// Prices: each branch's own FACTS price type (Price Type Master), see <see cref="SyncPricesAsync"/>.
/// </summary>
public sealed class FactsSync(ErpConnections erp, Db db, Live live)
{
    public sealed record EnableBody(int? Days);
    public sealed record SettingsBody(string? Division, string? ItemType, string? ItemMaster = null);

    private sealed record FactsItem(string Code, string Name, string? NameAr, string? Unit, string? Group, string? GroupName, bool Blocked, int Decimals, string? DocType, string? StockType, string? Division);

    private static readonly string[] Tones = ["fin", "sales", "purch", "inv", "bp", "bank", "appr", "admin"];
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    /// <summary>A read-only connection to the company's FACTS database.</summary>
    public async Task<SqlConnection> OpenAsync(Guid companyId)
    {
        var cs = await erp.GetAsync(companyId) ?? throw new DomainException("This company has no FACTS connection yet. An administrator sets it under Companies & branches.");
        var b = new SqlConnectionStringBuilder(cs) { ApplicationIntent = ApplicationIntent.ReadOnly, ApplicationName = "One POS" };
        var c = new SqlConnection(b.ConnectionString);
        try { await c.OpenAsync(); }
        catch (SqlException ex) { await c.DisposeAsync(); throw new DomainException($"Couldn't reach FACTS: {ex.Message.Split('\n')[0].Trim()}"); }
        return c;
    }

    private static string Clean(string? s) => string.Join(' ', (s ?? "").Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));

    /// <summary>Runs one sync and records it (erp_sync): ok with a summary, or failed with the reason.</summary>
    private async Task<object> RunAsync(Guid companyId, Guid? branchId, string kind, Guid? userId, Func<Task<object>> work)
    {
        var id = await db.Company(companyId, (c, tx) => c.ExecuteScalarAsync<Guid>(
            "insert into erp_sync (company_id, branch_id, kind, by_user) values (@companyId, @branchId, @kind, @userId) returning id", new { companyId, branchId, kind, userId }, tx));
        try
        {
            var summary = await work();
            await db.Company(companyId, (c, tx) => c.ExecuteAsync("update erp_sync set finished_at = now(), ok = true, summary = cast(@s as jsonb) where id = @id",
                new { id, s = JsonSerializer.Serialize(summary, Json) }, tx));
            return summary;
        }
        catch (Exception ex)
        {
            var message = ex is DomainException or SqlException ? ex.Message.Split('\n')[0] : "The sync failed. The error has been logged.";
            await db.Company(companyId, (c, tx) => c.ExecuteAsync("update erp_sync set finished_at = now(), ok = false, message = @message where id = @id", new { id, message }, tx));
            throw ex is DomainException ? ex : new DomainException(message);
        }
    }

    public Task<object> SyncItemsAsync(Guid companyId, Guid? userId) => RunAsync(companyId, null, "items", userId, async () =>
    {
        // What any branch takes from FACTS comes in once (one catalogue); each branch then shows only what matches its own settings.
        // Types: all of them; item masters and divisions: all of them, or any when a branch leaves it open.
        var settings = await db.Company(companyId, (c, tx) => c.QuerySingleAsync<(string? Division, string ItemType, string? Master)>("""
            select case when bool_or(facts_division is null) then null else string_agg(distinct facts_division, ',') end,
                   coalesce((select string_agg(distinct t, ',') from branch x, unnest(string_to_array(coalesce(x.facts_item_types, 'FG'), ',')) t where x.company_id = @companyId), 'FG'),
                   case when bool_or(facts_item_master is null) then null else string_agg(distinct facts_item_master, ',') end
            from branch where company_id = @companyId
            """, new { companyId }, tx));
        List<FactsItem> facts;
        await using (var f = await OpenAsync(companyId))
        {
            facts = (await f.QueryAsync<FactsItem>("""
                select Code, Name, NameAr, Unit, Grp as [Group], GroupName, Blocked, Decimals, DocType, StockType, Division from (
                  select ltrim(rtrim(m.STKMST_DOCNO)) as Code, m.STKMST_DESC as Name, ltrim(rtrim(m.STKMST_DOCTYPE)) as DocType, ltrim(rtrim(m.STKMST_STTYPE)) as StockType,
                         nullif(ltrim(rtrim(m.STKMST_GRP11)), '') as Division,
                         nullif(ltrim(rtrim(coalesce(nullif(ltrim(rtrim(m.STKMST_AR_DESC)), ''), m.STKMST_ARABIC_DESC))), '') as NameAr,
                         ltrim(rtrim(m.STKMST_UNIT_DOCNO)) as Unit, ltrim(rtrim(m.STKMST_GRP2)) as Grp, g.STK_GRP2_DESC as GroupName,
                         cast(case when isnull(m.STKMST_SALE_BLOCKED, 0) = 1 then 1 else 0 end as bit) as Blocked,
                         cast(case when isnull(u.UNIT_DECIMAL, 0) > 3 then 3 when isnull(u.UNIT_DECIMAL, 0) < 0 then 0 else isnull(u.UNIT_DECIMAL, 0) end as int) as Decimals,
                         row_number() over (partition by m.STKMST_DOCNO order by m.STKMST_DOCTYPE) as rn
                  from STOCK_MASTER m left join STK_GRP2 g on g.STK_GRP2_DOCNO = m.STKMST_GRP2 left join UNIT_MASTER u on u.UNIT_DOCNO = m.STKMST_UNIT_DOCNO
                  where ltrim(rtrim(m.STKMST_STTYPE)) in (select value from string_split(@type, ',')) and m.STKMST_ACTIVE_STATUS = 0
                    and (@div is null or ltrim(rtrim(m.STKMST_GRP11)) in (select value from string_split(@div, ',')))
                    and (@master is null or ltrim(rtrim(m.STKMST_DOCTYPE)) in (select value from string_split(@master, ',')))
                ) x where rn = 1
                """, new { type = settings.ItemType, div = settings.Division, master = settings.Master }, commandTimeout: 120)).ToList();
        }
        if (facts.Count == 0) throw new DomainException($"FACTS has no active items of type {settings.ItemType}{(settings.Master is null ? "" : $" in item master {settings.Master}")}{(settings.Division is null ? "" : $" in division {settings.Division}")} (the branches' settings, Companies & branches).");

        var summary = await db.Company(companyId, async (c, tx) =>
        {
            // Categories: one per FACTS sub-category; a name already used by another category gets the code added.
            var cats = (await c.QueryAsync<(Guid Id, string Name, string? ErpCode)>("select id, name, erp_code from menu_category", transaction: tx)).ToList();
            var byCode = cats.Where(x => x.ErpCode is not null).ToDictionary(x => x.ErpCode!, x => x.Id);
            var names = cats.Select(x => x.Name.ToLowerInvariant()).ToHashSet();
            var sort = await c.ExecuteScalarAsync<int>("select coalesce(max(sort), 0) from menu_category", transaction: tx);
            var newCats = 0;
            foreach (var g in facts.GroupBy(x => x.Group ?? "").OrderBy(g => Clean(g.First().GroupName)))
            {
                if (byCode.ContainsKey(g.Key)) continue;
                var name = Clean(g.First().GroupName);
                if (name.Length == 0) name = g.Key.Length == 0 ? "Other" : $"Group {g.Key}";
                name = System.Globalization.CultureInfo.InvariantCulture.TextInfo.ToTitleCase(name.ToLowerInvariant());
                if (names.Contains(name.ToLowerInvariant())) name = $"{name} ({g.Key})";
                names.Add(name.ToLowerInvariant());
                byCode[g.Key] = await c.ExecuteScalarAsync<Guid>("""
                    insert into menu_category (company_id, name, tone, sort, erp_code) values (@companyId, @name, @tone, @sort, @code) returning id
                    """, new { companyId, name, tone = Tones[newCats % Tones.Length], sort = ++sort, code = g.Key }, tx);
                newCats++;
            }

            var existing = (await c.QueryAsync<(Guid Id, string Code, string Name, string? ErpName, bool Removed, bool ErpCategory)>("""
                select i.id, i.erp_item_code, i.name, i.erp_name, i.erp_removed, cat.erp_code is not null
                from menu_item i join menu_category cat on cat.id = i.category_id where i.erp_item_code is not null
                """, transaction: tx)).ToDictionary(x => x.Code);

            // New items: off at every branch, no price yet.
            var fresh = facts.Where(x => !existing.ContainsKey(x.Code) && !x.Blocked).ToList();
            if (fresh.Count > 0)
            {
                await c.ExecuteAsync("""
                    insert into menu_item (company_id, category_id, name, name_ar, price, station, erp_item_code, erp_name, erp_unit, qty_decimals, needs_price, erp_new, erp_synced_at)
                    select @companyId, cat, name, name_ar, 0, 'none', code, name, unit, decimals, true, true, now()
                    from unnest(@cats, @names, @namesAr, @codes, @units, @decimals) as t(cat, name, name_ar, code, unit, decimals)
                    """, new
                    {
                        companyId, cats = fresh.Select(x => byCode[x.Group ?? ""]).ToArray(), names = fresh.Select(x => Clean(x.Name)).ToArray(),
                        namesAr = fresh.Select(x => x.NameAr).ToArray(), codes = fresh.Select(x => x.Code).ToArray(), units = fresh.Select(x => x.Unit).ToArray(),
                        decimals = fresh.Select(x => x.Decimals).ToArray(),
                    }, tx);
                await c.ExecuteAsync("""
                    insert into branch_item (company_id, branch_id, item_id, is_sold)
                    select @companyId, b.id, i.id, false from branch b cross join menu_item i where i.erp_item_code = any(@codes)
                    on conflict (branch_id, item_id) do nothing
                    """, new { companyId, codes = fresh.Select(x => x.Code).ToArray() }, tx);
            }

            // Known items: FACTS name, unit and sub-category follow FACTS unless changed in One POS; back in FACTS = back on.
            var known = facts.Where(x => existing.ContainsKey(x.Code)).ToList();
            var renamed = 0;
            foreach (var x in known)
            {
                var e = existing[x.Code];
                var name = Clean(x.Name);
                var n = await c.ExecuteAsync("""
                    update menu_item set
                      name = case when name = coalesce(erp_name, name) then @name else name end,
                      name_ar = coalesce(name_ar, @nameAr), erp_name = @name, erp_unit = @unit, qty_decimals = @decimals, erp_synced_at = now(),
                      category_id = case when @erpCategory then @cat else category_id end,
                      is_active = case when @blocked then false when erp_removed then true else is_active end,
                      erp_removed = @blocked
                    where id = @id and (erp_name is distinct from @name or erp_unit is distinct from @unit or qty_decimals <> @decimals or erp_removed <> @blocked
                                        or (@erpCategory and category_id <> @cat) or (name_ar is null and @nameAr is not null))
                    """, new { e.Id, name, nameAr = x.NameAr, unit = x.Unit, decimals = x.Decimals, cat = byCode[x.Group ?? ""], erpCategory = e.ErpCategory, blocked = x.Blocked }, tx);
                renamed += n;
            }
            await c.ExecuteAsync("update menu_item set erp_synced_at = now() where erp_item_code = any(@codes)", new { codes = known.Select(x => x.Code).ToArray() }, tx);
            // FACTS' item document type (e.g. SMBK): posted sales name the item by type and code. Its stock type (FG, NF…): which branches show it.
            await c.ExecuteAsync("""
                update menu_item i set erp_item_type = t.dt, erp_stock_type = t.st, erp_division = t.dv from unnest(@codes, @types, @stocks, @divs) as t(code, dt, st, dv)
                where i.erp_item_code = t.code and (i.erp_item_type is distinct from t.dt or i.erp_stock_type is distinct from t.st or i.erp_division is distinct from t.dv)
                """, new { codes = facts.Select(x => x.Code).ToArray(), types = facts.Select(x => x.DocType).ToArray(), stocks = facts.Select(x => x.StockType).ToArray(),
                           divs = facts.Select(x => x.Division).ToArray() }, tx);

            // Gone from FACTS (inactive, another type or division): switched off, kept for history.
            var codes = facts.Select(x => x.Code).ToHashSet();
            var gone = existing.Values.Where(e => !codes.Contains(e.Code) && !e.Removed).Select(e => e.Id).ToArray();
            if (gone.Length > 0) await c.ExecuteAsync("update menu_item set is_active = false, erp_removed = true where id = any(@gone)", new { gone }, tx);

            var result = new { inFacts = facts.Count, added = fresh.Count, updated = renamed, removed = gone.Length, newCategories = newCats };
            await Audit.RecordAsync(c, tx, companyId, null, Guid.Empty, "erp", "items", "synced",
                $"FACTS items synced: {fresh.Count} new, {renamed} changed, {gone.Length} switched off ({facts.Count} in FACTS)");
            return result;
        });
        await live.ToCompany(companyId, "menu.changed");
        return summary;
    });

    /// <summary>
    /// FACTS payment methods of each branch's location (PAYMENT_METHOD where the name starts with the location code, e.g.
    /// "ERBQS VISA CARD"): cash, the card types the cashier picks, and the delivery platforms. Read-only.
    /// </summary>
    public Task<object> SyncPaymentModesAsync(Guid companyId, Guid? userId) => RunAsync(companyId, null, "payment_modes", userId, async () =>
    {
        var branches = await db.Company(companyId, (c, tx) => c.QueryAsync<(Guid Id, string Loc)>("select id, erp_location_code from branch where erp_location_code is not null", transaction: tx));
        var found = 0;
        await using var f = await OpenAsync(companyId);
        foreach (var b in branches)
        {
            var modes = (await f.QueryAsync<(string Code, string Name)>(
                "select ltrim(rtrim(PM_DOCNO)), ltrim(rtrim(PM_DESC)) from PAYMENT_METHOD where PM_DESC like @prefix", new { prefix = b.Loc + " %" })).ToList();
            var platforms = new[] { "talabat", "deliveroo", "careem", "noon", "keeta", "smiles", "instashop", "zomato" };
            var rows = modes.Select(m =>
            {
                var label = m.Name[(b.Loc.Length + 1)..].Trim();
                var lower = label.ToLowerInvariant();
                var kind = lower == "cash" ? "cash" : platforms.Any(p => lower.Contains(p)) ? "platform" : "card";
                return (m.Code, m.Name, kind, label);
            }).ToList();
            found += rows.Count;
            await db.Company(companyId, async (c, tx) =>
            {
                await c.ExecuteAsync("delete from erp_payment_mode where branch_id = @b and not (code = any(@codes))", new { b = b.Id, codes = rows.Select(x => x.Code).ToArray() }, tx);
                foreach (var x in rows)
                    await c.ExecuteAsync("""
                        insert into erp_payment_mode (company_id, branch_id, code, name, kind, label) values (@companyId, @b, @Code, @Name, @kind, @label)
                        on conflict (branch_id, code) do update set name = excluded.name, kind = excluded.kind, label = excluded.label, synced_at = now()
                        """, new { companyId, b = b.Id, x.Code, x.Name, x.kind, x.label }, tx);
                return 0;
            });
        }
        return new { branches = branches.Count(), methods = found };
    });

    public Task<object> SyncStockAsync(Guid companyId, Guid? userId) => RunAsync(companyId, null, "stock", userId, async () =>
    {
        var branches = (await db.Company(companyId, (c, tx) => c.QueryAsync<(Guid Id, string Location)>(
            "select id, erp_location_code from branch where erp_location_code is not null and is_active", transaction: tx))).ToList();
        if (branches.Count == 0) return new { branches = 0, items = 0 };
        var items = await db.Company(companyId, (c, tx) => c.QueryAsync<(string Code, Guid Id)>("select erp_item_code, id from menu_item where erp_item_code is not null", transaction: tx));
        var byCode = items.ToDictionary(x => x.Code, x => x.Id);
        var updated = 0;
        await using var f = await OpenAsync(companyId);
        foreach (var b in branches)
        {
            var rows = (await f.QueryAsync<(string Code, decimal Qty)>("""
                select ltrim(rtrim(STKLOC_DOCNO)), isnull(STKLOC_CLSQTY, 0) from STOCK_LOCATION_MASTER where STKLOC_LOC_DOCNO = @loc
                """, new { loc = b.Location }, commandTimeout: 120)).Where(r => byCode.ContainsKey(r.Code)).ToList();
            // Wastage still waiting holds back only the stock that was there when it was recorded: what arrived since (posted
            // deliveries to this location, FACTS' local time) can be sold (wastage_held, migration 0083).
            var waiting = (await db.Company(companyId, (c, tx) => c.QueryAsync<(string Code, DateTime Since)>("""
                select i.erp_item_code, min(w.recorded_at at time zone b.time_zone)
                from wastage w join menu_item i on i.id = w.item_id join branch b on b.id = w.branch_id
                where w.branch_id = @branchId and w.voided_at is null and w.erp_status not in ('none', 'posted') and i.erp_item_code is not null
                group by i.erp_item_code
                """, new { branchId = b.Id }, tx))).ToDictionary(x => x.Code, x => x.Since);
            var arrived = new Dictionary<string, decimal>();
            if (waiting.Count > 0)
            {
                var lines = await f.QueryAsync<(string Code, DateTime PostedAt, decimal Qty)>("""
                    select ltrim(rtrim(d.TSFDET_STOCK_DOCNO)), h.TSF_POSTED_TS, isnull(d.TSFDET_QTY, 0)
                    from TRANSFER_DETAILS d join TRANSFER_HEADER h on h.TSF_FYCODE = d.TSFDET_FYCODE and h.TSF_DOCTYPE = d.TSFDET_DOCTYPE and h.TSF_DOCNO = d.TSFDET_DOCNO
                    join DOCUMENT_MASTER dm on dm.DM_DOCNO = h.TSF_DOCTYPE
                    where h.TSF_LOCATION_TO_DOCNO = @loc and isnull(dm.DM_UPDATE_STOCK, 0) = 1 and h.TSF_POSTED_TS > @since
                      and ltrim(rtrim(d.TSFDET_STOCK_DOCNO)) in @codes
                    """, new { loc = b.Location, since = waiting.Values.Min(), codes = waiting.Keys.ToArray() }, commandTimeout: 120);
                foreach (var l in lines.Where(l => l.PostedAt > waiting[l.Code]))
                    arrived[l.Code] = arrived.GetValueOrDefault(l.Code) + l.Qty;
            }
            updated += await db.Company(companyId, (c, tx) => c.ExecuteAsync("""
                insert into branch_item (company_id, branch_id, item_id, is_sold, erp_stock, erp_stock_at, erp_in_since_waste)
                select @companyId, @branchId, item, false, qty, now(), arrived from unnest(@itemIds, @qtys, @arrived) as t(item, qty, arrived)
                on conflict (branch_id, item_id) do update set erp_stock = excluded.erp_stock, erp_stock_at = excluded.erp_stock_at, erp_in_since_waste = excluded.erp_in_since_waste
                """, new { companyId, branchId = b.Id, itemIds = rows.Select(r => byCode[r.Code]).ToArray(), qtys = rows.Select(r => r.Qty).ToArray(),
                           arrived = rows.Select(r => waiting.ContainsKey(r.Code) ? arrived.GetValueOrDefault(r.Code) : (decimal?)null).ToArray() }, tx));
            await live.ToBranch(b.Id, "menu.changed");
        }
        return new { branches = branches.Count, items = updated };
    });

    /// <summary>
    /// Outlet prices: each branch with a FACTS price type (Price Type Master) takes its FACTS items' prices from STOCK_PRICE of
    /// that type, VAT added where the branch's FACTS prices are before VAT. FACTS decides: an item without a price there (or 0)
    /// has none here and can't be sold. Every change is kept in item_price_history; bills already rung up keep their prices.
    /// </summary>
    /// <summary>BOMs: the outlet bills of materials (BOMO50) into One POS' BOMs (see <see cref="Pos.Boms.SyncFromFactsAsync"/>).</summary>
    public Task<object> SyncBomsAsync(Guid companyId, Guid? userId) => RunAsync(companyId, null, "boms", userId, async () =>
    {
        await using var f = await OpenAsync(companyId);
        return await Pos.Boms.SyncFromFactsAsync(db, f, companyId);
    });

    public Task<object> SyncPricesAsync(Guid companyId, Guid? userId) => RunAsync(companyId, null, "prices", userId, async () =>
    {
        var branches = (await db.Company(companyId, (c, tx) => c.QueryAsync<(Guid Id, string Code, string PriceType, bool InclVat, decimal VatRate)>("""
            select b.id, b.code, b.facts_price_type, b.facts_prices_include_vat, co.vat_rate from branch b join company co on co.id = b.company_id
            where b.facts_price_type is not null and b.is_active
            """, transaction: tx))).ToList();
        // A branch whose price type was taken away: its last FACTS prices stay as branch prices, editable again.
        await db.Company(companyId, (c, tx) => c.ExecuteAsync("""
            update branch_item bi set erp_priced = false from branch b where b.id = bi.branch_id and bi.erp_priced and b.facts_price_type is null
            """, transaction: tx));
        var platforms = (await db.Company(companyId, (c, tx) => c.QueryAsync<(Guid Id, string Name, string Customer)>(
            "select id, name, facts_customer from delivery_platform where facts_customer is not null", transaction: tx))).ToList();
        if (branches.Count == 0 && platforms.Count == 0) return new { branches = 0, priced = 0, changed = 0 };

        var priced = 0; var changed = 0; var missingTypes = new List<string>();
        await using var f = await OpenAsync(companyId);
        var platformResult = await SyncPlatformPricesAsync(f, companyId, userId, platforms);
        if (branches.Count == 0) return new { branches = 0, priced = 0, changed = 0, platforms = platformResult };
        var known = (await f.QueryAsync<string>("select ltrim(rtrim(PTM_DOCNO)) from PRICE_TYPE_MASTER")).ToHashSet(StringComparer.OrdinalIgnoreCase);
        foreach (var b in branches)
        {
            if (!known.Contains(b.PriceType)) { missingTypes.Add(b.PriceType); continue; }
            // One price per item (the latest, should FACTS hold more than one); the item type must match where One POS knows it.
            var rows = (await f.QueryAsync<(string Code, string DocType, decimal Price)>("""
                select Code, DocType, Price from (
                  select ltrim(rtrim(STKPRICE_STOCK_DOCNO)) as Code, ltrim(rtrim(STKPRICE_DOCTYPE)) as DocType, isnull(STKPRICE_PRICE, 0) as Price,
                         row_number() over (partition by STKPRICE_DOCTYPE, STKPRICE_STOCK_DOCNO order by STKPRICE_CREATED_TS desc) as rn
                  from STOCK_PRICE where STKPRICE_PRICE_DOCNO = @pt
                ) x where rn = 1
                """, new { pt = b.PriceType }, commandTimeout: 120)).ToList();
            var result = await db.Company(companyId, async (c, tx) =>
            {
                var items = (await c.QueryAsync<(Guid Id, string Code, string? DocType)>(
                    "select id, erp_item_code, erp_item_type from menu_item where erp_item_code is not null", transaction: tx)).ToList();
                var byCode = rows.ToLookup(r => r.Code, StringComparer.OrdinalIgnoreCase);
                var ids = new List<Guid>(); var prices = new List<decimal?>(); var factsPrices = new List<decimal?>();
                foreach (var i in items)
                {
                    var r = byCode[i.Code].Where(x => i.DocType is null || string.Equals(x.DocType, i.DocType, StringComparison.OrdinalIgnoreCase)).Select(x => (decimal?)x.Price).FirstOrDefault();
                    decimal? price = r is > 0 ? Money.Round(b.InclVat ? r.Value : r.Value * (1 + b.VatRate / 100m)) : null;
                    ids.Add(i.Id); prices.Add(price); factsPrices.Add(r is > 0 ? r : null);
                }
                var args = new { co = companyId, b = b.Id, ids = ids.ToArray(), prices = prices.ToArray(), fps = factsPrices.ToArray(), userId };
                var n = await c.ExecuteAsync("""
                    insert into item_price_history (company_id, branch_id, item_id, old_price, new_price, source, facts_price, changed_by)
                    select @co, @b, t.id, bi.price, t.price, 'facts', t.fp, @userId
                    from unnest(@ids, @prices, @fps) as t(id, price, fp) left join branch_item bi on bi.item_id = t.id and bi.branch_id = @b
                    where bi.price is distinct from t.price or not coalesce(bi.erp_priced, false) and t.price is not null
                    """, args, tx);
                await c.ExecuteAsync("""
                    insert into branch_item (company_id, branch_id, item_id, is_sold, price, erp_priced, erp_price_at)
                    select @co, @b, t.id, false, t.price, true, now() from unnest(@ids, @prices) as t(id, price)
                    on conflict (branch_id, item_id) do update set price = excluded.price, erp_priced = true, erp_price_at = excluded.erp_price_at
                    """, args, tx);
                if (n > 0)
                    await Audit.RecordAsync(c, tx, companyId, b.Id, userId ?? Guid.Empty, "erp", "prices", "synced",
                        $"FACTS prices ({b.PriceType}) at {b.Code}: {n} changed");
                return (Priced: prices.Count(p => p is not null), Changed: n);
            });
            priced += result.Priced; changed += result.Changed;
            if (result.Changed > 0) await live.ToBranch(b.Id, "menu.changed");
        }
        if (missingTypes.Count == branches.Count)
            throw new DomainException($"FACTS has no price type {string.Join(", ", missingTypes)} (Price Type Master).");
        return new { branches = branches.Count - missingTypes.Count, priced, changed, missingTypes, platforms = platformResult };
    });

    /// <summary>
    /// Delivery platform prices: each platform linked to its FACTS customer takes that customer's price list (CPL50): posted, valid
    /// today, in the item's base unit; where lists overlap the newest wins (latest from-date, then latest posted). VAT is added per
    /// branch when a bill is rung up, where that branch's FACTS prices are before VAT. An item not on the list has no price on that
    /// platform. Every change is kept in item_price_history.
    /// </summary>
    private async Task<object> SyncPlatformPricesAsync(SqlConnection f, Guid companyId, Guid? userId, List<(Guid Id, string Name, string Customer)> platforms)
    {
        var done = new List<object>();
        foreach (var p in platforms)
        {
            var cust = await f.QuerySingleOrDefaultAsync<(string? Name, string? Account, string? Subledger)>(
                "select top 1 ltrim(rtrim(ACMST_DESC)), ltrim(rtrim(ACMST_DOCNO)), ltrim(rtrim(ACMST_SUBLEDGER_DOCNO)) from ACMST_POPULATED where ACMST_ACCODE = @code", new { code = p.Customer });
            if (cust.Name is null) { done.Add(new { platform = p.Name, error = $"FACTS has no customer {p.Customer}." }); continue; }
            var rows = (await f.QueryAsync<(string Code, string DocType, decimal Price)>("""
                select Code, DocType, Price from (
                  select ltrim(rtrim(d.SALDET_STOCK_DOCNO)) as Code, ltrim(rtrim(d.SALDET_STOCK_DOCTYPE)) as DocType, isnull(d.SALDET_RATE, 0) as Price,
                         row_number() over (partition by d.SALDET_STOCK_DOCTYPE, d.SALDET_STOCK_DOCNO order by h.SAL_DOCDATE desc, h.SAL_POSTED_TS desc, d.SALDET_DOCSRNO desc) as rn
                  from SALES_HEADER h
                  join SALES_DETAILS d on d.SALDET_FYCODE = h.SAL_FYCODE and d.SALDET_DOCTYPE = h.SAL_DOCTYPE and d.SALDET_DOCNO = h.SAL_DOCNO
                  join STOCK_MASTER m on m.STKMST_DOCTYPE = d.SALDET_STOCK_DOCTYPE and m.STKMST_DOCNO = d.SALDET_STOCK_DOCNO and m.STKMST_UNIT_DOCNO = d.SALDET_UNIT_DOCNO
                  where h.SAL_DOCTYPE = 'CPL50' and h.SAL_POSTED_BY is not null and h.SAL_AC_DOCNO = @ac and h.SAL_SUBLEDGER_DOCNO = @sl
                    and cast(h.SAL_DOCDATE as date) <= cast(getdate() as date) and cast(h.SAL_REFDATE as date) >= cast(getdate() as date)
                ) x where rn = 1
                """, new { ac = cust.Account, sl = cust.Subledger }, commandTimeout: 120)).ToList();
            var n = await db.Company(companyId, async (c, tx) =>
            {
                var items = (await c.QueryAsync<(Guid Id, string Code, string? DocType)>(
                    "select id, erp_item_code, erp_item_type from menu_item where erp_item_code is not null", transaction: tx)).ToList();
                var byCode = rows.ToLookup(r => r.Code, StringComparer.OrdinalIgnoreCase);
                var ids = new List<Guid>(); var prices = new List<decimal?>();
                foreach (var i in items)
                {
                    var r = byCode[i.Code].Where(x => i.DocType is null || string.Equals(x.DocType, i.DocType, StringComparison.OrdinalIgnoreCase)).Select(x => (decimal?)x.Price).FirstOrDefault();
                    ids.Add(i.Id); prices.Add(r is > 0 ? r : null);
                }
                var args = new { co = companyId, pid = p.Id, ids = ids.ToArray(), prices = prices.ToArray(), userId };
                var changed = await c.ExecuteAsync("""
                    insert into item_price_history (company_id, branch_id, platform_id, item_id, old_price, new_price, source, facts_price, changed_by)
                    select @co, null, @pid, t.id, round(pp.facts_price, 2), round(t.price, 2), 'facts', t.price, @userId
                    from unnest(@ids, @prices) as t(id, price) left join platform_item_price pp on pp.platform_id = @pid and pp.item_id = t.id
                    where pp.facts_price is distinct from t.price
                    """, args, tx);
                await c.ExecuteAsync("""
                    delete from platform_item_price pp using unnest(@ids, @prices) as t(id, price) where pp.platform_id = @pid and pp.item_id = t.id and t.price is null
                    """, args, tx);
                await c.ExecuteAsync("""
                    insert into platform_item_price (company_id, platform_id, item_id, facts_price)
                    select @co, @pid, t.id, t.price from unnest(@ids, @prices) as t(id, price) where t.price is not null
                    on conflict (platform_id, item_id) do update set facts_price = excluded.facts_price,
                      updated_at = case when platform_item_price.facts_price = excluded.facts_price then platform_item_price.updated_at else now() end
                    """, args, tx);
                await c.ExecuteAsync("update delivery_platform set facts_customer_name = @name, facts_price_type = @pt, facts_price_at = now() where id = @pid",
                    new { pid = p.Id, name = cust.Name, pt = "CPL50" }, tx);
                if (changed > 0)
                    await Audit.RecordAsync(c, tx, companyId, null, userId ?? Guid.Empty, "erp", "prices", "synced",
                        $"FACTS prices for {p.Name} ({p.Customer}, customer price list CPL50): {changed} changed");
                return (Priced: prices.Count(x => x is not null), Changed: changed);
            });
            if (n.Changed > 0) await live.ToCompany(companyId, "menu.changed");
            done.Add(new { platform = p.Name, customer = p.Customer, priceList = "CPL50", priced = n.Priced, changed = n.Changed });
        }
        return done;
    }

    /// <summary>Switches on at a branch the items its FACTS location sold (POS documents) in the last days, and marks them reviewed.</summary>
    public Task<object> EnableSoldAsync(Guid companyId, Guid branchId, int days, Guid userId) => RunAsync(companyId, branchId, "enable_sold", userId, async () =>
    {
        var loc = await db.Company(companyId, (c, tx) => c.ExecuteScalarAsync<string?>("select erp_location_code from branch where id = @branchId", new { branchId }, tx))
                  ?? throw new DomainException("Set this branch's FACTS stock location first (Companies & branches).");
        List<string> sold;
        await using (var f = await OpenAsync(companyId))
        {
            sold = (await f.QueryAsync<string>("""
                select distinct ltrim(rtrim(d.SALDET_STOCK_DOCNO)) from SALES_DETAILS d
                join DOCUMENT_MASTER dm on dm.DM_DOCNO = d.SALDET_DOCTYPE and dm.DM_HEADER_TABLE_NAME = 'SALES_HEADER' and dm.DM_DOCNO like 'POS%'
                where d.SALDET_LOCATION_DOCNO = @loc and d.SALDET_DOCDATE >= dateadd(day, -@days, getdate())
                """, new { loc, days }, commandTimeout: 120)).ToList();
        }
        var summary = await db.Company(companyId, async (c, tx) =>
        {
            // Only items matching this branch's FACTS settings (types, item master, division).
            var ids = (await c.QueryAsync<Guid>($"""
                select i.id from menu_item i join branch br on br.id = @branchId
                where i.erp_item_code = any(@sold) and i.is_active and (i.erp_stock_type is null or i.erp_stock_type = any(string_to_array(coalesce(br.facts_item_types, 'FG'), ','))) and (br.facts_item_master is null or i.erp_item_type is null or i.erp_item_type = br.facts_item_master) and (br.facts_division is null or i.erp_division is null or i.erp_division = br.facts_division)
                """, new { sold = sold.ToArray(), branchId }, tx)).ToArray();
            await c.ExecuteAsync("""
                insert into branch_item (company_id, branch_id, item_id, is_sold) select @companyId, @branchId, id, true from unnest(@ids) as t(id)
                on conflict (branch_id, item_id) do update set is_sold = true
                """, new { companyId, branchId, ids }, tx);
            await c.ExecuteAsync("update menu_item set erp_new = false where id = any(@ids)", new { ids }, tx);
            await Audit.RecordAsync(c, tx, companyId, branchId, userId, "erp", "enable_sold", "changed",
                $"{ids.Length} items sold at {loc} in the last {days} days switched on");
            return new { soldInFacts = sold.Count, switchedOn = ids.Length, notInCatalogue = sold.Count - ids.Length, days };
        });
        await live.ToBranch(branchId, "menu.changed");
        return summary;
    });

    private static async Task<object> SaveSettingsAsync(Db db, Scope scope, SettingsBody body)
    {
        if (!scope.IsAdmin) throw new ForbiddenException("Only administrators change what is synced from FACTS.");
        // One or more FACTS stock types (STKMST_STTYPE), e.g. "FG" or "FG,NF" (finished goods and non food), kept comma-separated.
        var types = (body.ItemType ?? "").ToUpperInvariant().Split([',', ' ', ';'], StringSplitOptions.RemoveEmptyEntries).Distinct().ToArray();
        if (types.Any(t => !System.Text.RegularExpressions.Regex.IsMatch(t, "^[A-Z0-9_]{1,20}$"))) throw new DomainException("Item types are FACTS stock type codes, e.g. FG, NF.");
        var type = types.Length == 0 ? "FG" : string.Join(",", types);
        var div = string.IsNullOrWhiteSpace(body.Division) ? null : body.Division.Trim();
        var master = string.IsNullOrWhiteSpace(body.ItemMaster) ? null : body.ItemMaster.Trim().ToUpperInvariant();
        await db.Company(scope.CompanyId, async (c, tx) =>
        {
            await c.ExecuteAsync("update company set facts_division = @div, facts_item_type = @type, facts_item_master = @master where id = @id", new { div, type, master, id = scope.CompanyId }, tx);
            await Audit.RecordAsync(c, tx, scope.CompanyId, null, scope.UserId, "erp", "settings", "changed", $"FACTS items: type {type}, item master {master ?? "all"}, division {div ?? "all"}");
            return 0;
        });
        return new { division = div, itemType = type, itemMaster = master };
    }

    public static void Map(RouteGroupBuilder api)
    {
        // The FACTS panel on the Menu screen: settings, the last syncs, and what waits (new items, items without a price).
        api.MapGet("/erp/status", async (HttpContext http, Db db) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("menu.manage");
            return await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var co = await c.QuerySingleAsync<(string Connector, string? Division, string ItemType, bool Configured, string? ItemMaster)>("""
                    select co.erp_connector, br.facts_division, coalesce(br.facts_item_types, 'FG'), exists (select 1 from company_erp e where e.company_id = co.id), br.facts_item_master
                    from company co left join branch br on br.id = @b where co.id = @id
                    """, new { id = scope.CompanyId, b = scope.BranchId }, tx);
                var last = (await c.QueryAsync<(string Kind, DateTime StartedAt, DateTime? FinishedAt, bool? Ok, string? Summary, string? Message)>("""
                    select distinct on (kind) kind, started_at, finished_at, ok, summary::text, message from erp_sync order by kind, started_at desc
                    """, transaction: tx)).ToDictionary(x => x.Kind, x => new { x.StartedAt, x.FinishedAt, x.Ok, summary = x.Summary is null ? (JsonElement?)null : JsonDocument.Parse(x.Summary).RootElement, x.Message });
                var counts = await c.QuerySingleAsync<(int Items, int New, int NeedsPrice, int OnHere)>("""
                    select count(*) filter (where i.erp_item_code is not null and i.is_active)::int,
                           count(*) filter (where i.erp_new and i.is_active)::int,
                           count(*) filter (where (i.needs_price or coalesce(bi.erp_priced, false)) and i.is_active and coalesce(bi.is_sold, false) and bi.price is null)::int,
                           count(*) filter (where i.erp_item_code is not null and i.is_active and coalesce(bi.is_sold, false))::int
                    from menu_item i left join branch_item bi on bi.item_id = i.id and bi.branch_id = @b
                    """, new { b = scope.BranchId }, tx);
                var br = scope.BranchId is { } bid
                    ? await c.QuerySingleOrDefaultAsync<(string? Location, string? PriceType, bool InclVat)>("select erp_location_code, facts_price_type, facts_prices_include_vat from branch where id = @bid", new { bid }, tx)
                    : default;
                return new
                {
                    connector = co.Connector, configured = co.Configured, division = co.Division, itemType = co.ItemType, itemMaster = co.ItemMaster, location = br.Location,
                    priceType = br.PriceType, pricesIncludeVat = br.InclVat,
                    items = last.GetValueOrDefault("items"), stock = last.GetValueOrDefault("stock"), enableSold = last.GetValueOrDefault("enable_sold"),
                    prices = last.GetValueOrDefault("prices"),
                    counts = new { catalogue = counts.Items, @new = counts.New, needsPrice = counts.NeedsPrice, onHere = counts.OnHere },
                };
            });
        });

        api.MapPut("/erp/settings", async (SettingsBody body, HttpContext http, Db db) =>
        {
            var scope = await http.ScopeAsync(db);
            return Results.Ok(await SaveSettingsAsync(db, scope, body));
        });

        // Which FACTS items a company takes, from Companies & branches (the branch dialog's FACTS section): the whole company's
        // catalogue, shared by its branches. Saving reads the items from FACTS at once.
        api.MapGet("/companies/{companyId:guid}/erp/items", async (Guid companyId, HttpContext http, Db db) =>
        {
            var scope = await http.ScopeAsync(db, companyId);
            scope.Require("branch.manage");
            return await db.Company(companyId, async (c, tx) =>
            {
                var x = await c.QuerySingleAsync<(string ItemType, string? ItemMaster, string? Division)>(
                    "select facts_item_type, facts_item_master, facts_division from company where id = @companyId", new { companyId }, tx);
                return new { x.ItemType, x.ItemMaster, x.Division };
            });
        });

        api.MapPut("/companies/{companyId:guid}/erp/items", async (Guid companyId, SettingsBody body, HttpContext http, Db db, FactsSync sync) =>
        {
            var scope = await http.ScopeAsync(db, companyId);
            var saved = await SaveSettingsAsync(db, scope, body);
            var synced = await db.Company(companyId, (c, tx) => c.ExecuteScalarAsync<bool>("select exists (select 1 from company_erp where company_id = @companyId)", new { companyId }, tx))
                ? await sync.SyncItemsAsync(companyId, scope.UserId) : null;
            return Results.Ok(new { saved, synced });
        });

        api.MapPost("/erp/sync/items", async (HttpContext http, Db db, FactsSync sync) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("menu.manage");
            return Results.Ok(await sync.SyncItemsAsync(scope.CompanyId, scope.UserId));
        });

        api.MapPost("/erp/sync/payment-modes", async (HttpContext http, Db db, FactsSync sync) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("branch.manage");
            return Results.Ok(await sync.SyncPaymentModesAsync(scope.CompanyId, scope.UserId));
        });

        // The cashier's card types (and the branch's other FACTS payment methods).
        api.MapGet("/erp/payment-modes", async (HttpContext http, Db db) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("pos.sell");
            return await db.Company(scope.CompanyId, (c, tx) => c.QueryAsync<(string Code, string Name, string Kind, string Label)>(
                "select code, name, kind, label from erp_payment_mode where branch_id = @b order by kind, label", new { b = scope.Branch }, tx))
                .ContinueWith(t => t.Result.Select(m => new { m.Code, m.Name, m.Kind, m.Label }));
        });

        api.MapPost("/erp/sync/stock", async (HttpContext http, Db db, FactsSync sync) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("menu.manage");
            return Results.Ok(await sync.SyncStockAsync(scope.CompanyId, scope.UserId));
        });

        api.MapPost("/erp/sync/boms", async (HttpContext http, Db db, FactsSync sync) =>
        {
            var scope = await http.ScopeAsync(db);
            if (!scope.Can("menu.manage") && !scope.Can("facts.post")) scope.Require("menu.manage");
            return Results.Ok(await sync.SyncBomsAsync(scope.CompanyId, scope.UserId));
        });

        api.MapPost("/erp/sync/prices", async (HttpContext http, Db db, FactsSync sync) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("menu.manage");
            return Results.Ok(await sync.SyncPricesAsync(scope.CompanyId, scope.UserId));
        });

        api.MapPost("/erp/enable-sold", async (EnableBody body, HttpContext http, Db db, FactsSync sync) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("menu.manage");
            var days = Math.Clamp(body.Days ?? 14, 1, 90);
            return Results.Ok(await sync.EnableSoldAsync(scope.CompanyId, scope.Branch, days, scope.UserId));
        });
    }

    /// <summary>The schedule: prices and stock every 5 minutes and items every hour, for each company linked to FACTS with a saved connection.</summary>
    public sealed class Schedule(FactsSync sync, Db db, ILogger<Schedule> logger) : BackgroundService
    {
        protected override async Task ExecuteAsync(CancellationToken stop)
        {
            var lastItems = new Dictionary<Guid, DateTime>();
            while (!stop.IsCancellationRequested)
            {
                try
                {
                    var companies = (await db.Platform((c, tx) => c.QueryAsync<Guid>("select id from company where erp_connector = 'facts' and (facts_division is not null or facts_item_master is not null) and is_active", transaction: tx))).ToList();
                    foreach (var co in companies)
                    {
                        if (!await db.Company(co, (c, tx) => c.ExecuteScalarAsync<bool>("select exists (select 1 from company_erp where company_id = @co)", new { co }, tx))) continue;
                        try
                        {
                            if (!lastItems.TryGetValue(co, out var at) || DateTime.UtcNow - at > TimeSpan.FromHours(1))
                            {
                                lastItems[co] = DateTime.UtcNow;
                                // Card types and payment methods: read on their own, so a failed item sync doesn't stop them.
                                try { await sync.SyncPaymentModesAsync(co, null); }
                                catch (Exception ex) when (ex is not OperationCanceledException) { logger.LogWarning("FACTS payment methods for company {Company} failed: {Message}", co, ex.Message); }
                                await sync.SyncItemsAsync(co, null);
                            }
                            // Outlet prices: read on their own, so a failed price read doesn't stop the stock.
                            try { await sync.SyncPricesAsync(co, null); }
                            catch (Exception ex) when (ex is not OperationCanceledException) { logger.LogWarning("FACTS prices for company {Company} failed: {Message}", co, ex.Message); }
                            // Outlet BOMs (BOMO50): read on their own, so a failed BOM read doesn't stop the stock.
                            try { await sync.SyncBomsAsync(co, null); }
                            catch (Exception ex) when (ex is not OperationCanceledException) { logger.LogWarning("FACTS BOMs for company {Company} failed: {Message}", co, ex.Message); }
                            await sync.SyncStockAsync(co, null);
                        }
                        catch (Exception ex) when (ex is not OperationCanceledException) { logger.LogWarning("FACTS sync for company {Company} failed: {Message}", co, ex.Message); }
                    }
                }
                catch (Exception ex) when (ex is not OperationCanceledException) { logger.LogWarning(ex, "FACTS sync schedule failed"); }
                await Task.Delay(TimeSpan.FromMinutes(5), stop).ContinueWith(_ => { });
            }
        }
    }
}
