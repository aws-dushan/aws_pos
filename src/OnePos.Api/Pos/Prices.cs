using System.Data;
using System.Globalization;
using System.Text.Json;
using System.Xml.Linq;
using Dapper;
using Microsoft.Data.SqlClient;
using OnePos.Api.Data;
using OnePos.Api.Platform;

namespace OnePos.Api.Pos;

/// <summary>
/// The Prices page: the selling prices of the branch's items (those enabled for selling, FACTS items) at the outlet and on each
/// delivery platform linked to a FACTS customer, as the till charges them (VAT included). Changed prices are posted in FACTS
/// straight away as the branch's FACTS user for price posting: the outlet prices as one OSMPI (outlet price import, the branch's
/// price type), the platform prices as one CPL50 (customer price list) per platform at the branch's platform price location, valid
/// from today, holding only the changed items. Then the price sync reads FACTS back, so the till takes the new prices as it does for
/// prices entered in FACTS by hand. A document FACTS refuses leaves nothing in FACTS and can be posted again.
/// </summary>
public static class Prices
{
    public const string Proc = "usp_ONEPOS_PostPrices";
    /// <summary>Platform price lists made here run to this date, as finance's own.</summary>
    private static readonly DateOnly ValidTo = new(2030, 12, 31);
    private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public sealed record Change(Guid ItemId, Guid? PlatformId, decimal Price);
    public sealed record PostBody(string? Remark, Change[]? Changes);
    public sealed record Line(Guid ItemId, string Code, string? Type, string Name, decimal? Old, decimal New, decimal FactsPrice);

    private sealed record BranchInfo(Guid Id, string Code, string? PriceType, string? PlatformLocation, string? PriceUser, bool InclVat, decimal VatRate);

    private static Task<BranchInfo> BranchAsync(Npgsql.NpgsqlConnection c, Npgsql.NpgsqlTransaction tx, Guid branchId) => c.QuerySingleAsync<BranchInfo>("""
        select b.id, b.code, nullif(trim(b.facts_price_type), '') as PriceType, nullif(upper(trim(b.facts_platform_location)), '') as PlatformLocation,
               nullif(trim(b.facts_price_user), '') as PriceUser, b.facts_prices_include_vat as InclVat, co.vat_rate as VatRate
        from branch b join company co on co.id = b.company_id where b.id = @branchId
        """, new { branchId }, tx);

    /// <summary>What FACTS holds for a selling price: the same, or before VAT where the branch's FACTS prices are before VAT.</summary>
    private static decimal ToFacts(BranchInfo b, decimal selling) => b.InclVat ? selling : Math.Round(selling / (1 + b.VatRate / 100m), 3, MidpointRounding.AwayFromZero);
    private static decimal FromFacts(BranchInfo b, decimal facts) => Money.Round(b.InclVat ? facts : facts * (1 + b.VatRate / 100m));

