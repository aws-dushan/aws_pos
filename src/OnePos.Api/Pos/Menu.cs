using Dapper;
using Npgsql;
using OnePos.Api.Data;
using OnePos.Api.Platform;

namespace OnePos.Api.Pos;

/// <summary>
/// The company menu (REQ MNU-01, REG-02): categories, items, modifier groups. Branch overrides (MNU-02): sold here or not,
/// a branch price, sold out today. Editing needs menu.manage; marking an item sold out today needs only pos.sell (the till does it).
/// </summary>
public static class Menu
{
    public sealed record CategoryBody(string Name, string? NameAr, string? Tone, int? Sort, bool? IsActive);
    public sealed record ItemBody(Guid CategoryId, string Name, string? NameAr, string? Description, decimal Price, string? Station, string? ErpItemCode,
        int? Sort, bool? IsActive, Guid[]? GroupIds, bool? IsCombo);
    /// <summary>An option; with ItemId it is a menu item offered inside a combo ("Shish tawook" in "Choose a main").</summary>
    public sealed record OptionBody(Guid? Id, string Name, decimal Price, bool? IsActive, Guid? ItemId);
    public sealed record GroupBody(string Name, int MinSelect, int MaxSelect, OptionBody[]? Options);
    public sealed record BranchItemBody(bool? IsSold, decimal? Price, bool? ClearPrice, bool? SoldOutToday);

    public sealed class Category
    {
        public Guid Id { get; set; }
        public string Name { get; set; } = "";
        public string? NameAr { get; set; }
        public string Tone { get; set; } = "";
        public int Sort { get; set; }
        public bool IsActive { get; set; }
    }

    public sealed class Item
    {
        public Guid Id { get; set; }
        public Guid CategoryId { get; set; }
        public string Name { get; set; } = "";
        public string? NameAr { get; set; }
        public string? Description { get; set; }
        public decimal Price { get; set; }
        public string Station { get; set; } = "";
        public string? ErpItemCode { get; set; }
        public int Sort { get; set; }
        public bool IsActive { get; set; }
        public bool IsCombo { get; set; }
        /// <summary>When the photo last changed (null = no photo ever); the web builds the photo's address from it.</summary>
        public DateTime? ImageAt { get; set; }
        public bool HasImage { get; set; }
        public Guid[] GroupIds { get; set; } = [];
        // This branch's override (when a branch is chosen).
        public bool IsSold { get; set; } = true;
        public decimal? BranchPrice { get; set; }
        public bool SoldOut { get; set; }
        /// <summary>Its recipe needs more of an ingredient than this branch has (only where the branch warns or blocks).</summary>
        public bool Short { get; set; }
        // FACTS (REQ ERP-02 … ERP-05): code, name and unit there, new / gone, waiting for a price, stock at this branch's location.
        public string? ErpName { get; set; }
        public string? ErpUnit { get; set; }
        public bool NeedsPrice { get; set; }
        /// <summary>This branch takes the item's price from FACTS (its price type): BranchPrice is FACTS' price, null = none there.</summary>
        public bool ErpPriced { get; set; }
        public bool ErpNew { get; set; }
        public bool ErpRemoved { get; set; }
        public DateTime? ErpSyncedAt { get; set; }
        public decimal? ErpStock { get; set; }
        /// <summary>FACTS stock at its last read (every 5 minutes) less what this branch sold since and wastage FACTS doesn't count yet.</summary>
        public decimal? StockLeft { get; set; }
        /// <summary>Its FACTS item has a BOM valid today: made to order, sold without stock of its own.</summary>
        public bool MadeToOrder { get; set; }
        public int QtyDecimals { get; set; }
        public DateTime? ErpStockAt { get; set; }
    }

    public sealed class Group
    {
        public Guid Id { get; set; }
        public string Name { get; set; } = "";
        public int MinSelect { get; set; }
        public int MaxSelect { get; set; }
        public List<Option> Options { get; set; } = [];
    }

    public sealed class Option
    {
        public Guid Id { get; set; }
        public Guid GroupId { get; set; }
        public string Name { get; set; } = "";
        public decimal Price { get; set; }
        public int Sort { get; set; }
        public bool IsActive { get; set; }
        public Guid? ItemId { get; set; }
    }

