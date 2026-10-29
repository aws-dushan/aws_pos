using Dapper;
using Npgsql;
using OnePos.Api.Data;
using OnePos.Api.Platform;

namespace OnePos.Api.Pos;

/// <summary>
/// Discounts (approved 19-10-2026, "One POS - Discounts for approval"):
///   promotions — automatic, set up in the back office: % off, AED off each, or a fixed price, on all items / categories / items,
///     from a date (end date optional), on chosen days and hours, at chosen branches, in store and/or on delivery platforms;
///   cashier discounts — a ready-made list (% or AED, the whole bill or one item), each for chosen roles, a name/reason if needed;
///   typed discounts — % or AED on the bill or an item, within the user's role limit (above it a manager approves on the till);
///   platform offers — on a platform's order: "we pay" is a bill discount, "platform pays" is only noted.
/// An item never gets two discounts: it gets the bigger of its own and its share of the bill discount (Totals.Compute).
/// </summary>
public static class Discounts
{
    public sealed record DiscountBody(string Kind, string Name, string Type, decimal Value, string? AppliesTo, Guid[]? CategoryIds, Guid[]? ItemIds,
        string? Target, Guid[]? RoleIds, bool? NeedsNote, DateOnly? ValidFrom, DateOnly? ValidTo, int[]? Days, TimeOnly? TimeFrom, TimeOnly? TimeTo,
        Guid[]? BranchIds, string? Channel, Guid? PlatformId, bool? IsActive);
    /// <summary>On the till: a listed discount (DiscountId), or a typed one (Pct or Amount); Clear takes the discount off.</summary>
    public sealed record ApplyBody(Guid? DiscountId, decimal? Pct, decimal? Amount, string? Note, bool? Clear);
    public sealed record PlatformOfferBody(decimal Amount, string PaidBy, string? Note);

    public sealed class Row
    {
        public Guid Id { get; set; }
        public string Kind { get; set; } = "";
        public string Name { get; set; } = "";
        public string Type { get; set; } = "";
        public decimal Value { get; set; }
        public string AppliesTo { get; set; } = "all";
        public Guid[] CategoryIds { get; set; } = [];
        public Guid[] ItemIds { get; set; } = [];
        public string Target { get; set; } = "bill";
        public Guid[] RoleIds { get; set; } = [];
        public bool NeedsNote { get; set; }
        public DateOnly ValidFrom { get; set; }
        public DateOnly? ValidTo { get; set; }
        public short[] Days { get; set; } = [];
        public TimeOnly? TimeFrom { get; set; }
        public TimeOnly? TimeTo { get; set; }
        public Guid[] BranchIds { get; set; } = [];
        public string Channel { get; set; } = "all";
        public Guid? PlatformId { get; set; }
        public bool IsActive { get; set; }
    }

    /// <summary>
    /// The best promotion for one unit of an item added now (none on a combo: it has its bundle price). Valid on the branch's
    /// local date, day and time, at this branch, for this kind of order (in store, or this delivery platform).
    /// </summary>
    public static async Task<(Guid Id, string Name, string Type, decimal Value)?> BestPromotionAsync(NpgsqlConnection c, NpgsqlTransaction tx,
        Orders.OrderRow o, Guid itemId, decimal unitPrice)
    {
        var it = await c.QuerySingleAsync<(Guid CategoryId, bool IsCombo, string Tz)>(
            "select i.category_id, i.is_combo, b.time_zone from menu_item i, branch b where i.id = @itemId and b.id = @BranchId", new { itemId, o.BranchId }, tx);
        if (it.IsCombo || unitPrice <= 0) return null;
        var local = TimeZoneInfo.ConvertTimeFromUtc(DateTime.UtcNow, BusinessClock.Zone(it.Tz));
        var day = DateOnly.FromDateTime(local);
        var dow = (short)(local.DayOfWeek == DayOfWeek.Sunday ? 7 : (int)local.DayOfWeek);
        var time = TimeOnly.FromDateTime(local);
        var promos = await c.QueryAsync<Row>("""
            select * from discount
            where kind = 'promotion' and is_active and valid_from <= @day and (valid_to is null or valid_to >= @day)
              and (cardinality(days) = 0 or @dow = any(days))
              and (cardinality(branch_ids) = 0 or @BranchId = any(branch_ids))
              and (applies_to = 'all' or (applies_to = 'categories' and @CategoryId = any(category_ids)) or (applies_to = 'items' and @itemId = any(item_ids)))
              and (channel = 'all' or (channel = 'instore' and @platform is null) or (channel = 'platforms' and @platform is not null)
                   or (channel = 'platform' and platform_id = @platform))
            """, new { day, dow, o.BranchId, it.CategoryId, itemId, platform = o.PlatformId }, tx);
        var best = promos.Where(p => InTime(p, time))
            .Select(p => (p, off: Totals.Own(unitPrice, 1, p.Type, p.Value)))
            .Where(x => x.off > 0).OrderByDescending(x => x.off).FirstOrDefault();
        return best.p is null ? null : (best.p.Id, best.p.Name, best.p.Type, best.p.Value);
    }

