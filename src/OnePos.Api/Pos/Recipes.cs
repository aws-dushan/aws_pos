using System.Text.Json;
using Dapper;
using Npgsql;
using OnePos.Api.Data;
using OnePos.Api.Platform;

namespace OnePos.Api.Pos;

/// <summary>
/// Recipes and ingredient stock (REQ INV-01, INV-02, INV-03). Ingredients have a unit and a cost; a menu item or a modifier option
/// has a recipe (how much of each ingredient one uses). A paid order takes its recipes off the branch's stock; returned "back to
/// stock" puts them back; wasted menu items take them off. The branch receives, throws away and counts ingredients. Editing
/// ingredients and recipes needs menu.manage; receiving and waste kitchen.view or day.manage; counts and adjustments day.manage.
/// </summary>
public static class Recipes
{
    public sealed record IngredientBody(string Name, string Unit, decimal Cost, decimal? ParLevel, bool? IsActive);
    public sealed record RecipeLineBody(Guid IngredientId, decimal Qty);
    public sealed record RecipeBody(RecipeLineBody[] Lines);
    public sealed record MoveLine(Guid IngredientId, decimal Qty, decimal? Cost);
    public sealed record MoveBody(string Kind, string? Note, MoveLine[] Lines);
    public sealed record CountLine(Guid IngredientId, decimal Counted);
    public sealed record CountBody(CountLine[] Lines, string? Note);

    private static readonly string[] Units = ["kg", "g", "l", "ml", "pcs"];

    public sealed class IngredientRow
    {
        public Guid Id { get; set; }
        public string Name { get; set; } = "";
        public string Unit { get; set; } = "";
        public decimal Cost { get; set; }
        public decimal? ParLevel { get; set; }
        public bool IsActive { get; set; }
        public decimal OnHand { get; set; }
        public DateTime? CountedAt { get; set; }
        public int Recipes { get; set; }
    }

    public sealed class RecipeRow
    {
        public Guid IngredientId { get; set; }
        public string Name { get; set; } = "";
        public string Unit { get; set; } = "";
        public decimal Qty { get; set; }
        public decimal Cost { get; set; }
        public decimal LineCost { get; set; }
    }

    public sealed class MoveRow
    {
        public DateTime At { get; set; }
        public DateOnly BusinessDate { get; set; }
        public string Kind { get; set; } = "";
        public decimal Qty { get; set; }
        public decimal Value { get; set; }
        public int? OrderNumber { get; set; }
        public string? Note { get; set; }
        public string? ByName { get; set; }
    }

    private const string IngredientSql = """
        select i.id, i.name, i.unit, i.cost, i.par_level, i.is_active, coalesce(bi.on_hand, 0) as on_hand, bi.counted_at,
               (select count(*) from recipe_line r where r.ingredient_id = i.id)::int as recipes
        from ingredient i left join branch_ingredient bi on bi.ingredient_id = i.id and bi.branch_id = @b
        """;

    // ---- What a sale uses ----

    private sealed record Usage(Guid Ingredient, decimal Qty, decimal Cost);

