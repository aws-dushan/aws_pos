using System.Text.Json;
using Dapper;
using Npgsql;
using OnePos.Api.Data;
using OnePos.Api.Platform;

namespace OnePos.Api.Pos;

/// <summary>
/// Orders at the register (REQ REG-01 … REG-09, PAY-01, PAY-04 … PAY-06, ORD-01 … ORD-03). The server owns the totals: every change
/// recalculates them (Totals). Every answer is the whole order, so the till simply shows what comes back. Writes are idempotent
/// through the Idempotency-Key header (a retried "add Hummus" adds one Hummus).
/// </summary>
public static class Orders
{
    public sealed record OpenBody(string Type, string? TableLabel, int? Guests, string? CustomerName, string? CustomerPhone, string? DeliveryAddress, Guid? TableId);
    public sealed record ChangeBody(string? Type, string? TableLabel, int? Guests, string? CustomerName, string? CustomerPhone, string? DeliveryAddress,
        string? Note, decimal? DiscountPct, Guid? PlatformId = null, string? PlatformRef = null);
    public sealed record LineBody(Guid ItemId, decimal? Qty, Guid[]? OptionIds, string? Note);
    public sealed record LineChangeBody(decimal? Qty, string? Note);
    /// <summary>CardType: the FACTS card payment method the cashier picked (e.g. "ERBQS VISA CARD"), where the branch has them.</summary>
    public sealed record PayLine(string Method, decimal Amount, decimal? Tendered, string? Reference, string? CardType = null);
    public sealed record PayBody(PayLine[] Payments);
    public sealed record ReasonBody(string Reason);
    public sealed record RefundBody(decimal Amount, string Method, string Reason);

    public sealed class OrderRow
    {
        public Guid Id { get; set; }
        public Guid CompanyId { get; set; }
        public Guid BranchId { get; set; }
        public Guid? RegisterId { get; set; }
        public DateOnly BusinessDate { get; set; }
        public int? Number { get; set; }   // null until the first item is added
        public string OrderType { get; set; } = "";
        public string? TableLabel { get; set; }
        public int? Guests { get; set; }
        public string? CustomerName { get; set; }
        public string? CustomerPhone { get; set; }
        public string? DeliveryAddress { get; set; }
        public string? Note { get; set; }
        public string Status { get; set; } = "";
        public decimal DiscountPct { get; set; }
        public decimal DiscountAmount { get; set; }
        public string? DiscountSource { get; set; }
        public string? DiscountName { get; set; }
        public string? DiscountNote { get; set; }
        public decimal PlatformFunded { get; set; }
        public decimal Subtotal { get; set; }
        public decimal DiscountTotal { get; set; }
        public decimal ServiceCharge { get; set; }
        public decimal Vat { get; set; }
        public decimal Total { get; set; }
        public decimal Paid { get; set; }
        public decimal Refunded { get; set; }
        public decimal VatRate { get; set; }
        public bool PricesIncludeVat { get; set; }
        public decimal ServicePct { get; set; }
        public Guid OpenedBy { get; set; }
        public DateTime OpenedAt { get; set; }
        /// <summary>till, or paper (keyed in from a slip after an outage, REQ ONL-04) with its slip number.</summary>
        public string Source { get; set; } = "till";
        public Guid? CustomerId { get; set; }
        public string? PaperRef { get; set; }
        /// <summary>A delivery platform's order (Talabat, Deliveroo…): the platform, its order number, its commission rate then.</summary>
        public Guid? PlatformId { get; set; }
        public string? PlatformRef { get; set; }
        public decimal? PlatformCommission { get; set; }
        public string? PlatformName { get; set; }
        public DateTime? ClosedAt { get; set; }
        public string? VoidReason { get; set; }
        public int Version { get; set; }
        public string? RegisterName { get; set; }
        public string? OpenedByName { get; set; }
        public string? InvoiceNo { get; set; }
        public string? LockSession { get; set; }
        public Guid? LockUser { get; set; }
        public string? LockLabel { get; set; }
        public DateTime? LockAt { get; set; }
        public DateTime? BillPrintedAt { get; set; }
        /// <summary>Takeaway / delivery pickup (REQ KIT-06): ready, then collected.</summary>
        public DateTime? ReadyAt { get; set; }
        public DateTime? CollectedAt { get; set; }
        public Guid? SplitFrom { get; set; }
        /// <summary>The tables the order sits on (joined tables: several), primary first.</summary>
        public Guid[] TableIds { get; set; } = [];
        public string? TableNames { get; set; }
        /// <summary>Another device has it open (REQ TBL-08): "Till 2 · Omar".</summary>
        public string? LockedBy { get; set; }
        public int Items { get; set; }
        public decimal Due => Math.Max(0, Total - Paid);
    }

    public sealed class LineRow
    {
        public Guid Id { get; set; }
        public Guid? ItemId { get; set; }
        public string Name { get; set; } = "";
        public string? NameAr { get; set; }
        public decimal UnitPrice { get; set; }
        public decimal Qty { get; set; }
        public string Modifiers { get; set; } = "[]";
        public string? Note { get; set; }
        public string Station { get; set; } = "";
        public decimal SentQty { get; set; }
        public decimal LineTotal { get; set; }
        public decimal Vat { get; set; }
        public bool IsVoid { get; set; }
        public string? VoidReason { get; set; }
        public int Sort { get; set; }
        public decimal ReturnedQty { get; set; }
        public string? DiscSource { get; set; }
        public Guid? DiscId { get; set; }
        public string? DiscName { get; set; }
        public string? DiscType { get; set; }
        public decimal? DiscValue { get; set; }
        public string? DiscNote { get; set; }
        public decimal Discount { get; set; }
    }

    public sealed class PaymentRow
    {
        public Guid Id { get; set; }
        public string Kind { get; set; } = "";
        public string Method { get; set; } = "";
        public decimal Amount { get; set; }
        public decimal? Tendered { get; set; }
        public decimal ChangeGiven { get; set; }
        public string? Reference { get; set; }
        public string? Reason { get; set; }
        public DateTime At { get; set; }
        public string? TakenByName { get; set; }
        public Guid? CreditNoteId { get; set; }
        /// <summary>The FACTS card type of a card payment (e.g. "ERBQS VISA CARD").</summary>
        public string? CardType { get; set; }
    }