    /// <summary>Inside the promotion's hours (none set: all day; a window past midnight, e.g. 22:00–02:00, works too).</summary>
    private static bool InTime(Row p, TimeOnly t) => (p.TimeFrom, p.TimeTo) switch
    {
        (null, null) => true,
        ({ } f, null) => t >= f,
        (null, { } e) => t < e,
        ({ } f, { } e) => f <= e ? t >= f && t < e : t >= f || t < e,
    };

    private static async Task<Guid?> RoleOfAsync(NpgsqlConnection c, NpgsqlTransaction tx, Scope scope) =>
        await c.ExecuteScalarAsync<Guid?>("select role_id from user_company where user_id = @UserId and company_id = @CompanyId", new { scope.UserId, scope.CompanyId }, tx);

    /// <summary>
    /// May this user give this discount? A listed one: its roles (none listed: anyone allowed to discount, within their limit). A typed
    /// one: up to the role's limit; above it a manager approves on the till. A delivery platform's order has no limit: its discounts
    /// are the platform's (own delivery keeps the limit).
    /// </summary>
    private static async Task CheckAsync(NpgsqlConnection c, NpgsqlTransaction tx, HttpContext http, Scope scope, Guid orderId, Row? listed, decimal pctOfValue, bool platformOrder)
    {
        scope.Require("pos.discount");
        if (listed is not null && listed.RoleIds.Length > 0)
        {
            if (scope.IsAdmin) return;
            var role = await RoleOfAsync(c, tx, scope);
            if (role is null || !listed.RoleIds.Contains(role.Value)) throw new ForbiddenException($"Your role can't give \"{listed.Name}\". A manager can.");
            return;   // the discount was made for these roles: its value is what they may give
        }
        if (platformOrder) return;
        if (scope.Limit("maxDiscountPct") is { } max && pctOfValue > max + 0.004m)
            await Approvals.RequireAsync(c, tx, http, scope, "discount", Math.Round(pctOfValue, 2, MidpointRounding.AwayFromZero),
                $"Your role allows discounts up to {max:0.##} %. A manager can approve {pctOfValue:0.##} %.", orderId: orderId);
    }

    /// <summary>A listed cashier discount, given at one of its branches (none listed: every branch).</summary>
    private static async Task<Row> ListedAsync(NpgsqlConnection c, NpgsqlTransaction tx, Guid id, string target, Guid branchId)
    {
        var d = await c.QuerySingleOrDefaultAsync<Row>("""
            select * from discount where id = @id and kind = 'cashier' and is_active and (cardinality(branch_ids) = 0 or @branchId = any(branch_ids))
            """, new { id, branchId }, tx) ?? throw new DomainException("That discount isn't available at this branch.");
        if (d.Target != target) throw new DomainException(target == "bill" ? $"\"{d.Name}\" is for one item, not the whole bill." : $"\"{d.Name}\" is for the whole bill.");
        return d;
    }

    private static string? Opt(string? v) => string.IsNullOrWhiteSpace(v) ? null : v.Trim();