    /// <summary>The ingredients the given lines use: each item's recipe, and each chosen option's (or, for a combo choice
    /// without its own recipe, the chosen item's), times the quantity.</summary>
    private static async Task<List<Usage>> UsageAsync(NpgsqlConnection c, NpgsqlTransaction tx, IEnumerable<(Guid? ItemId, string Modifiers, decimal Qty)> lines)
    {
        var parts = new List<(Guid? Item, Guid? Option, Guid? OptionItem, decimal Qty)>();
        foreach (var l in lines)
        {
            if (l.Qty <= 0) continue;
            parts.Add((l.ItemId, null, null, l.Qty));
            using var mods = JsonDocument.Parse(string.IsNullOrEmpty(l.Modifiers) ? "[]" : l.Modifiers);
            foreach (var m in mods.RootElement.EnumerateArray())
            {
                Guid? opt = m.TryGetProperty("optionId", out var o) && o.ValueKind == JsonValueKind.String ? o.GetGuid() : null;
                Guid? item = m.TryGetProperty("itemId", out var i) && i.ValueKind == JsonValueKind.String ? i.GetGuid() : null;
                if (opt is not null || item is not null) parts.Add((null, opt, item, l.Qty));
            }
        }
        if (parts.Count == 0) return [];
        var items = parts.Select(p => p.Item ?? p.OptionItem).OfType<Guid>().Distinct().ToArray();
        var options = parts.Select(p => p.Option).OfType<Guid>().Distinct().ToArray();
        var recipe = (await c.QueryAsync<(Guid? ItemId, Guid? OptionId, Guid Ingredient, decimal Qty, decimal Cost)>("""
            select r.item_id, r.option_id, r.ingredient_id, r.qty, i.cost from recipe_line r join ingredient i on i.id = r.ingredient_id
            where r.item_id = any(@items) or r.option_id = any(@options)
            """, new { items, options }, tx)).ToList();
        var byItem = recipe.Where(r => r.ItemId is not null).ToLookup(r => r.ItemId!.Value);
        var byOption = recipe.Where(r => r.OptionId is not null).ToLookup(r => r.OptionId!.Value);
        var total = new Dictionary<Guid, (decimal Qty, decimal Cost)>();
        foreach (var p in parts)
        {
            var rows = p.Item is { } item ? byItem[item]
                : p.Option is { } opt && byOption[opt].Any() ? byOption[opt]
                : p.OptionItem is { } oi ? byItem[oi] : [];
            foreach (var r in rows)
            {
                var t = total.GetValueOrDefault(r.Ingredient);
                total[r.Ingredient] = (t.Qty + r.Qty * p.Qty, r.Cost);
            }
        }
        return total.Select(kv => new Usage(kv.Key, kv.Value.Qty, kv.Value.Cost)).ToList();
    }

    private static async Task ApplyAsync(NpgsqlConnection c, NpgsqlTransaction tx, Guid companyId, Guid branchId, DateOnly day, string kind, int sign,
        IEnumerable<Usage> usage, Guid? orderId, Guid? wastageId, Guid? userId, string? note = null)
    {
        foreach (var u in usage)
        {
            var qty = decimal.Round(u.Qty, 3, MidpointRounding.AwayFromZero) * sign;
            if (qty == 0) continue;
            await c.ExecuteAsync("""
                insert into branch_ingredient (company_id, branch_id, ingredient_id, on_hand) values (@companyId, @branchId, @ingredient, @qty)
                on conflict (branch_id, ingredient_id) do update set on_hand = branch_ingredient.on_hand + excluded.on_hand
                """, new { companyId, branchId, ingredient = u.Ingredient, qty }, tx);
            await c.ExecuteAsync("""
                insert into ingredient_move (company_id, branch_id, ingredient_id, business_date, kind, qty, cost, order_id, wastage_id, note, by_user)
                values (@companyId, @branchId, @ingredient, @day, @kind, @qty, @cost, @orderId, @wastageId, @note, @userId)
                """, new { companyId, branchId, ingredient = u.Ingredient, day, kind, qty, cost = u.Cost, orderId, wastageId, note, userId }, tx);
        }
    }