    /// <summary>
    /// The branch's rule "when stock runs short" on block: this order can't hold more of an item than its FACTS stock has left (the
    /// last read, every 5 minutes, less what the branch sold since). Items without FACTS stock (not linked) aren't limited.
    /// </summary>
    private static async Task EnforceStockAsync(NpgsqlConnection c, NpgsqlTransaction tx, OrderRow o, Guid itemId)
    {
        var s = await c.QuerySingleOrDefaultAsync<(string Rule, string Name, decimal? Left, DateTime? At, decimal InOrder)>("""
            select b.short_stock, i.name,
                   bi.erp_stock - coalesce((select sum(l.qty) from order_line l join pos_order po on po.id = l.order_id
                                            where l.item_id = i.id and po.branch_id = b.id and not l.is_void
                                              and po.status in ('paid','refunded') and po.closed_at > bi.erp_stock_at), 0)
                              - coalesce((select sum(w.qty) from wastage w where w.item_id = i.id and w.branch_id = b.id and w.voided_at is null
                                            and w.erp_status <> 'none' and (w.erp_status <> 'posted' or w.erp_matched_at > bi.erp_stock_at)), 0)
                              - coalesce((select sum(r.qty) from stock_return r where r.item_code = i.erp_item_code and r.branch_id = b.id and r.approval in ('waiting','approved')
                                            and (r.erp_status <> 'posted' or r.erp_posted_at > bi.erp_stock_at)), 0),
                   bi.erp_stock_at,
                   (select coalesce(sum(qty), 0) from order_line where order_id = @Id and item_id = i.id and not is_void)
            from branch b join menu_item i on i.id = @itemId left join branch_item bi on bi.branch_id = b.id and bi.item_id = i.id
            where b.id = @BranchId
            """, new { o.Id, o.BranchId, itemId }, tx);
        if (s.Rule != "block" || s.Left is not { } left) return;
        // Made to order (its FACTS item has a BOM valid today): sold without stock of its own; its raw materials come off at day close.
        if (await Boms.MadeToOrderAsync(c, tx, itemId, o.BusinessDate)) return;
        if (s.InOrder > left)
            throw new DomainException(left <= 0
                ? $"{s.Name} has no stock left at this branch."
                : $"Only {left:0.###} × {s.Name} left in stock at this branch.");
    }

    /// <summary>Opens an order (numbered per business day), seats its table for dine-in, and takes it on this device. Also used to seat a reservation.</summary>
    public static async Task<Guid> OpenAsync(NpgsqlConnection c, NpgsqlTransaction tx, HttpContext http, Scope scope, OpenBody body)
    {
        var branchId = scope.Branch;
        var type = CleanType(body.Type);
        var br = await c.QuerySingleAsync<(bool TableService, decimal ServiceChargePct, string TimeZone)>(
            "select table_service, service_charge_pct, time_zone from branch where id = @branchId", new { branchId }, tx);
        if (type == "dine_in" && !br.TableService) throw new DomainException("This branch has no table service: start a takeaway or delivery order.");
        var co = await c.QuerySingleAsync<(decimal VatRate, bool PricesIncludeVat)>("select vat_rate, prices_include_vat from company where id = @id", new { id = scope.CompanyId }, tx);
        var date = (await Days.CurrentAsync(c, tx, branchId, scope.UserId)).Date;
        var id = await c.ExecuteScalarAsync<Guid>("""
            insert into pos_order (company_id, branch_id, register_id, business_date, number, order_type, table_label, guests, customer_name, customer_phone,
                                   delivery_address, vat_rate, prices_include_vat, service_pct, opened_by)
            values (@co, @branchId, @registerId, @date, null, @type, @table, @guests, @name, @phone, @address, @vatRate, @incl, @svc, @userId) returning id
            """, new
            {
                co = scope.CompanyId, branchId, registerId = scope.RegisterId, date, type, table = Opt(body.TableLabel), guests = body.Guests is > 0 ? body.Guests : null,
                name = Opt(body.CustomerName), phone = Opt(body.CustomerPhone), address = Opt(body.DeliveryAddress),
                vatRate = co.VatRate, incl = co.PricesIncludeVat, svc = br.ServiceChargePct, userId = scope.UserId,
            }, tx);
        if (type == "dine_in" && body.TableId is { } tableId) await OrderTables.SeatAsync(c, tx, scope.CompanyId, branchId, id, [tableId]);
        await OrderTables.LockAsync(c, tx, http, scope, id);
        return id;
    }

    /// <summary>
    /// Gives the order its number when its first item is added: 1, 2, 3 … per business day and branch, allocated inside this
    /// transaction (no doubles). An order started and left empty never takes one.
    /// </summary>
    public static async Task NumberAsync(NpgsqlConnection c, NpgsqlTransaction tx, OrderRow o)
    {
        if (o.Number is not null) return;
        var number = await c.ExecuteScalarAsync<int>("""
            insert into number_series (company_id, branch_id, series, next_no) values (@co, @b, @series, 2)
            on conflict (branch_id, series) do update set next_no = number_series.next_no + 1
            returning next_no - 1
            """, new { co = o.CompanyId, b = o.BranchId, series = $"order:{o.BusinessDate:yyyy-MM-dd}" }, tx);
        await c.ExecuteAsync("update pos_order set number = @number where id = @id and number is null", new { number, o.Id }, tx);
        o.Number = number;
    }

    private static readonly string[] Types = ["dine_in", "takeaway", "delivery"];
    private static readonly string[] Methods = ["cash", "card", "other", "voucher", "account", "points", "platform"];