    public static void Map(RouteGroupBuilder api)
    {
        // ---------------- Back office ----------------
        // The header branch's discounts: its own and those for every branch (all=true: the whole company's).
        api.MapGet("/discounts", async (HttpContext http, Db db, bool? all) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("menu.manage");
            var only = all == true ? (Guid?)null : scope.Branch;
            return await db.Company(scope.CompanyId, async (c, tx) => Results.Ok(new
            {
                discounts = await c.QueryAsync<Row>("""
                    select * from discount where @only::uuid is null or cardinality(branch_ids) = 0 or @only = any(branch_ids) order by kind, is_active desc, name
                    """, new { only }, tx),
                today = scope.BranchId is { } b ? await Days.DateAsync(c, tx, b) : BusinessClock.Today("Asia/Dubai"),
            }));
        });

        api.MapPost("/discounts", async (DiscountBody body, HttpContext http, Db db) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("menu.manage");
            var d = Clean(body);
            return await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var id = await c.ExecuteScalarAsync<Guid>("""
                    insert into discount (company_id, kind, name, type, value, applies_to, category_ids, item_ids, target, role_ids, needs_note, valid_from, valid_to,
                                          days, time_from, time_to, branch_ids, channel, platform_id, is_active, created_by)
                    values (@co, @Kind, @Name, @Type, @Value, @AppliesTo, @CategoryIds, @ItemIds, @Target, @RoleIds, @NeedsNote, @ValidFrom, @ValidTo,
                            @Days, @TimeFrom, @TimeTo, @BranchIds, @Channel, @PlatformId, @IsActive, @user) returning id
                    """, new { co = scope.CompanyId, d.Kind, d.Name, d.Type, d.Value, d.AppliesTo, d.CategoryIds, d.ItemIds, d.Target, d.RoleIds, d.NeedsNote, d.ValidFrom, d.ValidTo,
                               d.Days, d.TimeFrom, d.TimeTo, d.BranchIds, d.Channel, d.PlatformId, d.IsActive, user = scope.UserId }, tx);
                await Audit.RecordAsync(c, tx, scope.CompanyId, scope.BranchId, scope.UserId, "discount", id.ToString(), "created", $"{(d.Kind == "promotion" ? "Promotion" : "Cashier discount")} \"{d.Name}\" created");
                return Results.Ok(new { id });
            });
        });

        // Changing a discount applies to what is added from now on; bills already rung keep what they got.
        api.MapPut("/discounts/{id:guid}", async (Guid id, DiscountBody body, HttpContext http, Db db) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("menu.manage");
            var d = Clean(body);
            return await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var n = await c.ExecuteAsync("""
                    update discount set name = @Name, type = @Type, value = @Value, applies_to = @AppliesTo, category_ids = @CategoryIds, item_ids = @ItemIds, target = @Target,
                      role_ids = @RoleIds, needs_note = @NeedsNote, valid_from = @ValidFrom, valid_to = @ValidTo, days = @Days, time_from = @TimeFrom, time_to = @TimeTo,
                      branch_ids = @BranchIds, channel = @Channel, platform_id = @PlatformId, is_active = @IsActive
                    where id = @id and kind = @Kind
                    """, new { id, d.Kind, d.Name, d.Type, d.Value, d.AppliesTo, d.CategoryIds, d.ItemIds, d.Target, d.RoleIds, d.NeedsNote, d.ValidFrom, d.ValidTo,
                               d.Days, d.TimeFrom, d.TimeTo, d.BranchIds, d.Channel, d.PlatformId, d.IsActive }, tx);
                if (n == 0) throw new NotFoundException("That discount no longer exists.");
                await Audit.RecordAsync(c, tx, scope.CompanyId, scope.BranchId, scope.UserId, "discount", id.ToString(), "changed", $"Discount \"{d.Name}\" changed{(d.IsActive ? "" : " (switched off)")}");
                return Results.Ok(new { id });
            });
        });

        // ---------------- The till ----------------
        // The cashier discounts this user may give (by role) at this branch, for the Discount window.
        api.MapGet("/pos/discounts", async (HttpContext http, Db db) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("pos.sell");
            return await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var role = await RoleOfAsync(c, tx, scope);
                var all = await c.QueryAsync<Row>("""
                    select * from discount where kind = 'cashier' and is_active and (cardinality(branch_ids) = 0 or @b = any(branch_ids)) order by name
                    """, new { b = scope.Branch }, tx);
                return Results.Ok(new
                {
                    canDiscount = scope.Can("pos.discount"),
                    limitPct = scope.IsAdmin ? null : scope.Limit("maxDiscountPct"),
                    discounts = all.Where(d => scope.IsAdmin || d.RoleIds.Length == 0 || (role is { } r && d.RoleIds.Contains(r)))
                        .Select(d => new { d.Id, d.Name, d.Type, d.Value, d.Target, d.NeedsNote }),
                });
            });
        });

        // The whole bill: a listed discount, a typed % or AED, or none.
        api.MapPost("/orders/{id:guid}/discount", (Guid id, ApplyBody body, HttpContext http, Db db, Live live) => Orders.Mutate(http, db, live, id, "pos.sell", async (c, tx, o, scope) =>
        {
            if (body.Clear == true || (body.DiscountId is null && (body.Pct ?? 0) == 0 && (body.Amount ?? 0) == 0))
            {
                await c.ExecuteAsync("""
                    update pos_order set discount_pct = 0, discount_amount = 0, discount_source = null, discount_id = null, discount_name = null, discount_note = null, discount_by = null where id = @id
                    """, new { id }, tx);
                await Audit.RecordAsync(c, tx, o.CompanyId, o.BranchId, scope.UserId, "order", id.ToString(), "discount", $"Order #{o.Number}: bill discount taken off");
                return;
            }
            var listed = body.DiscountId is { } did ? await ListedAsync(c, tx, did, "bill", o.BranchId) : null;
            var pct = listed is not null ? (listed.Type == "pct" ? listed.Value : 0) : body.Pct ?? 0;
            var amount = listed is not null ? (listed.Type == "amount" ? listed.Value : 0) : pct > 0 ? 0 : body.Amount ?? 0;
            if (pct is < 0 or > 100) throw new DomainException("A discount is between 0 and 100 %.");
            if (amount < 0) throw new DomainException("A discount can't be negative.");
            var note = Opt(body.Note);
            if (listed is { NeedsNote: true } && note is null) throw new DomainException($"\"{listed.Name}\" needs a name or reason.");
            var subtotal = await c.ExecuteScalarAsync<decimal>("select coalesce(sum(round(unit_price * qty, 2)), 0) from order_line where order_id = @id and not is_void", new { id }, tx);
            if (amount > 0 && amount > subtotal) throw new DomainException($"The discount can't be more than the bill ({subtotal:N2}).");
            await CheckAsync(c, tx, http, scope, id, listed, pct > 0 ? pct : subtotal == 0 ? 0 : amount * 100 / subtotal, o.PlatformId is not null);
            await c.ExecuteAsync("""
                update pos_order set discount_pct = @pct, discount_amount = @amount, discount_source = @source, discount_id = @did, discount_name = @name,
                  discount_note = @note, discount_by = @UserId where id = @id
                """, new { id, pct, amount = Money.Round(amount), source = listed is null ? "typed" : "cashier", did = listed?.Id, name = listed?.Name, note, scope.UserId }, tx);
            await Audit.RecordAsync(c, tx, o.CompanyId, o.BranchId, scope.UserId, "order", id.ToString(), "discount",
                $"Order #{o.Number}: {(listed?.Name ?? "discount")} {(pct > 0 ? $"{pct:0.##} %" : $"{amount:N2}")} on the bill", note: note);
        }));

        // One item: a listed item discount, a typed % or AED off each, or none (also takes a promotion off).
        api.MapPost("/orders/{id:guid}/lines/{lineId:guid}/discount", (Guid id, Guid lineId, ApplyBody body, HttpContext http, Db db, Live live) => Orders.Mutate(http, db, live, id, "pos.sell", async (c, tx, o, scope) =>
        {
            var line = await c.QuerySingleOrDefaultAsync<Orders.LineRow>("select * from order_line where id = @lineId and order_id = @id and not is_void for update", new { id, lineId }, tx)
                       ?? throw new NotFoundException("That line is no longer on the order.");
            if (body.Clear == true || (body.DiscountId is null && (body.Pct ?? 0) == 0 && (body.Amount ?? 0) == 0))
            {
                await c.ExecuteAsync("""
                    update order_line set disc_source = null, disc_id = null, disc_name = null, disc_type = null, disc_value = null, disc_note = null, disc_by = null where id = @lineId
                    """, new { lineId }, tx);
                await Audit.RecordAsync(c, tx, o.CompanyId, o.BranchId, scope.UserId, "order", id.ToString(), "discount", $"Order #{o.Number}: discount on {line.Name} taken off");
                return;
            }
            var listed = body.DiscountId is { } did ? await ListedAsync(c, tx, did, "item", o.BranchId) : null;
            var (type, value) = listed is not null ? (listed.Type, listed.Value) : (body.Pct ?? 0) > 0 ? ("pct", body.Pct!.Value) : ("amount", body.Amount ?? 0);
            if (type == "pct" && value > 100) throw new DomainException("A discount is between 0 and 100 %.");
            if (value <= 0) throw new DomainException("Enter the discount.");
            var note = Opt(body.Note);
            if (listed is { NeedsNote: true } && note is null) throw new DomainException($"\"{listed.Name}\" needs a name or reason.");
            var gross = Money.Round(line.UnitPrice * line.Qty);
            var off = Totals.Own(gross, line.Qty, type, value);
            if (type == "amount" && value > line.UnitPrice) throw new DomainException($"The discount can't be more than {line.Name}'s price ({line.UnitPrice:N2}).");
            await CheckAsync(c, tx, http, scope, id, listed, gross == 0 ? 0 : off * 100 / gross, o.PlatformId is not null);
            await c.ExecuteAsync("""
                update order_line set disc_source = @source, disc_id = @did, disc_name = @name, disc_type = @type, disc_value = @value, disc_note = @note, disc_by = @UserId where id = @lineId
                """, new { lineId, source = listed is null ? "typed" : "cashier", did = listed?.Id, name = listed?.Name, type, value = Money.Round(value), note, scope.UserId }, tx);
            await Audit.RecordAsync(c, tx, o.CompanyId, o.BranchId, scope.UserId, "order", id.ToString(), "discount",
                $"Order #{o.Number}: {(listed?.Name ?? "discount")} {(type == "pct" ? $"{value:0.##} %" : $"{value:N2} each")} on {line.Name}", note: note);
        }));

        // A delivery platform's offer: "we pay" becomes the bill discount (no limit: the amount is the platform's); "platform pays" is noted.
        api.MapPost("/orders/{id:guid}/platform-offer", (Guid id, PlatformOfferBody body, HttpContext http, Db db, Live live) => Orders.Mutate(http, db, live, id, "pos.sell", async (c, tx, o, scope) =>
        {
            if (o.PlatformId is null) throw new DomainException("A platform offer is only for a delivery platform's order.");
            if (o.Paid > 0) throw new DomainException("Money was taken on this order: its offer can't change now.");
            if (body.Amount < 0) throw new DomainException("The offer can't be negative.");
            var amount = Money.Round(body.Amount);
            var name = $"{o.PlatformName ?? await c.ExecuteScalarAsync<string>("select name from delivery_platform where id = @PlatformId", new { o.PlatformId }, tx)} offer";
            if (body.PaidBy == "us")
            {
                var subtotal = await c.ExecuteScalarAsync<decimal>("select coalesce(sum(round(unit_price * qty, 2)), 0) from order_line where order_id = @id and not is_void", new { id }, tx);
                if (amount > subtotal) throw new DomainException($"The offer can't be more than the bill ({subtotal:N2}).");
                await c.ExecuteAsync("""
                    update pos_order set discount_pct = 0, discount_amount = @amount, discount_source = case when @amount > 0 then 'platform' end, discount_id = null,
                      discount_name = case when @amount > 0 then @name end, discount_note = @note, discount_by = @UserId where id = @id
                    """, new { id, amount, name, note = Opt(body.Note), scope.UserId }, tx);
            }
            else if (body.PaidBy == "platform")
                await c.ExecuteAsync("update pos_order set platform_funded = @amount where id = @id", new { id, amount }, tx);
            else throw new DomainException("Who pays for the offer: us or the platform?");
            await Audit.RecordAsync(c, tx, o.CompanyId, o.BranchId, scope.UserId, "order", id.ToString(), "platform_offer",
                $"Order #{o.Number}: {name} {amount:N2}, paid by {(body.PaidBy == "us" ? "us (bill discount)" : "the platform (noted)")}", note: Opt(body.Note));
        }));
    }

    private sealed record Clean_(string Kind, string Name, string Type, decimal Value, string AppliesTo, Guid[] CategoryIds, Guid[] ItemIds, string Target, Guid[] RoleIds,
        bool NeedsNote, DateOnly ValidFrom, DateOnly? ValidTo, short[] Days, TimeOnly? TimeFrom, TimeOnly? TimeTo, Guid[] BranchIds, string Channel, Guid? PlatformId, bool IsActive);

    private static Clean_ Clean(DiscountBody b)
    {
        var kind = b.Kind is "promotion" or "cashier" ? b.Kind : throw new DomainException("A discount is a promotion or a cashier discount.");
        var name = string.IsNullOrWhiteSpace(b.Name) ? throw new DomainException("Give it a name (shown on the bill).") : b.Name.Trim();
        var type = b.Type is "pct" or "amount" or "price" ? b.Type : throw new DomainException("Choose % off, AED off or a fixed price.");
        if (kind == "cashier" && type == "price") throw new DomainException("A cashier discount is % off or AED off.");
        if (b.Value <= 0 && type != "price") throw new DomainException("Enter the discount.");
        if (type == "pct" && b.Value > 100) throw new DomainException("A discount is between 0 and 100 %.");
        var applies = kind == "promotion" ? b.AppliesTo is "all" or "categories" or "items" ? b.AppliesTo : "all" : "all";
        var cats = applies == "categories" ? (b.CategoryIds ?? []).Distinct().ToArray() : [];
        var items = applies == "items" ? (b.ItemIds ?? []).Distinct().ToArray() : [];
        if (applies == "categories" && cats.Length == 0) throw new DomainException("Choose at least one category.");
        if (applies == "items" && items.Length == 0) throw new DomainException("Choose at least one item.");
        var target = kind == "cashier" ? b.Target is "bill" or "item" ? b.Target : "bill" : "item";
        if (kind == "promotion" && type == "price" && b.Value < 0) throw new DomainException("Enter the price.");
        var from = b.ValidFrom ?? DateOnly.FromDateTime(DateTime.UtcNow);
        if (b.ValidTo is { } to && to < from) throw new DomainException("The end date is before the start date.");
        var days = (b.Days ?? []).Where(d => d is >= 1 and <= 7).Distinct().Select(d => (short)d).OrderBy(d => d).ToArray();
        if (days.Length == 7) days = [];
        var channel = b.Channel is "all" or "instore" or "platforms" or "platform" ? b.Channel : "all";
        if (channel == "platform" && b.PlatformId is null) throw new DomainException("Choose the delivery platform.");
        return new Clean_(kind, name, type, Money.Round(b.Value), applies, cats, items, target, kind == "cashier" ? (b.RoleIds ?? []).Distinct().ToArray() : [],
            kind == "cashier" && b.NeedsNote == true, from, b.ValidTo, days, kind == "promotion" ? b.TimeFrom : null, kind == "promotion" ? b.TimeTo : null,
            kind == "promotion" ? (b.BranchIds ?? []).Distinct().ToArray() : [], kind == "promotion" ? channel : "all", channel == "platform" ? b.PlatformId : null, b.IsActive ?? true);
    }
}