    /// <summary>
    /// Where the branch blocks short stock: the order (with what was just added) must not need more of the added item's
    /// ingredients than the branch has on hand. Throws, so the change is undone.
    /// </summary>
    public static async Task EnforceAsync(NpgsqlConnection c, NpgsqlTransaction tx, Orders.OrderRow o, (Guid? ItemId, string Modifiers)[] added)
    {
        if (await c.ExecuteScalarAsync<string>("select short_stock from branch where id = @BranchId", new { o.BranchId }, tx) != "block") return;
        var touched = (await UsageAsync(c, tx, added.Select(a => (a.ItemId, a.Modifiers, 1m)))).Select(u => u.Ingredient).ToHashSet();
        if (touched.Count == 0) return;
        var lines = await c.QueryAsync<(Guid? ItemId, string Modifiers, decimal Qty)>(
            "select item_id, modifiers::text, qty from order_line where order_id = @Id and not is_void", new { o.Id }, tx);
        var need = (await UsageAsync(c, tx, lines)).Where(u => touched.Contains(u.Ingredient)).ToList();
        var ids = need.Select(n => n.Ingredient).ToArray();
        var have = (await c.QueryAsync<(Guid Id, string Name, string Unit, decimal? OnHand)>("""
            select i.id, i.name, i.unit, bi.on_hand from ingredient i left join branch_ingredient bi on bi.ingredient_id = i.id and bi.branch_id = @BranchId where i.id = any(@ids)
            """, new { o.BranchId, ids }, tx)).ToDictionary(x => x.Id);
        foreach (var n in need)
        {
            var h = have[n.Ingredient];
            var left = Math.Max(0, h.OnHand ?? 0);
            if (n.Qty > left)
                throw new DomainException($"Not enough {h.Name}: this order needs {n.Qty:0.###} {h.Unit}, {left:0.###} {h.Unit} left. Receive it on the Ingredients screen, or sell something else.");
        }
    }

    /// <summary>A paid order: its recipes come off the branch's ingredient stock (once).</summary>
    public static async Task ConsumeAsync(NpgsqlConnection c, NpgsqlTransaction tx, Guid orderId, Guid userId)
    {
        if (await c.ExecuteScalarAsync<bool>("select exists (select 1 from ingredient_move where order_id = @orderId and kind = 'sale')", new { orderId }, tx)) return;
        var o = await c.QuerySingleAsync<(Guid CompanyId, Guid BranchId, DateOnly Day)>("select company_id, branch_id, business_date from pos_order where id = @orderId", new { orderId }, tx);
        var lines = await c.QueryAsync<(Guid? ItemId, string Modifiers, decimal Qty)>(
            "select item_id, modifiers::text, qty from order_line where order_id = @orderId and not is_void", new { orderId }, tx);
        await ApplyAsync(c, tx, o.CompanyId, o.BranchId, o.Day, "sale", -1, await UsageAsync(c, tx, lines), orderId, null, userId);
    }

    /// <summary>Items returned "back to stock": their recipes go back on (in the day of the return).</summary>
    public static async Task RestockAsync(NpgsqlConnection c, NpgsqlTransaction tx, Orders.OrderRow o, IEnumerable<(Orders.LineRow Line, decimal Qty)> lines, Guid userId)
    {
        var list = lines.ToList();
        if (list.Count == 0) return;
        var day = await Days.DateAsync(c, tx, o.BranchId);
        var usage = await UsageAsync(c, tx, list.Select(l => (l.Line.ItemId, l.Line.Modifiers, l.Qty)));
        await ApplyAsync(c, tx, o.CompanyId, o.BranchId, day, "return", 1, usage, o.Id, null, userId);
    }

    /// <summary>A menu item thrown away: its recipe comes off; taking the wastage off puts it back.</summary>
    public static async Task WasteItemAsync(NpgsqlConnection c, NpgsqlTransaction tx, Guid companyId, Guid branchId, DateOnly day, Guid itemId, decimal qty, Guid wastageId, Guid userId)
    {
        var usage = await UsageAsync(c, tx, [(itemId, "[]", qty)]);
        await ApplyAsync(c, tx, companyId, branchId, day, "waste", -1, usage, null, wastageId, userId);
    }

    public static async Task UnwasteItemAsync(NpgsqlConnection c, NpgsqlTransaction tx, Guid wastageId, Guid userId)
    {
        var moves = (await c.QueryAsync<(Guid CompanyId, Guid BranchId, DateOnly Day, Guid Ingredient, decimal Qty, decimal Cost)>(
            "select company_id, branch_id, business_date, ingredient_id, qty, cost from ingredient_move where wastage_id = @wastageId", new { wastageId }, tx)).ToList();
        foreach (var g in moves.GroupBy(m => (m.CompanyId, m.BranchId, m.Day)))
            await ApplyAsync(c, tx, g.Key.CompanyId, g.Key.BranchId, g.Key.Day, "waste", -1, g.Select(m => new Usage(m.Ingredient, m.Qty, m.Cost)), null, wastageId, userId, "Wastage taken off");
    }