    public static void Map(RouteGroupBuilder api)
    {
        api.MapGet("/prices", async (HttpContext http, Db db) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("prices.post");
            return await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var b = await BranchAsync(c, tx, scope.Branch);
                var platforms = (await c.QueryAsync<(Guid Id, string Name, string Customer)>(
                    "select id, name, facts_customer from delivery_platform where facts_customer is not null and is_active order by sort, name", transaction: tx)).ToList();
                var items = (await c.QueryAsync<(Guid Id, string Code, string? Type, string Name, string Category, decimal? Price, bool ErpPriced)>("""
                    select i.id, i.erp_item_code, i.erp_item_type, i.name, cat.name, bi.price, bi.erp_priced
                    from branch_item bi join menu_item i on i.id = bi.item_id join menu_category cat on cat.id = i.category_id
                    where bi.branch_id = @b and bi.is_sold and i.is_active and not i.is_combo and i.erp_item_code is not null
                    order by cat.sort, cat.name, i.sort, i.name
                    """, new { b = b.Id }, tx)).ToList();
                var plat = (await c.QueryAsync<(Guid PlatformId, Guid ItemId, decimal Price)>("""
                    select platform_id, item_id, facts_price from platform_item_price where location = @loc and platform_id = any(@ids)
                    """, new { loc = b.PlatformLocation ?? "", ids = platforms.Select(p => p.Id).ToArray() }, tx))
                    .ToLookup(x => x.ItemId);
                return new
                {
                    branch = new { b.Code, priceType = b.PriceType, platformLocation = b.PlatformLocation, factsUser = b.PriceUser },
                    platforms = platforms.Select(p => new { p.Id, p.Name, p.Customer }),
                    items = items.Select(i => new
                    {
                        i.Id, i.Code, i.Name, i.Category,
                        outlet = i.ErpPriced ? i.Price : null,
                        platforms = plat[i.Id].ToDictionary(x => x.PlatformId.ToString(), x => FromFacts(b, x.Price)),
                    }),
                };
            });
        });

        api.MapGet("/prices/changes", async (HttpContext http, Db db) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("prices.post");
            return await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var changes = (await c.QueryAsync<(Guid Id, string? Remark, string FactsUser, DateTime CreatedAt, string By)>("""
                    select pc.id, pc.remark, pc.facts_user, pc.created_at, u.display_name from price_change pc join app_user u on u.id = pc.created_by
                    where pc.branch_id = @b order by pc.created_at desc limit 50
                    """, new { b = scope.Branch }, tx)).ToList();
                var docs = (await c.QueryAsync<DocRow>("""
                    select d.id, d.change_id, d.kind, dp.name as platform, d.price_type, d.location, d.lines::text as lines, d.status, d.facts_doc_type, d.facts_doc, d.error, d.posted_at
                    from price_change_doc d left join delivery_platform dp on dp.id = d.platform_id where d.change_id = any(@ids) order by d.kind, dp.name
                    """, new { ids = changes.Select(x => x.Id).ToArray() }, tx)).ToLookup(d => d.ChangeId);
                return changes.Select(x => new
                {
                    x.Id, x.Remark, x.FactsUser, x.CreatedAt, x.By,
                    docs = docs[x.Id].Select(d => new
                    {
                        d.Id, d.Kind, d.Platform, d.PriceType, d.Location, d.Status, d.FactsDocType, d.FactsDoc, d.Error, d.PostedAt,
                        lines = JsonSerializer.Deserialize<JsonElement>(d.Lines),
                    }),
                });
            });
        });

        api.MapPost("/prices/post", async (PostBody body, HttpContext http, Db db, Erp.ErpConnections erp, Erp.FactsSync facts, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("prices.post");
            var changes = (body.Changes ?? []).ToList();
            if (changes.Count == 0) throw new DomainException("Change at least one price first.");
            if (changes.Count > 2000) throw new DomainException("Post at most 2,000 prices at a time.");
            if (changes.Any(x => x.Price <= 0 || x.Price > 100000 || Money.Round(x.Price) != x.Price))
                throw new DomainException("Prices are above zero, with at most 2 decimals.");
            if (changes.GroupBy(x => (x.ItemId, x.PlatformId)).Any(g => g.Count() > 1)) throw new DomainException("A price is listed twice.");
            var remark = string.IsNullOrWhiteSpace(body.Remark) ? null : body.Remark.Trim();
            if (remark is { Length: > 100 }) throw new DomainException("Keep the remark to 100 characters.");

            var changeId = await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var b = await BranchAsync(c, tx, scope.Branch);
                if (b.PriceUser is null) throw new DomainException("This branch has no FACTS user for price posting. An administrator sets it under Companies & branches.");
                var itemIds = changes.Select(x => x.ItemId).Distinct().ToArray();
                var items = (await c.QueryAsync<(Guid Id, string Code, string? Type, string Name, decimal? Price, bool ErpPriced)>("""
                    select i.id, i.erp_item_code, i.erp_item_type, i.name, bi.price, bi.erp_priced
                    from branch_item bi join menu_item i on i.id = bi.item_id
                    where bi.branch_id = @b and bi.is_sold and i.is_active and not i.is_combo and i.erp_item_code is not null and i.id = any(@itemIds)
                    """, new { b = b.Id, itemIds }, tx)).ToDictionary(x => x.Id);
                if (items.Count != itemIds.Length) throw new DomainException("Some items aren't FACTS items enabled for selling at this branch. Reload the page.");
                var platforms = (await c.QueryAsync<(Guid Id, string Name, string Customer)>(
                    "select id, name, facts_customer from delivery_platform where facts_customer is not null and is_active", transaction: tx)).ToDictionary(x => x.Id);
                var platformIds = changes.Where(x => x.PlatformId is not null).Select(x => x.PlatformId!.Value).Distinct().ToArray();
                if (platformIds.Any(p => !platforms.ContainsKey(p))) throw new DomainException("A platform isn't linked to a FACTS customer. Reload the page.");
                if (changes.Any(x => x.PlatformId is null) && b.PriceType is null)
                    throw new DomainException("This branch has no FACTS price type, so its outlet prices can't be posted. Set it under Companies & branches.");
                if (platformIds.Length > 0 && b.PlatformLocation is null)
                    throw new DomainException("This branch has no platform price location, so platform prices can't be posted. Set it under Companies & branches.");
                var old = (await c.QueryAsync<(Guid PlatformId, Guid ItemId, decimal Price)>(
                    "select platform_id, item_id, facts_price from platform_item_price where location = @loc and platform_id = any(@platformIds) and item_id = any(@itemIds)",
                    new { loc = b.PlatformLocation ?? "", platformIds, itemIds }, tx)).ToDictionary(x => (x.PlatformId, x.ItemId), x => x.Price);

                var id = await c.ExecuteScalarAsync<Guid>("""
                    insert into price_change (company_id, branch_id, remark, facts_user, created_by) values (@co, @b, @remark, @user, @by) returning id
                    """, new { co = scope.CompanyId, b = b.Id, remark, user = b.PriceUser, by = scope.UserId }, tx);
                var refBase = $"One POS prices {b.Code} P-{id.ToString("N")[..8].ToUpperInvariant()}";
                string Ref(string? tag) => (tag is null ? refBase : $"{refBase} {tag}") + (remark is null ? "" : $" · {remark}");
                Line ToLine(Change x)
                {
                    var i = items[x.ItemId];
                    decimal? was = x.PlatformId is { } p ? old.TryGetValue((p, i.Id), out var o) ? FromFacts(b, o) : null : i.ErpPriced ? i.Price : null;
                    return new Line(i.Id, i.Code, i.Type, i.Name, was, x.Price, ToFacts(b, x.Price));
                }
                var outlet = changes.Where(x => x.PlatformId is null).Select(ToLine).ToList();
                if (outlet.Count > 0)
                    await c.ExecuteAsync("""
                        insert into price_change_doc (company_id, change_id, kind, price_type, reference, lines) values (@co, @id, 'outlet', @pt, @reference, cast(@lines as jsonb))
                        """, new { co = scope.CompanyId, id, pt = b.PriceType, reference = Ref(null), lines = JsonSerializer.Serialize(outlet, Json) }, tx);
                foreach (var g in changes.Where(x => x.PlatformId is not null).GroupBy(x => x.PlatformId!.Value))
                {
                    var p = platforms[g.Key];
                    await c.ExecuteAsync("""
                        insert into price_change_doc (company_id, change_id, kind, platform_id, customer, location, reference, lines)
                        values (@co, @id, 'platform', @pid, @customer, @loc, @reference, cast(@lines as jsonb))
                        """, new { co = scope.CompanyId, id, pid = p.Id, customer = p.Customer, loc = b.PlatformLocation, reference = Ref(p.Name), lines = JsonSerializer.Serialize(g.Select(ToLine), Json) }, tx);
                }
                await Audit.RecordAsync(c, tx, scope.CompanyId, b.Id, scope.UserId, "prices", id.ToString(), "posted",
                    $"Prices at {b.Code}: {changes.Count} change{(changes.Count == 1 ? "" : "s")} sent to FACTS as {b.PriceUser}", note: remark);
                return id;
            });
            var result = await PostDocsAsync(db, erp, scope.CompanyId, changeId, null);
            if (result.Posted > 0) await RefreshAsync(facts, live, scope, db);
            return Results.Ok(new { id = changeId, result.Posted, result.Failed });
        });

        // A document FACTS refused (or that couldn't reach FACTS), posted again with the same reference (FACTS finds it if it did go).
        api.MapPost("/prices/docs/{id:guid}/retry", async (Guid id, HttpContext http, Db db, Erp.ErpConnections erp, Erp.FactsSync facts, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("prices.post");
            var changeId = await db.Company(scope.CompanyId, (c, tx) => c.ExecuteScalarAsync<Guid?>("""
                select d.change_id from price_change_doc d join price_change pc on pc.id = d.change_id where d.id = @id and pc.branch_id = @b and d.status <> 'posted'
                """, new { id, b = scope.Branch }, tx)) ?? throw new DomainException("Only a document FACTS refused can be posted again.");
            var result = await PostDocsAsync(db, erp, scope.CompanyId, changeId, id);
            if (result.Posted > 0) await RefreshAsync(facts, live, scope, db);
            return Results.Ok(new { id = changeId, result.Posted, result.Failed });
        });
    }

    private sealed class DocRow
    {
        public Guid Id { get; set; }
        public Guid ChangeId { get; set; }
        public string Kind { get; set; } = "";
        public string? Platform { get; set; }
        public string? PriceType { get; set; }
        public string? Customer { get; set; }
        public string? Location { get; set; }
        public string Reference { get; set; } = "";
        public string Lines { get; set; } = "[]";
        public string Status { get; set; } = "";
        public string? FactsDocType { get; set; }
        public string? FactsDoc { get; set; }
        public string? Error { get; set; }
        public DateTime? PostedAt { get; set; }
        public string FactsUser { get; set; } = "";
    }

    /// <summary>Saves and posts the change's documents (or just one, retried) in FACTS, one by one, and keeps each answer.</summary>
    private static async Task<(int Posted, int Failed)> PostDocsAsync(Db db, Erp.ErpConnections erp, Guid companyId, Guid changeId, Guid? onlyDoc)
    {
        var docs = await db.Company(companyId, (c, tx) => c.QueryAsync<DocRow>("""
            select d.id, d.change_id, d.kind, d.price_type, d.customer, d.location, d.reference, d.lines::text as lines, d.status, pc.facts_user
            from price_change_doc d join price_change pc on pc.id = d.change_id
            where d.change_id = @changeId and d.status <> 'posted' and (@onlyDoc::uuid is null or d.id = @onlyDoc) order by d.kind, d.id
            """, new { changeId, onlyDoc }, tx));
        int posted = 0, failed = 0;
        string? cs = null, connectError = null;
        try { cs = await erp.GetAsync(companyId); }
        catch (Exception e) { connectError = $"The FACTS connection can't be read: {e.Message.Split('\n')[0].Trim()}"; }
        SqlConnection? f = null;
        if (cs is null) connectError ??= "This company has no FACTS connection.";
        else
        {
            f = new SqlConnection(new SqlConnectionStringBuilder(cs) { ApplicationName = "One POS prices" }.ConnectionString);
            try { await f.OpenAsync(); }
            catch (SqlException e) { connectError = $"Couldn't reach FACTS: {e.Message.Split('\n')[0].Trim()}"; await f.DisposeAsync(); f = null; }
        }
        try
        {
            foreach (var d in docs)
            {
                string status, error = "", doc = "", docType = d.Kind == "outlet" ? "OSMPI" : "CPL50";
                if (f is null) { status = "failed"; error = connectError ?? "FACTS can't be reached."; }
                else
                    try
                    {
                        var lines = JsonSerializer.Deserialize<List<Line>>(d.Lines, Json) ?? [];
                        var today = DateTime.UtcNow.AddHours(4).ToString("yyyy-MM-dd", Inv);
                        var xml = new XElement("data", new XElement("Prices",
                            new XElement("Kind", d.Kind == "outlet" ? "OUTLET" : "PLATFORM"), new XElement("DocDate", today), new XElement("Reference", d.Reference),
                            d.Kind == "outlet" ? new XElement("PriceType", d.PriceType) : null,
                            d.Kind == "platform" ? new object[] { new XElement("Customer", d.Customer), new XElement("Location", d.Location), new XElement("ValidTo", ValidTo.ToString("yyyy-MM-dd", Inv)) } : null,
                            lines.Select(l => new XElement("Line", new XElement("ItemType", l.Type ?? ""), new XElement("ItemCode", l.Code), new XElement("Price", l.FactsPrice.ToString("0.###", Inv))))));
                        await using var cmd = new SqlCommand(Proc, f) { CommandType = CommandType.StoredProcedure, CommandTimeout = 180 };
                        cmd.Parameters.AddWithValue("@ClientID", d.FactsUser);
                        cmd.Parameters.Add("@BodyXML", SqlDbType.Xml).Value = xml.ToString(SaveOptions.DisableFormatting);
                        await using var r = await cmd.ExecuteReaderAsync();
                        var bad = false; var ok = false;
                        do
                            while (await r.ReadAsync())
                            {
                                var cols = Enumerable.Range(0, r.FieldCount).ToDictionary(i => r.GetName(i), i => r.IsDBNull(i) ? "" : Convert.ToString(r.GetValue(i), Inv) ?? "", StringComparer.OrdinalIgnoreCase);
                                if (!cols.TryGetValue("status", out var s)) continue;
                                if (s.Equals("FAILED", StringComparison.OrdinalIgnoreCase)) { bad = true; error = cols.GetValueOrDefault("description") ?? "FACTS said FAILED."; }
                                else if (s.Equals("SUCCESS", StringComparison.OrdinalIgnoreCase) && cols.GetValueOrDefault("DocumentType") is { Length: > 0 } t)
                                { ok = true; doc = cols.GetValueOrDefault("DocumentNo") ?? ""; docType = t; }
                            }
                        while (await r.NextResultAsync());
                        status = !bad && ok ? "posted" : "failed";
                        if (status == "failed" && error == "") error = "FACTS gave no answer.";
                    }
                    catch (SqlException e) when (e.Number == 2812) { status = "failed"; error = $"FACTS has no {Proc} yet: run db/facts/{Proc}.sql in FACTS first."; }
                    catch (Exception e) when (e is SqlException or InvalidOperationException or JsonException) { status = "failed"; error = e.Message.Split('\n')[0]; }
                if (status == "posted") posted++; else failed++;
                await db.Company(companyId, (c, tx) => c.ExecuteAsync("""
                    update price_change_doc set status = @status, error = nullif(@error, ''), facts_doc = nullif(@doc, ''), facts_doc_type = @docType,
                      attempts = attempts + 1, posted_at = case when @status = 'posted' then now() else posted_at end where id = @Id
                    """, new { status, error, doc, docType, d.Id }, tx));
            }
        }
        finally { if (f is not null) await f.DisposeAsync(); }
        return (posted, failed);
    }

    /// <summary>Reads the prices back from FACTS now, so the till has them at once (the sync runs every 5 minutes anyway).</summary>
    private static async Task RefreshAsync(Erp.FactsSync facts, Live live, Scope scope, Db db)
    {
        try { await facts.SyncPricesAsync(scope.CompanyId, scope.UserId); }
        catch (DomainException) { /* the next sync brings them */ }
        await live.ToBranch(scope.Branch, "menu.changed");
    }
}