    private static readonly string[] Tones = ["fin", "sales", "purch", "inv", "bp", "bank", "appr", "admin"];
    private static readonly string[] Stations = ["kitchen", "bar", "none"];

    public static void Map(RouteGroupBuilder api)
    {
        // Back office: the whole menu, with the chosen branch's overrides.
        api.MapGet("/menu", async (HttpContext http, Db db) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("menu.manage");
            return await db.Company(scope.CompanyId, (c, tx) => LoadAsync(c, tx, scope.BranchId, activeOnly: false));
        });

        // The register: what this branch sells now, at its price, with sold-out flags.
        api.MapGet("/pos/menu", async (HttpContext http, Db db) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("pos.sell");
            return await db.Company(scope.CompanyId, (c, tx) => LoadAsync(c, tx, scope.Branch, activeOnly: true));
        });

        api.MapPost("/menu/categories", async (CategoryBody body, HttpContext http, Db db, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("menu.manage");
            var b = Clean(body);
            var id = await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var sort = b.Sort ?? await c.ExecuteScalarAsync<int>("select coalesce(max(sort), 0) + 1 from menu_category", transaction: tx);
                var id = await c.ExecuteScalarAsync<Guid>("insert into menu_category (company_id, name, name_ar, tone, sort) values (@co, @Name, @NameAr, @Tone, @sort) returning id",
                    new { co = scope.CompanyId, b.Name, b.NameAr, b.Tone, sort }, tx);
                await Audit.RecordAsync(c, tx, scope.CompanyId, null, scope.UserId, "menu_category", id.ToString(), "created", $"Menu category {b.Name} created");
                return id;
            });
            await live.ToCompany(scope.CompanyId, "menu.changed");
            return Results.Ok(new { id });
        });

        api.MapPut("/menu/categories/{id:guid}", async (Guid id, CategoryBody body, HttpContext http, Db db, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("menu.manage");
            var b = Clean(body);
            await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var old = await c.QuerySingleOrDefaultAsync<Category>("select * from menu_category where id = @id for update", new { id }, tx) ?? throw new NotFoundException("Category not found.");
                await c.ExecuteAsync("update menu_category set name = @Name, name_ar = @NameAr, tone = @Tone, sort = @Sort, is_active = @IsActive where id = @id",
                    new { id, b.Name, b.NameAr, b.Tone, Sort = b.Sort ?? old.Sort, IsActive = b.IsActive ?? old.IsActive }, tx);
                await Audit.RecordAsync(c, tx, scope.CompanyId, null, scope.UserId, "menu_category", id.ToString(), "changed", $"Menu category {old.Name} changed",
                    [new("Name", old.Name, b.Name), new("Arabic name", old.NameAr, b.NameAr), new("Colour", old.Tone, b.Tone), new("Active", old.IsActive, b.IsActive ?? old.IsActive)]);
                return 0;
            });
            await live.ToCompany(scope.CompanyId, "menu.changed");
            return Results.Ok(new { id });
        });

        api.MapPost("/menu/items", async (ItemBody body, HttpContext http, Db db, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("menu.manage");
            var b = Clean(body);
            var id = await db.Company(scope.CompanyId, async (c, tx) =>
            {
                // A FACTS company's items come from FACTS (the item sync); only combos are made here.
                if (b.IsCombo != true && await c.ExecuteScalarAsync<bool>("select erp_connector = 'facts' from company", transaction: tx))
                    throw new DomainException("Items come from FACTS (the item sync). Here you can add combos.");
                await CheckRefsAsync(c, tx, b);
                var sort = b.Sort ?? await c.ExecuteScalarAsync<int>("select coalesce(max(sort), 0) + 1 from menu_item where category_id = @CategoryId", new { b.CategoryId }, tx);
                var id = await c.ExecuteScalarAsync<Guid>("""
                    insert into menu_item (company_id, category_id, name, name_ar, description, price, station, erp_item_code, sort, is_combo)
                    values (@co, @CategoryId, @Name, @NameAr, @Description, @Price, @Station, @ErpItemCode, @sort, @combo) returning id
                    """, new { co = scope.CompanyId, b.CategoryId, b.Name, b.NameAr, b.Description, b.Price, b.Station, b.ErpItemCode, sort, combo = b.IsCombo == true }, tx);
                await SetGroupsAsync(c, tx, scope.CompanyId, id, b.GroupIds ?? []);
                await CheckComboAsync(c, tx, id, null);
                await Audit.RecordAsync(c, tx, scope.CompanyId, null, scope.UserId, "menu_item", id.ToString(), "created", $"Menu item {b.Name} created",
                    Audit.Created(("Price", b.Price), ("Station", b.Station)));
                return id;
            });
            await live.ToCompany(scope.CompanyId, "menu.changed");
            return Results.Ok(new { id });
        });

        api.MapPut("/menu/items/{id:guid}", async (Guid id, ItemBody body, HttpContext http, Db db, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("menu.manage");
            var b = Clean(body);
            await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var old = await c.QuerySingleOrDefaultAsync<Item>("select * from menu_item where id = @id for update", new { id }, tx) ?? throw new NotFoundException("Item not found.");
                // A FACTS company: the item's FACTS code and whether it's a combo stay as they are.
                if (await c.ExecuteScalarAsync<bool>("select erp_connector = 'facts' from company", transaction: tx))
                {
                    if ((b.IsCombo ?? old.IsCombo) != old.IsCombo) throw new DomainException(old.IsCombo ? "A combo stays a combo." : "An item from FACTS can't become a combo: add a new combo instead.");
                    if (!old.IsCombo && b.ErpItemCode != old.ErpItemCode) throw new DomainException("The FACTS item code can't change here: it links the item to FACTS.");
                }
                await CheckRefsAsync(c, tx, b);
                await c.ExecuteAsync("""
                    update menu_item set category_id = @CategoryId, name = @Name, name_ar = @NameAr, description = @Description, price = @Price,
                      station = @Station, erp_item_code = @ErpItemCode, sort = @Sort, is_active = @IsActive, is_combo = @combo,
                      needs_price = case when @Price > 0 then false else needs_price end, erp_new = false where id = @id
                    """, new { id, b.CategoryId, b.Name, b.NameAr, b.Description, b.Price, b.Station, b.ErpItemCode, Sort = b.Sort ?? old.Sort, IsActive = b.IsActive ?? old.IsActive,
                               combo = b.IsCombo ?? old.IsCombo }, tx);
                await SetGroupsAsync(c, tx, scope.CompanyId, id, b.GroupIds ?? []);
                await CheckComboAsync(c, tx, id, null);
                if (old.Price != b.Price)
                    await c.ExecuteAsync("""
                        insert into item_price_history (company_id, item_id, old_price, new_price, source, changed_by) values (@co, @id, @old, @new, 'manual', @userId)
                        """, new { co = scope.CompanyId, id, old = old.Price, @new = b.Price, userId = scope.UserId }, tx);
                await Audit.RecordAsync(c, tx, scope.CompanyId, null, scope.UserId, "menu_item", id.ToString(), "changed", $"Menu item {old.Name} changed",
                    [new("Name", old.Name, b.Name), new("Price", old.Price, b.Price), new("Station", old.Station, b.Station),
                     new("Category", old.CategoryId, b.CategoryId), new("Active", old.IsActive, b.IsActive ?? old.IsActive)]);
                return 0;
            });
            await live.ToCompany(scope.CompanyId, "menu.changed");
            return Results.Ok(new { id });
        });

        // This branch's override of an item (MNU-02). Sold out today needs only pos.sell; selling here and the branch price need menu.manage.
        api.MapPut("/menu/items/{id:guid}/branch", async (Guid id, BranchItemBody body, HttpContext http, Db db, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            var onlySoldOut = body.IsSold is null && body.Price is null && body.ClearPrice is null;
            scope.Require(onlySoldOut ? "pos.sell" : "menu.manage");
            var branchId = scope.Branch;
            if (body.Price is < 0) throw new DomainException("A price can't be negative.");
            await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var (name, isCombo) = await c.QuerySingleOrDefaultAsync<(string? Name, bool IsCombo)>("select name, is_combo from menu_item where id = @id", new { id }, tx);
                if (name is null) throw new NotFoundException("Item not found.");
                if (isCombo && body.Price is not null) throw new DomainException($"{name} is a combo: its price is the prices on its choices.");
                var was = await c.QuerySingleOrDefaultAsync<(decimal? Price, bool ErpPriced)>(
                    "select price, erp_priced from branch_item where branch_id = @branchId and item_id = @id for update", new { branchId, id }, tx);
                if (was.ErpPriced && (body.Price is not null || body.ClearPrice == true))
                    throw new DomainException($"{name}'s price here comes from FACTS. Change it in FACTS (Price Type Master).");
                await c.ExecuteAsync("""
                    insert into branch_item (company_id, branch_id, item_id, is_sold)
                    select @co, @branchId, @id, erp_item_code is null from menu_item where id = @id on conflict do nothing;
                    update menu_item set erp_new = false where id = @id and coalesce(@isSold, false);
                    update branch_item set
                      is_sold = coalesce(@isSold, is_sold),
                      price = case when @clearPrice then null else coalesce(@price, price) end,
                      sold_out_date = case when @soldOut is null then sold_out_date when @soldOut then @today else null end
                    where branch_id = @branchId and item_id = @id
                    """, new { co = scope.CompanyId, branchId, id, isSold = body.IsSold, price = body.Price is { } p ? Money.Round(p) : (decimal?)null,
                               clearPrice = body.ClearPrice == true, soldOut = body.SoldOutToday, today = await Days.DateAsync(c, tx, branchId) }, tx);
                await c.ExecuteAsync("""
                    insert into item_price_history (company_id, branch_id, item_id, old_price, new_price, source, changed_by)
                    select company_id, branch_id, item_id, @old, price, 'manual', @userId from branch_item
                    where branch_id = @branchId and item_id = @id and price is distinct from @old
                    """, new { branchId, id, old = was.Price, userId = scope.UserId }, tx);
                await Audit.RecordAsync(c, tx, scope.CompanyId, branchId, scope.UserId, "menu_item", id.ToString(), "branch_changed", $"{name} at this branch changed",
                    [new("Sold here", null, body.IsSold), new("Branch price", null, body.ClearPrice == true ? "company price" : body.Price), new("Sold out today", null, body.SoldOutToday)]);
                return 0;
            });
            await live.ToBranch(branchId, "menu.changed");
            return Results.Ok(new { id });
        });

        // An item's price changes at this branch and its company price, newest first: from FACTS or set in One POS.
        api.MapGet("/menu/items/{id:guid}/price-history", async (Guid id, HttpContext http, Db db) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("menu.manage");
            return await db.Company(scope.CompanyId, async (c, tx) => (await c.QueryAsync<(DateTime ChangedAt, bool Branch, decimal? OldPrice, decimal? NewPrice, string Source, decimal? FactsPrice, string? By, string? Platform)>("""
                select h.changed_at, h.branch_id is not null, h.old_price, h.new_price, h.source, h.facts_price, u.display_name, dp.name
                from item_price_history h left join app_user u on u.id = h.changed_by left join delivery_platform dp on dp.id = h.platform_id
                where h.item_id = @id and (h.branch_id = @b or h.branch_id is null) order by h.changed_at desc limit 100
                """, new { id, b = scope.BranchId }, tx)).Select(x => new { x.ChangedAt, x.Branch, x.OldPrice, x.NewPrice, x.Source, x.FactsPrice, x.By, x.Platform }).ToList());
        });

        api.MapPost("/menu/modifier-groups", async (GroupBody body, HttpContext http, Db db, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("menu.manage");
            var b = Clean(body);
            var id = await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var id = await c.ExecuteScalarAsync<Guid>("insert into modifier_group (company_id, name, min_select, max_select) values (@co, @Name, @MinSelect, @MaxSelect) returning id",
                    new { co = scope.CompanyId, b.Name, b.MinSelect, b.MaxSelect }, tx);
                await SetOptionsAsync(c, tx, scope.CompanyId, id, b.Options ?? []);
                await Audit.RecordAsync(c, tx, scope.CompanyId, null, scope.UserId, "modifier_group", id.ToString(), "created", $"Modifier group {b.Name} created");
                return id;
            });
            await live.ToCompany(scope.CompanyId, "menu.changed");
            return Results.Ok(new { id });
        });

        api.MapPut("/menu/modifier-groups/{id:guid}", async (Guid id, GroupBody body, HttpContext http, Db db, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("menu.manage");
            var b = Clean(body);
            await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var old = await c.QuerySingleOrDefaultAsync<Group>("select * from modifier_group where id = @id for update", new { id }, tx) ?? throw new NotFoundException("Modifier group not found.");
                await c.ExecuteAsync("update modifier_group set name = @Name, min_select = @MinSelect, max_select = @MaxSelect where id = @id", new { id, b.Name, b.MinSelect, b.MaxSelect }, tx);
                await SetOptionsAsync(c, tx, scope.CompanyId, id, b.Options ?? []);
                await CheckComboAsync(c, tx, null, id);
                await Audit.RecordAsync(c, tx, scope.CompanyId, null, scope.UserId, "modifier_group", id.ToString(), "changed", $"Modifier group {old.Name} changed",
                    [new("Name", old.Name, b.Name), new("Min", old.MinSelect, b.MinSelect), new("Max", old.MaxSelect, b.MaxSelect)]);
                return 0;
            });
            await live.ToCompany(scope.CompanyId, "menu.changed");
            return Results.Ok(new { id });
        });
    }

    public static async Task<object> LoadAsync(NpgsqlConnection c, NpgsqlTransaction tx, Guid? branchId, bool activeOnly)
    {
        // "Sold out today" means the business day (it holds past midnight until the day closes).
        DateOnly? today = branchId is { } bid ? await Days.DateAsync(c, tx, bid) : null;
        var categories = (await c.QueryAsync<Category>("select * from menu_category where (not @activeOnly or is_active) order by sort, name", new { activeOnly }, tx)).ToList();
        var items = (await c.QueryAsync<Item>("""
            with sold as (
              -- What this branch sold since its items' FACTS stock was read (every 5 minutes): minutes of bills, not years.
              select l.item_id, po.closed_at, l.qty from pos_order po join order_line l on l.order_id = po.id
              where po.branch_id = @branchId and po.status in ('paid','refunded') and not l.is_void
                and po.closed_at > greatest((select min(erp_stock_at) from branch_item where branch_id = @branchId and erp_stock is not null), now() - interval '1 day'))
            select i.*, i.image_file is not null as has_image, coalesce(array(select m.group_id from menu_item_modifier m where m.item_id = i.id order by m.sort), '{}') as group_ids,
                   coalesce(bi.is_sold, i.erp_item_code is null) as is_sold, bi.price as branch_price, coalesce(bi.sold_out_date = @today, false) as sold_out,
                   coalesce(bi.erp_priced, false) as erp_priced, bi.erp_stock, bi.erp_stock_at,
                   coalesce(mto.yes, false) as made_to_order,
                   -- Made to order (a BOM valid today): no stock of its own to run out of.
                   case when bi.erp_stock is null or mto.yes then null else
                     bi.erp_stock - coalesce((select sum(s.qty) from sold s where s.item_id = i.id and s.closed_at > bi.erp_stock_at), 0)
                                  - coalesce((select sum(w.qty) from wastage w where w.item_id = i.id and w.branch_id = @branchId and w.voided_at is null
                                                and w.erp_status <> 'none' and (w.erp_status <> 'posted' or w.erp_matched_at > bi.erp_stock_at)), 0)
                                  - coalesce((select sum(r.qty) from stock_return r where r.item_code = i.erp_item_code and r.branch_id = @branchId and r.approval in ('waiting','approved')
                                                and (r.erp_status <> 'posted' or r.erp_posted_at > bi.erp_stock_at)), 0) end as stock_left,
                   coalesce(br.short_stock <> 'allow' and exists (
                     select 1 from recipe_line r left join branch_ingredient bg on bg.ingredient_id = r.ingredient_id and bg.branch_id = @branchId
                     where r.item_id = i.id and coalesce(bg.on_hand, 0) < r.qty), false) as short
            from menu_item i
            left join branch br on br.id = @branchId
            join menu_category cat on cat.id = i.category_id
            left join branch_item bi on bi.item_id = i.id and bi.branch_id = @branchId
            left join lateral (select true as yes from bom b join bom_version v on v.bom_id = b.id and v.valid_from <= coalesce(@today, current_date)
                               where b.item_code = i.erp_item_code and b.item_type = i.erp_item_type
                                 and (b.ended_from is null or b.ended_from > coalesce(@today, current_date)) limit 1) mto on true
            where (not @activeOnly or (i.is_active and cat.is_active and coalesce(bi.is_sold, i.erp_item_code is null)))
            order by i.sort, i.name
            """, new { branchId, today, activeOnly }, tx)).ToList();
        var groups = (await c.QueryAsync<Group>("select * from modifier_group order by name", transaction: tx)).ToList();
        var options = (await c.QueryAsync<Option>("select * from modifier_option where (not @activeOnly or is_active) order by sort, name", new { activeOnly }, tx)).ToList();
        foreach (var g in groups) g.Options = options.Where(o => o.GroupId == g.Id).ToList();
        var shortStock = branchId is { } b2 ? await c.ExecuteScalarAsync<string>("select short_stock from branch where id = @b2", new { b2 }, tx) : "allow";
        // Delivery platforms with FACTS prices: what each item costs on them here (the register shows these on a platform's bill).
        var platformPrices = await PlatformPrices.ForMenuAsync(c, tx, branchId);
        return new { categories, items, groups, shortStock, platformPrices };
    }

    private static CategoryBody Clean(CategoryBody b)
    {
        if (string.IsNullOrWhiteSpace(b.Name)) throw new DomainException("Enter the category's name.");
        var tone = (b.Tone ?? "fin").Trim();
        if (!Tones.Contains(tone)) throw new DomainException("Choose one of the colours.");
        return new CategoryBody(b.Name.Trim(), string.IsNullOrWhiteSpace(b.NameAr) ? null : b.NameAr.Trim(), tone, b.Sort, b.IsActive);
    }

    private static ItemBody Clean(ItemBody b)
    {
        if (string.IsNullOrWhiteSpace(b.Name)) throw new DomainException("Enter the item's name.");
        if (b.Price < 0) throw new DomainException("A price can't be negative.");
        var station = (b.Station ?? "kitchen").Trim().ToLowerInvariant();
        if (!Stations.Contains(station)) throw new DomainException("The station must be Kitchen, Bar or None.");
        return b with
        {
            Name = b.Name.Trim(), NameAr = string.IsNullOrWhiteSpace(b.NameAr) ? null : b.NameAr.Trim(),
            // A combo costs what its chosen items cost in it (the prices on its choices): no price of its own.
            Description = string.IsNullOrWhiteSpace(b.Description) ? null : b.Description.Trim(), Price = b.IsCombo == true ? 0 : Money.Round(b.Price), Station = station,
            // A combo has no FACTS item of its own: FACTS gets its chosen items, each with its own code.
            ErpItemCode = b.IsCombo == true || string.IsNullOrWhiteSpace(b.ErpItemCode) ? null : b.ErpItemCode.Trim(),
        };
    }

    private static GroupBody Clean(GroupBody b)
    {
        if (string.IsNullOrWhiteSpace(b.Name)) throw new DomainException("Enter the group's name (e.g. Size, Extras).");
        if (b.MinSelect < 0 || b.MaxSelect < 1 || b.MaxSelect < b.MinSelect) throw new DomainException("Choices: the most must be at least 1 and not less than the least.");
        var opts = b.Options ?? [];
        if (opts.Length == 0) throw new DomainException("Add at least one option.");
        if (opts.Any(o => string.IsNullOrWhiteSpace(o.Name))) throw new DomainException("Every option needs a name.");
        if (opts.Any(o => o.Price < 0)) throw new DomainException("An option's price can't be negative.");
        if (b.MinSelect > opts.Count(o => o.IsActive != false)) throw new DomainException("There are fewer options than the group requires.");
        return b with { Name = b.Name.Trim() };
    }

    private static async Task CheckRefsAsync(NpgsqlConnection c, NpgsqlTransaction tx, ItemBody b)
    {
        if (!await c.ExecuteScalarAsync<bool>("select exists (select 1 from menu_category where id = @CategoryId)", new { b.CategoryId }, tx))
            throw new DomainException("Choose a category.");
        var ids = (b.GroupIds ?? []).Distinct().ToArray();
        if (await c.ExecuteScalarAsync<int>("select count(*) from modifier_group where id = any(@ids)", new { ids }, tx) != ids.Length)
            throw new DomainException("A chosen modifier group no longer exists.");
    }

    /// <summary>
    /// A combo (this one, or every combo using this group) is priced and posted by its choices: each active choice must be a menu item,
    /// with an ERP item code where the company posts to FACTS, so FACTS gets each item at its price in the combo.
    /// </summary>
    private static async Task CheckComboAsync(NpgsqlConnection c, NpgsqlTransaction tx, Guid? itemId, Guid? groupId)
    {
        var facts = await c.ExecuteScalarAsync<bool>("select erp_connector = 'facts' from company", transaction: tx);
        var bad = (await c.QueryAsync<string>("""
            select distinct g.name || ': ' || o.name from menu_item ci
            join menu_item_modifier mm on mm.item_id = ci.id join modifier_group g on g.id = mm.group_id
            join modifier_option o on o.group_id = g.id and o.is_active
            left join menu_item i on i.id = o.item_id
            where ci.is_combo and (ci.id = @itemId or g.id = @groupId) and (i.id is null or (@facts and i.erp_item_code is null))
            order by 1
            """, new { itemId, groupId, facts }, tx)).ToList();
        if (bad.Count > 0)
            throw new DomainException($"Every choice in a combo must be a menu item{(facts ? " with an ERP item code" : "")}. Fix: {string.Join(", ", bad)}.");
    }

    private static async Task SetGroupsAsync(NpgsqlConnection c, NpgsqlTransaction tx, Guid companyId, Guid itemId, Guid[] groupIds)
    {
        await c.ExecuteAsync("delete from menu_item_modifier where item_id = @itemId", new { itemId }, tx);
        var i = 0;
        foreach (var g in groupIds.Distinct())
            await c.ExecuteAsync("insert into menu_item_modifier (company_id, item_id, group_id, sort) values (@companyId, @itemId, @g, @sort)", new { companyId, itemId, g, sort = i++ }, tx);
    }

    /// <summary>Options are matched by id: kept ones are updated, new ones added, missing ones switched off (old orders still name them).</summary>
    private static async Task SetOptionsAsync(NpgsqlConnection c, NpgsqlTransaction tx, Guid companyId, Guid groupId, OptionBody[] options)
    {
        var keep = options.Where(o => o.Id is not null).Select(o => o.Id!.Value).ToArray();
        await c.ExecuteAsync("update modifier_option set is_active = false where group_id = @groupId and not (id = any(@keep))", new { groupId, keep }, tx);
        var sort = 0;
        foreach (var o in options)
        {
            if (o.ItemId is { } itemId && !await c.ExecuteScalarAsync<bool>("select exists (select 1 from menu_item where id = @itemId and not is_combo)", new { itemId }, tx))
                throw new DomainException("A combo choice must be a menu item that isn't itself a combo.");
            var args = new { companyId, groupId, id = o.Id, name = o.Name.Trim(), price = Money.Round(o.Price), sort = sort++, active = o.IsActive ?? true, itemId = o.ItemId };
            if (o.Id is null)
                await c.ExecuteAsync("insert into modifier_option (company_id, group_id, name, price, sort, is_active, item_id) values (@companyId, @groupId, @name, @price, @sort, @active, @itemId)", args, tx);
            else if (await c.ExecuteAsync("update modifier_option set name = @name, price = @price, sort = @sort, is_active = @active, item_id = @itemId where id = @id and group_id = @groupId", args, tx) == 0)
                throw new DomainException("An option doesn't belong to this group.");
        }
    }
}