    public static void Map(RouteGroupBuilder api)
    {
        api.MapPost("/orders", async (OpenBody body, HttpContext http, Db db, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("pos.sell");
            var branchId = scope.Branch;
            var order = await db.Company(scope.CompanyId, async (c, tx) =>
            {
                // Whoever runs a drawer (shifts) starts orders only in their open shift: none before it's opened or after it's closed.
                // A waiter (no shift) still takes table orders; a cashier's shift takes the money.
                if (scope.Can("day.shift"))
                {
                    if (scope.RegisterId is null) throw new DomainException("Pick the register you're at first (on the Dashboard), then open your shift.");
                    if (await Days.ShiftOfAsync(c, tx, scope.RegisterId, scope.UserId) is null) throw new DomainException("Open your shift first: count the float in the drawer (on the Dashboard).");
                }
                return await DetailAsync(c, tx, await OpenAsync(c, tx, http, scope, body));
            });
            await live.ToBranch(branchId, "order.changed", new { id = order.Order.Id });
            if (body.TableId is not null) await live.ToBranch(branchId, "floor.changed");
            return Results.Ok(order);
        });

        // An order nothing was ever added to (no lines, no payments) is removed when the till leaves it, so it doesn't sit in Open orders.
        api.MapDelete("/orders/{id:guid}", async (Guid id, HttpContext http, Db db, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("pos.sell");
            var removed = await db.Company(scope.CompanyId, async (c, tx) =>
            {
                await BranchCheckAsync(c, tx, id, scope.Branch);
                // A seated booking whose guests left before ordering goes back to "booked".
                return await c.ExecuteScalarAsync<int>("""
                    with gone as (
                      delete from pos_order o where o.id = @id and o.status = 'open'
                        and not exists (select 1 from order_line l where l.order_id = o.id) and not exists (select 1 from payment p where p.order_id = o.id)
                      returning o.id
                    ), fix as (update reservation set status = 'booked', order_id = null where order_id in (select id from gone))
                    select count(*)::int from gone
                    """, new { id }, tx);
            });
            if (removed > 0) await live.ToBranch(scope.Branch, "order.changed", new { id });
            return Results.Ok(new { removed = removed > 0 });
        });

        // The branch's orders of a business day (default today), newest first (REQ ORD-01).
        api.MapGet("/orders", async (HttpContext http, Db db, string? status, DateOnly? date, string? q) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("pos.sell");
            var branchId = scope.Branch;
            return await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var day = date ?? await Days.DateAsync(c, tx, branchId);
                var term = string.IsNullOrWhiteSpace(q) ? null : $"%{q.Trim()}%";
                var rows = (await c.QueryAsync<OrderRow>($"""
                    {ListSql}
                    where o.branch_id = @branchId and (o.business_date = @day or (@status = 'open' and o.status = 'open'))
                      and (@status is null or @status = 'all' or o.status = @status)
                      and (@term is null or o.number::text like @term or o.customer_name ilike @term or o.table_label ilike @term or o.customer_phone ilike @term)
                    order by o.opened_at desc limit 500
                    """, new { branchId, day, status, term }, tx)).ToList();
                return new { date = day, orders = rows };
            });
        });

        api.MapGet("/orders/{id:guid}", async (Guid id, HttpContext http, Db db) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("pos.sell");
            return await db.Company(scope.CompanyId, async (c, tx) =>
            {
                await BranchCheckAsync(c, tx, id, scope.Branch);
                return await DetailAsync(c, tx, id);
            });
        });

        // Everything a printed receipt (tax invoice) needs: the order, the company's legal name and TRN, the branch's receipt text.
        api.MapGet("/orders/{id:guid}/receipt", async (Guid id, HttpContext http, Db db) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("pos.sell");
            return await db.Company(scope.CompanyId, async (c, tx) =>
            {
                await BranchCheckAsync(c, tx, id, scope.Branch);
                return await ReceiptAsync(c, tx, id, scope.CompanyId, publicView: false);
            });
        });

        api.MapPut("/orders/{id:guid}", (Guid id, ChangeBody body, HttpContext http, Db db, Live live) => Mutate(http, db, live, id, "pos.sell", async (c, tx, o, scope) =>
        {
            var type = body.Type is null ? o.OrderType : CleanType(body.Type);
            if (type == "dine_in" && o.OrderType != "dine_in" &&
                !await c.ExecuteScalarAsync<bool>("select table_service from branch where id = @b", new { b = o.BranchId }, tx))
                throw new DomainException("This branch has no table service.");
            var pct = body.DiscountPct ?? o.DiscountPct;
            if (pct is < 0 or > 100) throw new DomainException("A discount is between 0 and 100 %.");
            if (pct != o.DiscountPct && pct > 0) scope.Require("pos.discount");
            // A delivery platform's order (Guid.Empty takes it off): only a delivery, and not once money was taken.
            Guid? platformId = o.PlatformId;
            decimal? commission = o.PlatformCommission;
            decimal? bankFee = await c.ExecuteScalarAsync<decimal?>("select platform_bank_fee from pos_order where id = @id", new { id }, tx);
            if (body.PlatformId is { } pid && pid != (o.PlatformId ?? Guid.Empty))
            {
                if (o.Paid > 0) throw new DomainException("Money was taken on this order: its platform can't change now.");
                if (pid == Guid.Empty) { platformId = null; commission = null; bankFee = null; }
                else
                {
                    var plat = await c.QuerySingleOrDefaultAsync<(Guid Id, decimal Pct, bool Active, decimal Fee)>("select id, commission_pct, is_active, bank_fee_pct from delivery_platform where id = @pid", new { pid }, tx);
                    if (plat.Id == Guid.Empty || !plat.Active) throw new DomainException("That delivery platform isn't in use.");
                    platformId = plat.Id; commission = plat.Pct; bankFee = plat.Fee;
                }
            }
            if (type != "delivery") { platformId = null; commission = null; bankFee = null; }
            // The role's discount limit: not on a delivery platform's order (its discounts are the platform's); own delivery keeps it.
            if (pct != o.DiscountPct && pct > 0 && platformId is null && scope.Limit("maxDiscountPct") is { } max && pct > max)
                await Approvals.RequireAsync(c, tx, http, scope, "discount", pct, $"Your role allows discounts up to {max:0.##} %. A manager can approve {pct:0.##} %.", orderId: id);
            var platformRef = platformId is null ? null : body.PlatformRef is null ? o.PlatformRef : Opt(body.PlatformRef)?.ToUpperInvariant();
            // Another platform (or none): the open lines take its prices (the platform's FACTS prices, or the outlet's).
            if (platformId != o.PlatformId) await PlatformPrices.RepriceAsync(c, tx, id, o.BranchId, platformId);
            await c.ExecuteAsync("""
                update pos_order set platform_id = @platformId, platform_ref = @platformRef, platform_commission = @commission, platform_bank_fee = @bankFee where id = @id
                """, new { id, platformId, platformRef, commission, bankFee }, tx);
            await c.ExecuteAsync("""
                update pos_order set order_type = @type, table_label = @table, guests = @guests, customer_name = @name, customer_phone = @phone,
                  delivery_address = @address, note = @note, discount_pct = @pct,
                  customer_id = case when @phone is distinct from customer_phone then null else customer_id end where id = @id
                """, new
                {
                    id, type, pct,
                    table = body.TableLabel is null ? o.TableLabel : Opt(body.TableLabel),
                    guests = body.Guests is null ? o.Guests : body.Guests > 0 ? body.Guests : null,
                    name = body.CustomerName is null ? o.CustomerName : Opt(body.CustomerName),
                    phone = body.CustomerPhone is null ? o.CustomerPhone : Opt(body.CustomerPhone),
                    address = body.DeliveryAddress is null ? o.DeliveryAddress : Opt(body.DeliveryAddress),
                    note = body.Note is null ? o.Note : Opt(body.Note),
                }, tx);
            // A % typed here is the bill discount (any AED or listed one gives way to it).
            if (pct != o.DiscountPct)
                await c.ExecuteAsync("""
                    update pos_order set discount_amount = 0, discount_source = case when @pct > 0 then 'typed' end, discount_id = null, discount_name = null,
                      discount_note = null, discount_by = case when @pct > 0 then @UserId end where id = @id
                    """, new { id, pct, scope.UserId }, tx);
            if (pct != o.DiscountPct)
                await Audit.RecordAsync(c, tx, o.CompanyId, o.BranchId, scope.UserId, "order", id.ToString(), "discount", $"Order #{o.Number} discount", [new("Discount %", o.DiscountPct, pct)]);
        }));

        api.MapPost("/orders/{id:guid}/lines", (Guid id, LineBody body, HttpContext http, Db db, Live live) => Mutate(http, db, live, id, "pos.sell", async (c, tx, o, scope) =>
        {
            var qty = body.Qty ?? 1;
            var item = await c.QuerySingleOrDefaultAsync<(Guid Id, string Name, decimal Price, string Station, bool Active, bool IsSold, decimal? BranchPrice, DateOnly? SoldOutDate, bool NeedsPrice, int Decimals, string? NameAr, bool ErpPriced, bool IsCombo)>("""
                select i.id, i.name, i.price, i.station, i.is_active and cat.is_active as active, coalesce(bi.is_sold, i.erp_item_code is null) as is_sold, bi.price as branch_price, bi.sold_out_date,
                       i.needs_price, i.qty_decimals, i.name_ar, coalesce(bi.erp_priced, false), i.is_combo
                from menu_item i join menu_category cat on cat.id = i.category_id
                left join branch_item bi on bi.item_id = i.id and bi.branch_id = @b
                where i.id = @itemId
                """, new { body.ItemId, b = o.BranchId }, tx);
            if (item.Id == Guid.Empty || !item.Active || !item.IsSold) throw new DomainException("This item isn't on the menu here.");
            if (item.SoldOutDate == o.BusinessDate) throw new DomainException($"{item.Name} is sold out today.");
            if (item.ErpPriced && item.BranchPrice is null) throw new DomainException($"{item.Name} has no price in FACTS for this outlet yet.");
            if (item.NeedsPrice && item.BranchPrice is null) throw new DomainException($"{item.Name} has no price yet. A manager sets it under Menu.");
            CheckQty(qty, item.Decimals, item.Name);
            // A FACTS-linked delivery platform's bill: the item sells at the platform's FACTS price, or not at all there.
            var plat = await PlatformPrices.ForAsync(c, tx, o.BranchId, o.PlatformId, item.Id);
            if (plat.Applies && plat.Price is null) throw new DomainException($"{item.Name} has no {plat.Platform} price in FACTS.");
            // Modifiers: options must belong to the item's groups, within each group's least and most choices.
            var groups = (await c.QueryAsync<(Guid Id, string Name, int Min, int Max)>("""
                select g.id, g.name, g.min_select, g.max_select from menu_item_modifier m join modifier_group g on g.id = m.group_id where m.item_id = @itemId order by m.sort
                """, new { body.ItemId }, tx)).ToList();
            var optionIds = (body.OptionIds ?? []).Distinct().ToArray();
            var opts = (await c.QueryAsync<(Guid Id, Guid GroupId, string Name, decimal Price, Guid? ItemId, string? Station, bool FactsPrice)>("""
                select o.id, o.group_id, o.name, o.price, o.item_id, i.station, o.facts_price from modifier_option o left join menu_item i on i.id = o.item_id
                where o.id = any(@optionIds) and o.is_active
                """, new { optionIds }, tx)).ToList();
            // A FACTS-priced option costs what its item costs here now (on a platform's bill, the platform's FACTS price).
            for (var k = 0; k < opts.Count; k++)
            {
                if (!opts[k].FactsPrice || opts[k].ItemId is not { } optionItem) continue;
                var (p, where) = await PlatformPrices.OptionPriceAsync(c, tx, o.BranchId, o.PlatformId, optionItem);
                if (p is null) throw new DomainException($"{opts[k].Name} has no FACTS price for {where}.");
                opts[k] = opts[k] with { Price = p.Value };
            }
            if (opts.Count != optionIds.Length || opts.Any(x => groups.All(g => g.Id != x.GroupId))) throw new DomainException("A chosen option isn't available for this item.");
            foreach (var g in groups)
            {
                var n = opts.Count(x => x.GroupId == g.Id);
                if (n < g.Min) throw new DomainException(g.Min == 1 ? $"Choose a {g.Name.ToLowerInvariant()}." : $"Choose at least {g.Min} for {g.Name}.");
                if (n > g.Max) throw new DomainException($"Choose at most {g.Max} for {g.Name}.");
            }
            // A combo choice keeps its menu item and station (the kitchen makes the component, not "the combo").
            var mods = groups.SelectMany(g => opts.Where(x => x.GroupId == g.Id).Select(x => new { groupId = g.Id, optionId = x.Id, group = g.Name, name = x.Name, price = x.Price, itemId = x.ItemId, station = x.Station })).ToList();
            // A combo costs what its chosen items cost in it (the prices on its choices, which FACTS gets item by item).
            var unit = Money.Round((item.IsCombo ? 0 : plat.Applies ? plat.Price!.Value : item.BranchPrice ?? item.Price) + mods.Sum(m => m.price));
            var note = Opt(body.Note);
            // A promotion running now for this item (and this kind of order): it goes on the line and stays while the bill is open.
            var promo = await Discounts.BestPromotionAsync(c, tx, o, body.ItemId, unit);
            // The same item with the same choices, the same promotion and no note, not yet sent: add to that line.
            var modsJson = JsonSerializer.Serialize(mods);
            var same = await c.ExecuteScalarAsync<Guid?>("""
                select id from order_line where order_id = @id and item_id = @itemId and not is_void and sent_qty = 0 and note is null and modifiers = cast(@modsJson as jsonb) and @note is null
                  and disc_id is not distinct from @promoId and coalesce(disc_source, 'promotion') = 'promotion'
                limit 1
                """, new { id, body.ItemId, modsJson, note, promoId = promo?.Id }, tx);
            if (same is { } lineId)
                await c.ExecuteAsync("update order_line set qty = qty + @qty where id = @lineId", new { lineId, qty }, tx);
            else
                await c.ExecuteAsync("""
                    insert into order_line (company_id, order_id, item_id, name, name_ar, unit_price, qty, modifiers, note, station, sort, added_by,
                                            disc_source, disc_id, disc_name, disc_type, disc_value)
                    values (@co, @id, @itemId, @name, @nameAr, @unit, @qty, cast(@modsJson as jsonb), @note, @station,
                            (select coalesce(max(sort), 0) + 1 from order_line where order_id = @id), @userId,
                            case when @promoId is not null then 'promotion' end, @promoId, @promoName, @promoType, @promoValue)
                    """, new { co = o.CompanyId, id, body.ItemId, name = item.Name, nameAr = item.NameAr, unit, qty, modsJson, note, station = item.Station, userId = scope.UserId,
                               promoId = promo?.Id, promoName = promo?.Name, promoType = promo?.Type, promoValue = promo?.Value }, tx);
            await Recipes.EnforceAsync(c, tx, o, [(body.ItemId, modsJson)]);
            await EnforceStockAsync(c, tx, o, body.ItemId);
            await NumberAsync(c, tx, o);
        }));

        api.MapPut("/orders/{id:guid}/lines/{lineId:guid}", (Guid id, Guid lineId, LineChangeBody body, HttpContext http, Db db, Live live) => Mutate(http, db, live, id, "pos.sell", async (c, tx, o, scope) =>
        {
            var line = await LineAsync(c, tx, id, lineId);
            if (body.Qty is { } qty)
            {
                CheckQty(qty, await c.ExecuteScalarAsync<int>("select coalesce((select qty_decimals from menu_item where id = @itemId), 0)", new { line.ItemId }, tx), line.Name);
                if (qty < line.SentQty) throw new DomainException($"{line.SentQty} already went to the kitchen. Void the line to take them off.");
                await c.ExecuteAsync("update order_line set qty = @qty where id = @lineId", new { lineId, qty }, tx);
                if (qty > line.Qty)
                {
                    await Recipes.EnforceAsync(c, tx, o, [(line.ItemId, line.Modifiers)]);
                    if (line.ItemId is { } itemId) await EnforceStockAsync(c, tx, o, itemId);
                }
            }
            if (body.Note is not null)
            {
                if (line.SentQty > 0) throw new DomainException("This line already went to the kitchen; add the item again with the note.");
                await c.ExecuteAsync("update order_line set note = @note where id = @lineId", new { lineId, note = Opt(body.Note) }, tx);
            }
        }));

        // Removes a line not yet sent; a sent line is voided instead (needs pos.void and a reason).
        api.MapDelete("/orders/{id:guid}/lines/{lineId:guid}", (Guid id, Guid lineId, string? reason, HttpContext http, Db db, Live live) => Mutate(http, db, live, id, "pos.sell", async (c, tx, o, scope) =>
        {
            var line = await LineAsync(c, tx, id, lineId);
            if (line.SentQty == 0)
            {
                await c.ExecuteAsync("delete from order_line where id = @lineId", new { lineId }, tx);
                return;
            }
            scope.Require("pos.void");
            if (string.IsNullOrWhiteSpace(reason)) throw new DomainException("Give a reason to void an item that went to the kitchen.");
            await c.ExecuteAsync("update order_line set is_void = true, void_reason = @reason where id = @lineId", new { lineId, reason = reason.Trim() }, tx);
            await Kitchen.CancelAsync(c, tx, o, line, line.SentQty, scope.UserId);
            await Audit.RecordAsync(c, tx, o.CompanyId, o.BranchId, scope.UserId, "order", id.ToString(), "line_void", $"Order #{o.Number}: {line.Qty} × {line.Name} voided", note: reason.Trim());
        }));

        // Marks everything new as sent (the kitchen tickets themselves arrive in phase 2).
        api.MapPost("/orders/{id:guid}/send", (Guid id, HttpContext http, Db db, Live live) => Mutate(http, db, live, id, "pos.sell", async (c, tx, o, scope) =>
        {
            if (!await Kitchen.EnabledAsync(c, tx, o.BranchId)) throw new DomainException("This branch has no kitchen: orders are made at the counter.");
            if (await Kitchen.SendAsync(c, tx, o, scope.UserId) == 0) throw new DomainException("Nothing new to send.");
        }));

        api.MapPost("/orders/{id:guid}/pay", (Guid id, PayBody body, HttpContext http, Db db, Live live) => Mutate(http, db, live, id, "pos.sell", async (c, tx, o, scope) =>
        {
            var items = await c.ExecuteScalarAsync<int>("select count(*) from order_line where order_id = @id and not is_void", new { id }, tx);
            if (items == 0) throw new DomainException("Add something to the order first.");
            var due = Math.Max(0, o.Total - o.Paid);
            var list = body.Payments ?? [];
            if (list.Length == 0 && due > 0) throw new DomainException("Enter a payment.");
            // A delivery needs somewhere to go and someone to call; every other order can stay anonymous.
            // A platform's order: the platform delivers (no phone or address needed here), but its order number is.
            o.PlatformName ??= o.PlatformId is null ? null : await c.ExecuteScalarAsync<string>("select name from delivery_platform where id = @PlatformId", new { o.PlatformId }, tx);
            if (o.PlatformId is not null && string.IsNullOrWhiteSpace(o.PlatformRef))
                throw new DomainException($"Enter the {o.PlatformName} order number before it's paid.");
            if (o.OrderType == "delivery" && o.PlatformId is null && (string.IsNullOrWhiteSpace(o.CustomerPhone) || string.IsNullOrWhiteSpace(o.DeliveryAddress)))
                throw new DomainException("A delivery needs the customer's phone and address before it's paid.");
            // Money is counted in the open business day and in the cashier's open shift on a register, whoever is signed in:
            // nothing is taken outside a drawer count.
            var day = await Days.CurrentAsync(c, tx, o.BranchId, scope.UserId);
            var shift = await Days.ShiftOfAsync(c, tx, scope.RegisterId, scope.UserId);
            if (list.Length > 0 && scope.RegisterId is null) throw new DomainException("Pick the register you're at first (on the Dashboard), then open your shift.");
            if (list.Length > 0 && shift is null) throw new DomainException("Open your shift first: count the float in the drawer (on the Dashboard).");
            // Non-cash first; cash last, so any change comes out of cash.
            foreach (var p in list.OrderBy(p => p.Method == "cash" ? 1 : 0))
            {
                var method = (p.Method ?? "").Trim().ToLowerInvariant();
                if (!Methods.Contains(method)) throw new DomainException("Payment method must be cash, card, other, voucher, account, points or platform.");
                if (method == "platform" && o.PlatformId is null) throw new DomainException("Only a delivery platform's order is paid by the platform.");
                if (p.Amount <= 0) throw new DomainException("A payment must be more than zero.");
                if (due <= 0) throw new DomainException("The order is already paid in full.");
                var reference = method == "platform" ? $"{o.PlatformName} {o.PlatformRef}" : Opt(p.Reference);
                if (method is "voucher" or "account" && reference is null) throw new DomainException(method == "voucher" ? "Enter the voucher code." : "Enter the customer account.");
                decimal amount, change = 0;
                decimal? tendered = null;
                if (method == "cash")
                {
                    tendered = Money.Round(p.Tendered ?? p.Amount);
                    amount = Math.Min(Money.Round(p.Amount), due);
                    if (tendered < amount) throw new DomainException("The cash received is less than the amount.");
                    change = tendered.Value - amount;
                }
                else
                {
                    amount = Money.Round(p.Amount);
                    if (amount > due) throw new DomainException($"A {method} payment can't be more than the {due:N2} still due.");
                }
                // A card: the FACTS card type, where the branch's FACTS payment methods have card types (the cashier picks one).
                string? cardType = null;
                if (method == "card")
                {
                    var cards = (await c.QueryAsync<string>("select name from erp_payment_mode where branch_id = @b and kind = 'card'", new { b = o.BranchId }, tx)).ToList();
                    if (cards.Count > 0)
                    {
                        cardType = cards.FirstOrDefault(x => string.Equals(x, p.CardType?.Trim(), StringComparison.OrdinalIgnoreCase))
                                   ?? throw new DomainException("Choose the card type.");
                    }
                }
                // A voucher pays from its balance; points from the attached customer's points (REQ CUS-02, CUS-03).
                Guid? voucherId = method == "voucher" ? await Rewards.RedeemAsync(c, tx, scope, reference, amount, o) : null;
                int? points = method == "points" ? await Rewards.RedeemPointsAsync(c, tx, scope, amount, o) : null;
                await c.ExecuteAsync("""
                    insert into payment (company_id, branch_id, register_id, order_id, business_date, method, amount, tendered, change_given, reference, taken_by, shift_id, voucher_id, points, card_type)
                    values (@co, @b, @reg, @id, @date, @method, @amount, @tendered, @change, @reference, @userId, @shift, @voucherId, @points, @cardType)
                    """, new { co = o.CompanyId, b = o.BranchId, reg = scope.RegisterId ?? o.RegisterId, id, date = day.Date, method, amount, tendered, change,
                               reference = voucherId is null ? reference : reference!.Trim().ToUpperInvariant(), userId = scope.UserId, shift, voucherId, points, cardType }, tx);
                due -= amount;
            }
            await c.ExecuteAsync("""
                update pos_order set paid = (select coalesce(sum(amount), 0) from payment where order_id = @id and kind = 'payment') where id = @id
                """, new { id }, tx);
            if (due <= 0)
            {
                await c.ExecuteAsync("update pos_order set status = 'paid', closed_at = now(), lock_session = null where id = @id", new { id }, tx);
                await Returns.AssignInvoiceAsync(c, tx, o);
                await Customers.LinkAsync(c, tx, id, scope.UserId);
                await Rewards.EarnAsync(c, tx, id, scope.UserId);
                await Recipes.ConsumeAsync(c, tx, id, scope.UserId);
                await Pickup.OnPaidAsync(c, tx, id);
                await Boms.EnqueueBillRepackingAsync(c, tx, id);
                await Erp.FactsPosting.EnqueueInvoiceAsync(c, tx, id);
                await OrderTables.ReleaseAsync(c, tx, id);
                // Paying sends whatever wasn't sent yet (a counter order goes to the kitchen when it's paid).
                await Kitchen.SendAsync(c, tx, o, scope.UserId);
            }
        }, allowClosed: false));

        api.MapPost("/orders/{id:guid}/void", (Guid id, ReasonBody body, HttpContext http, Db db, Live live) => Mutate(http, db, live, id, "pos.sell", async (c, tx, o, scope) =>
        {
            if (string.IsNullOrWhiteSpace(body.Reason)) throw new DomainException("Give a reason to void the order.");
            if (o.Paid > 0) throw new DomainException("This order has payments. Refund them first.");
            if (await c.ExecuteScalarAsync<bool>("select exists (select 1 from order_line where order_id = @id and sent_qty > 0 and not is_void)", new { id }, tx))
                scope.Require("pos.void");
            await Kitchen.CancelOrderAsync(c, tx, o, scope.UserId);
            await c.ExecuteAsync("update pos_order set status = 'void', void_reason = @r, closed_at = now(), lock_session = null where id = @id", new { id, r = body.Reason.Trim() }, tx);
            await OrderTables.ReleaseAsync(c, tx, id);
            await Audit.RecordAsync(c, tx, o.CompanyId, o.BranchId, scope.UserId, "order", id.ToString(), "void", $"Order #{o.Number} voided ({o.Total:N2})", note: body.Reason.Trim());
        }));

    }

    /// <summary>
    /// Runs one change on an open order in a transaction: loads and locks it, checks the branch and the permission, applies `work`,
    /// recalculates the totals, bumps the version, and answers the whole order. A live event tells the branch's other screens.
    /// </summary>
    internal static async Task<IResult> Mutate(HttpContext http, Db db, Live live, Guid id, string perm,
        Func<NpgsqlConnection, NpgsqlTransaction, OrderRow, Scope, Task> work, bool allowClosed = false)
    {
        var scope = await http.ScopeAsync(db);
        scope.Require(perm);
        var branchId = scope.Branch;
        var result = await db.Company(scope.CompanyId, async (c, tx) =>
        {
            var o = await c.QuerySingleOrDefaultAsync<OrderRow>("select * from pos_order where id = @id for update", new { id }, tx)
                    ?? throw new NotFoundException("That order no longer exists.");
            if (o.BranchId != branchId) throw new ForbiddenException("This order belongs to another branch.");
            if (!allowClosed && o.Status != "open")
                throw new ConflictException($"Order #{o.Number} is already {(o.Status is "void" ? "voided" : o.Status is "merged" ? "merged into another order" : o.Status)}.");
            // One device edits an open order at a time (REQ TBL-08); editing takes the lock if nobody else holds it.
            if (o.Status == "open") await OrderTables.LockAsync(c, tx, http, scope, id, o);
            await work(c, tx, o, scope);
            await RecalcAsync(c, tx, id);
            // A bill of a day already summed for reports (carried over and paid later, returned, refunded): that day is summed again.
            await SalesSummary.RefreshAsync(c, tx, o.CompanyId, o.BranchId, o.BusinessDate);
            return await DetailAsync(c, tx, id);
        });
        await live.ToBranch(branchId, "order.changed", new { id });
        if (result.Order.TableIds.Length > 0 || result.Order.Status != "open") await live.ToBranch(branchId, "floor.changed");
        return Results.Ok(result);
    }

    /// <summary>
    /// The bill (REQ REG-09): subtotal of active lines; the order discount spread over lines by value; service charge on dine-in;
    /// VAT per line and on the service charge — extracted when prices include VAT, added when they don't. Rounded per line.
    /// </summary>
    public static async Task RecalcAsync(NpgsqlConnection c, NpgsqlTransaction tx, Guid id)
    {
        var o = await c.QuerySingleAsync<OrderRow>("select * from pos_order where id = @id", new { id }, tx);
        var lines = (await c.QueryAsync<LineRow>("select * from order_line where order_id = @id and not is_void order by sort", new { id }, tx)).ToList();
        var t = Totals.Compute(lines.Select(l => new Totals.LineIn(l.Id, Money.Round(l.UnitPrice * l.Qty), l.Qty, l.DiscType, l.DiscValue)).ToList(),
            o.DiscountPct, o.DiscountAmount, o.OrderType == "dine_in" ? o.ServicePct : 0, o.VatRate, o.PricesIncludeVat);
        foreach (var l in t.Lines)
            await c.ExecuteAsync("update order_line set line_total = @Gross, discount = @Discount, vat = @Vat where id = @Id", l, tx);
        await c.ExecuteAsync("""
            update pos_order set subtotal = @Subtotal, discount_total = @Discount, service_charge = @Service, vat = @Vat, total = @Total, version = version + 1 where id = @id
            """, new { id, t.Subtotal, t.Discount, t.Service, t.Vat, t.Total }, tx);
    }

    private const string ListSql = """
        select o.*, r.name as register_name, u.display_name as opened_by_name,
               coalesce(array(select ot.table_id from order_table ot where ot.order_id = o.id order by ot.is_primary desc), '{}') as table_ids,
               (select string_agg(t.name, ' + ' order by ot.is_primary desc, t.name) from order_table ot join dining_table t on t.id = ot.table_id where ot.order_id = o.id) as table_names,
               case when o.lock_at > now() - interval '90 seconds' then o.lock_label end as locked_by,
               (select coalesce(sum(qty), 0) from order_line l where l.order_id = o.id and not l.is_void)::int as items,
               (select dp.name from delivery_platform dp where dp.id = o.platform_id) as platform_name
        from pos_order o
        left join register r on r.id = o.register_id
        left join app_user u on u.id = o.opened_by
        """;

    /// <summary>The order, its lines, payments, and its kitchen tickets (the till shows Preparing / Ready, REQ KIT-04).</summary>
    public sealed record Detail(OrderRow Order, IEnumerable<object> Lines, IEnumerable<PaymentRow> Payments, IEnumerable<Kitchen.TicketRow> Tickets,
        IEnumerable<Returns.CreditNoteRow> CreditNotes);

    /// <summary>
    /// An order's receipt: the company and branch header, the branch's receipt settings, and the order. Where the branch prints
    /// a QR code to the digital receipt and the order is paid, its link token (made once). The public view (REQ PAY-05) leaves
    /// out payment references (a voucher code could be spent) and kitchen tickets.
    /// </summary>
    public static async Task<object> ReceiptAsync(NpgsqlConnection c, NpgsqlTransaction tx, Guid id, Guid companyId, bool publicView)
    {
        var header = await c.QuerySingleAsync<(string LegalName, string? Trn, string Currency, string Branch, string BranchCode, string? Address, string? Phone, string? ReceiptHeader, string? ReceiptFooter,
            string? LegalNameAr, string? BranchAr, string? AddressAr, string Language, string Settings, string? Email, string? Website, DateTime? LogoAt, bool HasLogo, string TradingName, string Status)>("""
            select co.legal_name, co.trn, co.base_currency as currency, b.name as branch, b.code as branch_code, b.address, b.phone, b.receipt_header, b.receipt_footer,
                   co.legal_name_ar, b.name_ar, b.address_ar, b.receipt_language, b.receipt_settings::text, co.email, co.website, co.logo_at, co.logo_file is not null, co.name, o.status
            from pos_order o join branch b on b.id = o.branch_id join company co on co.id = o.company_id where o.id = @id
            """, new { id }, tx);
        var settings = Branding.Settings(header.Settings);
        string? qrToken = null;
        if (settings.Show.GetValueOrDefault("qr") && header.Status is "paid" or "refunded")
        {
            qrToken = await c.ExecuteScalarAsync<string?>("select token from receipt_link where order_id = @id", new { id }, tx);
            if (qrToken is null)
            {
                qrToken = Convert.ToBase64String(System.Security.Cryptography.RandomNumberGenerator.GetBytes(15)).Replace('+', '-').Replace('/', '_');
                await c.ExecuteAsync("insert into receipt_link (token, company_id, order_id) values (@qrToken, @companyId, @id)", new { qrToken, companyId, id }, tx);
            }
        }
        var detail = await DetailAsync(c, tx, id);
        if (publicView)
            detail = detail with { Payments = detail.Payments.Select(p => { p.Reference = null; return p; }).ToList(), Tickets = [] };
        return new
        {
            header.LegalName, header.Trn, header.Currency, header.Branch, header.BranchCode, header.Address, header.Phone, header.ReceiptHeader, header.ReceiptFooter,
            header.LegalNameAr, header.BranchAr, header.AddressAr, header.Language, header.Email, header.Website,
            settings, logoAt = header.HasLogo ? header.LogoAt : null, companyId, header.TradingName, detail, qrToken,
        };
    }

    public static async Task<Detail> DetailAsync(NpgsqlConnection c, NpgsqlTransaction tx, Guid id)
    {
        var order = await c.QuerySingleAsync<OrderRow>($"{ListSql} where o.id = @id", new { id }, tx);
        var lines = (await c.QueryAsync<LineRow>("select * from order_line where order_id = @id order by sort", new { id }, tx))
            .Select(l => (object)new { l.Id, l.ItemId, l.Name, l.NameAr, l.UnitPrice, l.Qty, modifiers = JsonDocument.Parse(l.Modifiers).RootElement, l.Note, l.Station, l.SentQty, l.LineTotal, l.Vat, l.IsVoid, l.VoidReason, l.ReturnedQty,
                                      l.Discount, l.DiscSource, l.DiscName, l.DiscType, l.DiscValue, l.DiscNote })
            .ToList();
        var payments = await c.QueryAsync<PaymentRow>("""
            select p.*, u.display_name as taken_by_name from payment p left join app_user u on u.id = p.taken_by where p.order_id = @id order by p.at
            """, new { id }, tx);
        return new Detail(order, lines, payments.ToList(), await Kitchen.TicketsAsync(c, tx, "t.order_id = @id", new { id }), await Returns.CreditNotesAsync(c, tx, id));
    }

    private static async Task<LineRow> LineAsync(NpgsqlConnection c, NpgsqlTransaction tx, Guid id, Guid lineId) =>
        await c.QuerySingleOrDefaultAsync<LineRow>("select * from order_line where id = @lineId and order_id = @id and not is_void for update", new { id, lineId }, tx)
        ?? throw new NotFoundException("That line is no longer on the order.");

    private static async Task BranchCheckAsync(NpgsqlConnection c, NpgsqlTransaction tx, Guid id, Guid branchId)
    {
        var b = await c.ExecuteScalarAsync<Guid?>("select branch_id from pos_order where id = @id", new { id }, tx) ?? throw new NotFoundException("Order not found.");
        if (b != branchId) throw new ForbiddenException("This order belongs to another branch.");
    }

    private static async Task<string> TzAsync(NpgsqlConnection c, NpgsqlTransaction tx, Guid branchId) =>
        await c.ExecuteScalarAsync<string>("select time_zone from branch where id = @branchId", new { branchId }, tx) ?? "Asia/Dubai";

    private static string CleanType(string? t)
    {
        var type = (t ?? "").Trim().ToLowerInvariant().Replace("-", "_");
        if (!Types.Contains(type)) throw new DomainException("The order type must be dine-in, takeaway or delivery.");
        return type;
    }


    /// <summary>A quantity: more than 0, at most 9,999, with no more decimals than the item's unit allows (0 = whole units).</summary>
    internal static void CheckQty(decimal qty, int decimals, string name)
    {
        if (qty <= 0 || qty > 9999) throw new DomainException("A quantity is more than 0 and at most 9,999.");
        var scaled = qty * (decimals switch { 0 => 1m, 1 => 10m, 2 => 100m, _ => 1000m });
        if (scaled != decimal.Truncate(scaled))
            throw new DomainException(decimals == 0 ? $"{name} is sold in whole units." : $"{name} takes a quantity with up to {decimals} decimals.");
    }
    private static string? Opt(string? s) => string.IsNullOrWhiteSpace(s) ? null : s.Trim();
}