    // ---- Recipes ----

    private static async Task<object> RecipeAsync(NpgsqlConnection c, NpgsqlTransaction tx, string column, Guid id, decimal? price)
    {
        var lines = (await c.QueryAsync<RecipeRow>($"""
            select r.ingredient_id, i.name, i.unit, r.qty, i.cost, round(r.qty * i.cost, 4) as line_cost
            from recipe_line r join ingredient i on i.id = r.ingredient_id where r.{column} = @id order by i.name
            """, new { id }, tx)).ToList();
        var cost = Money.Round(lines.Sum(l => l.LineCost));
        return new { lines, cost, price, costPct = price > 0 ? decimal.Round(cost / price.Value * 100, 1, MidpointRounding.AwayFromZero) : (decimal?)null };
    }

    private static async Task SaveRecipeAsync(NpgsqlConnection c, NpgsqlTransaction tx, Guid companyId, string column, Guid id, RecipeLineBody[] lines)
    {
        if (lines.Any(l => l.Qty <= 0 || l.Qty > 100_000)) throw new DomainException("Each ingredient needs an amount above zero.");
        if (lines.Select(l => l.IngredientId).Distinct().Count() != lines.Length) throw new DomainException("An ingredient is in the recipe twice.");
        var ids = lines.Select(l => l.IngredientId).ToArray();
        if (await c.ExecuteScalarAsync<int>("select count(*) from ingredient where id = any(@ids)", new { ids }, tx) != ids.Length)
            throw new DomainException("An ingredient in the recipe doesn't exist.");
        await c.ExecuteAsync($"delete from recipe_line where {column} = @id", new { id }, tx);
        foreach (var l in lines)
            await c.ExecuteAsync($"insert into recipe_line (company_id, {column}, ingredient_id, qty) values (@companyId, @id, @IngredientId, @Qty)",
                new { companyId, id, l.IngredientId, l.Qty }, tx);
    }

    private static IngredientBody Clean(IngredientBody b)
    {
        var name = (b.Name ?? "").Trim();
        if (name.Length is 0 or > 80) throw new DomainException("An ingredient needs a name (up to 80 characters).");
        var unit = (b.Unit ?? "").Trim().ToLowerInvariant();
        if (!Units.Contains(unit)) throw new DomainException("The unit is kg, g, l, ml or pcs.");
        if (b.Cost is < 0 or > 100_000) throw new DomainException("The cost per unit is 0 to 100,000.");
        if (b.ParLevel is < 0) throw new DomainException("The low-stock level can't be negative.");
        return b with { Name = name, Unit = unit };
    }

    private static void CanStock(Scope scope)
    {
        if (!scope.Can("day.manage") && !scope.Can("kitchen.view") && !scope.Can("menu.manage")) scope.Require("day.manage");
    }