/// <summary>The bill arithmetic, kept pure so it can be tested on its own.</summary>
public static class Totals
{
    /// <summary>A bill line: its value (unit price × qty), qty, and its own discount if it has one (a promotion or an item discount).</summary>
    public sealed record LineIn(Guid Id, decimal Gross, decimal Qty, string? DiscType = null, decimal? DiscValue = null);
    public sealed record Line(Guid Id, decimal Gross, decimal Discount, decimal Vat);
    public sealed record Result(decimal Subtotal, decimal Discount, decimal Service, decimal Vat, decimal Total, List<Line> Lines);

    /// <summary>A line's own discount: % of its value, AED off each, or a fixed price each (never more than the line is worth).</summary>
    public static decimal Own(decimal gross, decimal qty, string? type, decimal? value) => type is null || value is not { } v ? 0 : type switch
    {
        "pct" => Money.Round(gross * Math.Min(v, 100) / 100),
        "amount" => Math.Min(gross, Money.Round(v * qty)),
        "price" => Math.Max(0, gross - Money.Round(v * qty)),
        _ => 0,
    };

    /// <summary>
    /// The bill: the bill discount (% or AED) spread over the lines by value (the last line takes the rounding); each line then gets
    /// the BIGGER of its own discount and its share, never both (no stacking). Service charge on what's left; VAT per line and on the
    /// service charge, extracted when prices include VAT, added when they don't. Without any line discount this is exactly the old bill.
    /// </summary>
    public static Result Compute(List<LineIn> lines, decimal discountPct, decimal discountAmount, decimal servicePct, decimal vatRate, bool pricesIncludeVat)
    {
        var subtotal = lines.Sum(l => l.Gross);
        var billDiscount = discountPct > 0 ? Money.Round(subtotal * discountPct / 100) : Math.Min(Money.Round(discountAmount), subtotal);
        var r = vatRate / 100;
        var outLines = new List<Line>();
        decimal spread = 0, lineVat = 0, net = 0, discount = 0;
        for (var i = 0; i < lines.Count; i++)
        {
            var l = lines[i];
            var share = i == lines.Count - 1 ? billDiscount - spread : subtotal == 0 ? 0 : Money.Round(billDiscount * l.Gross / subtotal);
            spread += share;
            var d = Math.Min(l.Gross, Math.Max(share, Own(l.Gross, l.Qty, l.DiscType, l.DiscValue)));
            discount += d;
            var after = l.Gross - d;
            net += after;
            var vat = pricesIncludeVat ? Money.Round(after - after / (1 + r)) : Money.Round(after * r);
            lineVat += vat;
            outLines.Add(new Line(l.Id, l.Gross, d, vat));
        }
        var service = Money.Round(net * servicePct / 100);
        var serviceVat = pricesIncludeVat ? Money.Round(service - service / (1 + r)) : Money.Round(service * r);
        var vatTotal = lineVat + serviceVat;
        var total = pricesIncludeVat ? net + service : net + service + vatTotal;
        return new Result(subtotal, discount, service, vatTotal, total, outLines);
    }
}

/// <summary>Every 10 minutes removes empty open orders older than 30 minutes (a till closed mid-order, a tablet that went away).</summary>
public sealed class EmptyOrderSweep(IConfiguration config, ILogger<EmptyOrderSweep> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stop)
    {
        // Runs as the owner role: it spans every company (RLS would hide them from the app role).
        var owner = config.GetConnectionString("Owner");
        while (!stop.IsCancellationRequested)
        {
            try
            {
                await using var c = new NpgsqlConnection(owner);
                await c.OpenAsync(stop);
                var n = await c.ExecuteScalarAsync<int>("""
                    with gone as (
                      delete from pos_order o where o.status = 'open' and o.opened_at < now() - interval '30 minutes'
                        and not exists (select 1 from order_line l where l.order_id = o.id) and not exists (select 1 from payment p where p.order_id = o.id)
                      returning o.id
                    ), fix as (update reservation set status = 'booked', order_id = null where order_id in (select id from gone))
                    select count(*)::int from gone
                    """);
                if (n > 0) logger.LogInformation("Removed {Count} empty orders", n);
            }
            catch (Exception ex) when (ex is not OperationCanceledException) { logger.LogWarning(ex, "Empty order sweep failed"); }
            await Task.Delay(TimeSpan.FromMinutes(10), stop).ContinueWith(_ => { });
        }
    }
}