    public static void Map(RouteGroupBuilder api)
    {
        api.MapGet("/ingredients", async (HttpContext http, Db db) =>
        {
            var scope = await http.ScopeAsync(db);
            CanStock(scope);
            return await db.Company(scope.CompanyId, (c, tx) => c.QueryAsync<IngredientRow>($"{IngredientSql} order by i.is_active desc, i.name", new { b = scope.Branch }, tx));
        });

        api.MapPost("/ingredients", async (IngredientBody body, HttpContext http, Db db, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("menu.manage");
            var b = Clean(body);
            var row = await db.Company(scope.CompanyId, async (c, tx) =>
            {
                if (await c.ExecuteScalarAsync<bool>("select exists (select 1 from ingredient where lower(name) = lower(@Name))", new { b.Name }, tx))
                    throw new ConflictException($"There's already an ingredient called {b.Name}.");
                var id = await c.ExecuteScalarAsync<Guid>("""
                    insert into ingredient (company_id, name, unit, cost, par_level, is_active) values (@co, @Name, @Unit, @Cost, @ParLevel, coalesce(@IsActive, true)) returning id
                    """, new { co = scope.CompanyId, b.Name, b.Unit, b.Cost, b.ParLevel, b.IsActive }, tx);
                await Audit.RecordAsync(c, tx, scope.CompanyId, null, scope.UserId, "ingredient", id.ToString(), "created", $"Ingredient {b.Name} ({b.Unit}) added");
                return await c.QuerySingleAsync<IngredientRow>($"{IngredientSql} where i.id = @id", new { id, b = scope.BranchId }, tx);
            });
            await live.ToCompany(scope.CompanyId, "stock.changed");
            return Results.Ok(row);
        });

        api.MapPut("/ingredients/{id:guid}", async (Guid id, IngredientBody body, HttpContext http, Db db, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("menu.manage");
            var b = Clean(body);
            var row = await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var old = await c.QuerySingleOrDefaultAsync<IngredientRow>("select *, 0 as on_hand, 0 as recipes from ingredient where id = @id for update", new { id }, tx)
                          ?? throw new NotFoundException("Ingredient not found.");
                if (await c.ExecuteScalarAsync<bool>("select exists (select 1 from ingredient where lower(name) = lower(@Name) and id <> @id)", new { b.Name, id }, tx))
                    throw new ConflictException($"There's already an ingredient called {b.Name}.");
                if (old.Unit != b.Unit && await c.ExecuteScalarAsync<bool>("select exists (select 1 from recipe_line where ingredient_id = @id) or exists (select 1 from ingredient_move where ingredient_id = @id)", new { id }, tx))
                    throw new DomainException("The unit can't change once the ingredient is in a recipe or has stock moves; add a new ingredient instead.");
                await c.ExecuteAsync("update ingredient set name = @Name, unit = @Unit, cost = @Cost, par_level = @ParLevel, is_active = coalesce(@IsActive, is_active) where id = @id",
                    new { id, b.Name, b.Unit, b.Cost, b.ParLevel, b.IsActive }, tx);
                await Audit.RecordAsync(c, tx, scope.CompanyId, null, scope.UserId, "ingredient", id.ToString(), "changed", $"Ingredient {old.Name} changed",
                    [new("Name", old.Name, b.Name), new("Unit", old.Unit, b.Unit), new("Cost", old.Cost, b.Cost), new("Low level", old.ParLevel, b.ParLevel), new("Active", old.IsActive, b.IsActive ?? old.IsActive)]);
                return await c.QuerySingleAsync<IngredientRow>($"{IngredientSql} where i.id = @id", new { id, b = scope.BranchId }, tx);
            });
            await live.ToCompany(scope.CompanyId, "stock.changed");
            return Results.Ok(row);
        });

        // A menu item's recipe, with its cost against the price (food cost %).
        api.MapGet("/recipes/item/{id:guid}", async (Guid id, HttpContext http, Db db) =>
        {
            var scope = await http.ScopeAsync(db);
            CanStock(scope);
            return await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var price = await c.ExecuteScalarAsync<decimal?>("select price from menu_item where id = @id", new { id }, tx) ?? throw new NotFoundException("Item not found.");
                return await RecipeAsync(c, tx, "item_id", id, price);
            });
        });

        api.MapPut("/recipes/item/{id:guid}", async (Guid id, RecipeBody body, HttpContext http, Db db, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("menu.manage");
            var result = await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var item = await c.QuerySingleOrDefaultAsync<(string Name, decimal Price)>("select name, price from menu_item where id = @id", new { id }, tx);
                if (item.Name is null) throw new NotFoundException("Item not found.");
                await SaveRecipeAsync(c, tx, scope.CompanyId, "item_id", id, body.Lines ?? []);
                await Audit.RecordAsync(c, tx, scope.CompanyId, null, scope.UserId, "menu_item", id.ToString(), "recipe", $"Recipe of {item.Name}: {(body.Lines ?? []).Length} ingredient(s)");
                return await RecipeAsync(c, tx, "item_id", id, item.Price);
            });
            await live.ToCompany(scope.CompanyId, "menu.changed");
            return Results.Ok(result);
        });

        api.MapGet("/recipes/option/{id:guid}", async (Guid id, HttpContext http, Db db) =>
        {
            var scope = await http.ScopeAsync(db);
            CanStock(scope);
            return await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var price = await c.ExecuteScalarAsync<decimal?>("select price from modifier_option where id = @id", new { id }, tx) ?? throw new NotFoundException("Option not found.");
                return await RecipeAsync(c, tx, "option_id", id, price);
            });
        });

        api.MapPut("/recipes/option/{id:guid}", async (Guid id, RecipeBody body, HttpContext http, Db db, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("menu.manage");
            var result = await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var opt = await c.QuerySingleOrDefaultAsync<(string Name, decimal Price)>("select name, price from modifier_option where id = @id", new { id }, tx);
                if (opt.Name is null) throw new NotFoundException("Option not found.");
                await SaveRecipeAsync(c, tx, scope.CompanyId, "option_id", id, body.Lines ?? []);
                await Audit.RecordAsync(c, tx, scope.CompanyId, null, scope.UserId, "modifier_option", id.ToString(), "recipe", $"Recipe of option {opt.Name}: {(body.Lines ?? []).Length} ingredient(s)");
                return await RecipeAsync(c, tx, "option_id", id, opt.Price);
            });
            await live.ToCompany(scope.CompanyId, "menu.changed");
            return Results.Ok(result);
        });

        // Every menu item's recipe cost against its price (this branch's price where it has one).
        api.MapGet("/recipes/costs", async (HttpContext http, Db db) =>
        {
            var scope = await http.ScopeAsync(db);
            CanStock(scope);
            return await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var rows = await c.QueryAsync<(Guid Id, string Name, string Category, decimal Price, int Ingredients, decimal Cost)>("""
                    select m.id, m.name, mc.name, coalesce(bi.price, m.price), count(r.id)::int, coalesce(sum(r.qty * i.cost), 0)
                    from menu_item m join menu_category mc on mc.id = m.category_id
                    left join branch_item bi on bi.item_id = m.id and bi.branch_id = @b
                    left join recipe_line r on r.item_id = m.id left join ingredient i on i.id = r.ingredient_id
                    where m.is_active group by m.id, m.name, mc.name, bi.price, m.price, mc.sort, m.sort order by mc.sort, m.sort, m.name
                    """, new { b = scope.Branch }, tx);
                return rows.Select(r => new
                {
                    r.Id, r.Name, r.Category, r.Price, r.Ingredients, cost = Money.Round(r.Cost),
                    costPct = r.Ingredients > 0 && r.Price > 0 ? decimal.Round(Money.Round(r.Cost) / r.Price * 100, 1, MidpointRounding.AwayFromZero) : (decimal?)null,
                });
            });
        });

        // Received, thrown away, or (managers) corrected by an amount. A delivery can bring a new cost per unit.
        api.MapPost("/ingredients/moves", async (MoveBody body, HttpContext http, Db db, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            var kind = (body.Kind ?? "").Trim().ToLowerInvariant();
            if (kind is not ("receive" or "waste" or "adjust")) throw new DomainException("Receive, waste or adjust.");
            if (kind == "adjust") scope.Require("day.manage"); else CanStock(scope);
            var lines = body.Lines ?? [];
            if (lines.Length == 0) throw new DomainException("Add at least one ingredient.");
            if (kind != "adjust" && lines.Any(l => l.Qty <= 0)) throw new DomainException("Each amount is above zero.");
            if (lines.Any(l => l.Qty == 0 || Math.Abs(l.Qty) > 1_000_000)) throw new DomainException("Each amount is between 0 and 1,000,000.");
            if (kind == "waste" && string.IsNullOrWhiteSpace(body.Note)) throw new DomainException("Say why it was thrown away.");
            var note = string.IsNullOrWhiteSpace(body.Note) ? null : body.Note.Trim();
            await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var day = (await Days.CurrentAsync(c, tx, scope.Branch, scope.UserId)).Date;
                var ids = lines.Select(l => l.IngredientId).ToArray();
                var known = (await c.QueryAsync<(Guid Id, string Name, decimal Cost)>("select id, name, cost from ingredient where id = any(@ids)", new { ids }, tx)).ToDictionary(x => x.Id);
                if (known.Count != ids.Distinct().Count()) throw new DomainException("An ingredient doesn't exist.");
                foreach (var l in lines)
                {
                    var cost = known[l.IngredientId].Cost;
                    if (kind == "receive" && l.Cost is { } newCost and >= 0 && newCost != cost)
                    {
                        await c.ExecuteAsync("update ingredient set cost = @newCost where id = @IngredientId", new { newCost, l.IngredientId }, tx);
                        cost = newCost;
                    }
                    await ApplyAsync(c, tx, scope.CompanyId, scope.Branch, day, kind, kind == "waste" ? -1 : 1, [new Usage(l.IngredientId, l.Qty, cost)], null, null, scope.UserId, note);
                }
                await Audit.RecordAsync(c, tx, scope.CompanyId, scope.Branch, scope.UserId, "ingredient", null, kind,
                    $"Ingredients {(kind == "receive" ? "received" : kind == "waste" ? "thrown away" : "adjusted")}: {string.Join(", ", lines.Select(l => $"{l.Qty:0.###} {known[l.IngredientId].Name}"))}", note: note);
                return 0;
            });
            await live.ToBranch(scope.Branch, "stock.changed");
            return Results.Ok(new { ok = true });
        });

        // A stock count: what's on the shelf becomes what's on hand; the difference is the count's variance.
        api.MapPost("/ingredients/count", async (CountBody body, HttpContext http, Db db, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("day.manage");
            var lines = body.Lines ?? [];
            if (lines.Length == 0) throw new DomainException("Count at least one ingredient.");
            if (lines.Any(l => l.Counted < 0)) throw new DomainException("A count can't be below zero.");
            var result = await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var day = (await Days.CurrentAsync(c, tx, scope.Branch, scope.UserId)).Date;
                var variance = 0m;
                foreach (var l in lines)
                {
                    var cur = await c.QuerySingleOrDefaultAsync<(Guid Id, decimal Cost, decimal? OnHand)>("""
                        select i.id, i.cost, bi.on_hand from ingredient i left join branch_ingredient bi on bi.ingredient_id = i.id and bi.branch_id = @b where i.id = @IngredientId
                        """, new { b = scope.Branch, l.IngredientId }, tx);
                    if (cur.Id == Guid.Empty) throw new DomainException("An ingredient doesn't exist.");
                    var diff = l.Counted - (cur.OnHand ?? 0);
                    if (diff != 0) await ApplyAsync(c, tx, scope.CompanyId, scope.Branch, day, "count", 1, [new Usage(l.IngredientId, diff, cur.Cost)], null, null, scope.UserId, body.Note);
                    await c.ExecuteAsync("""
                        insert into branch_ingredient (company_id, branch_id, ingredient_id, on_hand, counted_at) values (@co, @b, @IngredientId, @Counted, now())
                        on conflict (branch_id, ingredient_id) do update set counted_at = now()
                        """, new { co = scope.CompanyId, b = scope.Branch, l.IngredientId, l.Counted }, tx);
                    variance += Money.Round(diff * cur.Cost);
                }
                await Audit.RecordAsync(c, tx, scope.CompanyId, scope.Branch, scope.UserId, "ingredient", null, "count", $"Stock count of {lines.Length} ingredient(s), variance {variance:N2}", note: body.Note);
                return new { counted = lines.Length, variance };
            });
            await live.ToBranch(scope.Branch, "stock.changed");
            return Results.Ok(result);
        });

        api.MapGet("/ingredients/{id:guid}/moves", async (Guid id, HttpContext http, Db db, int? days) =>
        {
            var scope = await http.ScopeAsync(db);
            CanStock(scope);
            return await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var since = (await Days.DateAsync(c, tx, scope.Branch)).AddDays(-Math.Clamp(days ?? 14, 1, 365));
                return await c.QueryAsync<MoveRow>("""
                    select m.at, m.business_date, m.kind, m.qty, round(m.qty * m.cost, 2) as value, o.number as order_number, m.note, u.display_name as by_name from ingredient_move m
                    left join pos_order o on o.id = m.order_id left join app_user u on u.id = m.by_user
                    where m.ingredient_id = @id and m.branch_id = @b and m.business_date >= @since order by m.at desc limit 500
                    """, new { id, b = scope.Branch, since }, tx);
            });
        });

        // Usage over business days: what sales, returns and waste took (the theoretical usage), what came in, and the counts' variance.
        api.MapGet("/ingredients/usage", async (HttpContext http, Db db, DateOnly from, DateOnly to) =>
        {
            var scope = await http.ScopeAsync(db);
            if (!scope.Can("reports.view")) scope.Require("day.manage");
            if (to < from || to.DayNumber - from.DayNumber > 366) throw new DomainException("Choose up to a year, from before to.");
            return await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var rows = (await c.QueryAsync<(Guid Id, string Name, string Unit, string Kind, decimal Qty, decimal Value)>("""
                    select i.id, i.name, i.unit, m.kind, sum(m.qty), sum(m.qty * m.cost) from ingredient_move m join ingredient i on i.id = m.ingredient_id
                    where m.branch_id = @b and m.business_date between @from and @to group by i.id, i.name, i.unit, m.kind
                    """, new { b = scope.Branch, from, to }, tx)).ToList();
                // Against the sales (before VAT) of items that have a recipe, on orders that took ingredients off (sold since it had one),
                // so items without a recipe don't make the share look small.
                var sales = await c.ExecuteScalarAsync<decimal>("""
                    select coalesce(sum(l.line_total - l.discount - case when o.prices_include_vat then l.vat else 0 end), 0) from order_line l join pos_order o on o.id = l.order_id
                    where o.branch_id = @b and o.business_date between @from and @to and o.status = 'paid' and not l.is_void
                      and exists (select 1 from recipe_line r where r.item_id = l.item_id)
                      and exists (select 1 from ingredient_move m where m.order_id = o.id and m.kind = 'sale')
                    """, new { b = scope.Branch, from, to }, tx);
                decimal Q(IEnumerable<(Guid, string, string, string Kind, decimal Qty, decimal)> g, string k) => -g.Where(r => r.Kind == k).Sum(r => r.Qty);
                decimal V(IEnumerable<(Guid, string, string, string Kind, decimal, decimal Value)> g, string k) => Money.Round(-g.Where(r => r.Kind == k).Sum(r => r.Value));
                var items = rows.GroupBy(r => (r.Id, r.Name, r.Unit)).Select(g => new
                {
                    id = g.Key.Id, name = g.Key.Name, unit = g.Key.Unit,
                    sold = Q(g, "sale") - g.Where(r => r.Kind == "return").Sum(r => r.Qty), wasted = Q(g, "waste"),
                    received = -Q(g, "receive"), variance = -Q(g, "count"), adjusted = -Q(g, "adjust"),
                    soldValue = V(g, "sale") + V(g, "return"), wastedValue = V(g, "waste"), receivedValue = -V(g, "receive"), varianceValue = -V(g, "count"),
                }).OrderByDescending(x => x.soldValue).ToList();
                var cost = items.Sum(i => i.soldValue);
                return new
                {
                    from, to, items, netSales = sales, soldCost = cost, wastedCost = items.Sum(i => i.wastedValue), varianceCost = items.Sum(i => i.varianceValue),
                    foodCostPct = sales > 0 ? decimal.Round(cost / sales * 100, 1, MidpointRounding.AwayFromZero) : (decimal?)null,
                };
            });
        });
    }
}
