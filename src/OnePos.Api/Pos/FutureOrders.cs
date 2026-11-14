using Dapper;
using Npgsql;
using OnePos.Api.Data;
using OnePos.Api.Platform;

namespace OnePos.Api.Pos;

/// <summary>
/// Future orders (a cake for Saturday): taken now with an advance, collected and invoiced on a later day. Where the branch has
/// Future orders switched on.
///  - New: an order with the customer's name and phone and when it's collected (FO-&lt;branch&gt;-000001). Items are added on the
///    register as usual; while it waits, every payment on it is an advance (cash or card), counted in the shift and day it was
///    taken; the order stays open even when paid in full, and isn't among the register's open orders.
///  - Collect: the order moves to today's business day; with nothing left to pay it's finished at once (invoice, stock, FACTS),
///    otherwise the balance is paid on the register as on any bill.
///  - Cancel (a manager): the advances go back the way they were paid, and the order is voided.
/// FACTS (company setting): each advance as a QRV51 to POS customer advances; the bill later paid by ADVANCE (FactsPosting).
/// </summary>
public static class FutureOrders
{
    public sealed record NewBody(string? Type, string? CustomerName, string? CustomerPhone, string? DeliveryAddress, DateTime CollectAt, string? Note);
    public sealed record ChangeBody(DateTime? CollectAt, string? Note);
    public sealed record CancelBody(string? Reason);

    public sealed class Row
    {
        public Guid Id { get; set; }
        public string? FutureRef { get; set; }
        public string FutureStatus { get; set; } = "";
        public string Status { get; set; } = "";
        public string OrderType { get; set; } = "";
        public string? CustomerName { get; set; }
        public string? CustomerPhone { get; set; }
        public string? DeliveryAddress { get; set; }
        public string? Note { get; set; }
        public DateTime CollectAt { get; set; }
        public DateOnly CollectDate { get; set; }
        public decimal Total { get; set; }
        public decimal Paid { get; set; }
        public decimal Due => Math.Max(0, Total - Paid);
        public int Items { get; set; }
        public int Unsent { get; set; }
        public DateTime? ReadyAt { get; set; }
        public DateTime OpenedAt { get; set; }
        public string? OpenedByName { get; set; }
        public string? LockedBy { get; set; }
    }

    private static string? Opt(string? s) => string.IsNullOrWhiteSpace(s) ? null : s.Trim();

    private static async Task RequireOnAsync(NpgsqlConnection c, NpgsqlTransaction tx, Guid branchId)
    {
        if (!await c.ExecuteScalarAsync<bool>("select future_orders from branch where id = @branchId", new { branchId }, tx))
            throw new DomainException("Future orders are switched off for this branch (Companies & branches).");
    }

    public static void Map(RouteGroupBuilder api)
    {
        // The branch's future orders: due today, tomorrow, overdue (the day passed, not collected), all waiting, or done lately.
        api.MapGet("/future-orders", async (HttpContext http, Db db, string? view) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("pos.sell");
            var v = (view ?? "today").Trim().ToLowerInvariant();
            return await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var today = await Days.DateAsync(c, tx, scope.Branch);
                var rows = (await c.QueryAsync<Row>("""
                    select * from (
                      select o.id, o.future_ref, o.future_status, o.status, o.order_type, o.customer_name, o.customer_phone, o.delivery_address, o.note,
                             o.collect_at, (o.collect_at at time zone b.time_zone)::date as collect_date, o.total, o.paid, o.ready_at, o.opened_at,
                             u.display_name as opened_by_name,
                             (select coalesce(sum(qty), 0) from order_line l where l.order_id = o.id and not l.is_void)::int as items,
                             (select coalesce(sum(qty - sent_qty), 0) from order_line l where l.order_id = o.id and not l.is_void)::int as unsent,
                             case when o.lock_at > now() - interval '90 seconds' then o.lock_label end as locked_by
                      from pos_order o join branch b on b.id = o.branch_id left join app_user u on u.id = o.opened_by
                      where o.branch_id = @b and o.future_status is not null) x
                    where case @v
                            when 'today' then future_status = 'waiting' and collect_date = @today
                            when 'tomorrow' then future_status = 'waiting' and collect_date = @today + 1
                            when 'overdue' then future_status = 'waiting' and collect_date < @today
                            when 'open' then future_status = 'waiting'
                            else future_status <> 'waiting' and collect_date >= @today - 30 end
                    order by case when @v = 'done' then collect_at end desc, collect_at, opened_at
                    limit 500
                    """, new { b = scope.Branch, v, today }, tx)).ToList();
                var counts = await c.QuerySingleAsync<(int Today, int Tomorrow, int Overdue, int Open)>("""
                    select count(*) filter (where d = @today)::int, count(*) filter (where d = @today + 1)::int, count(*) filter (where d < @today)::int, count(*)::int
                    from (select (o.collect_at at time zone b.time_zone)::date as d from pos_order o join branch b on b.id = o.branch_id
                          where o.branch_id = @b and o.future_status = 'waiting') x
                    """, new { b = scope.Branch, today }, tx);
                return new { today, counts = new { counts.Today, counts.Tomorrow, counts.Overdue, counts.Open }, orders = rows };
            });
        });

        // A new future order: who, when it's collected, takeaway or delivery. Items and the advance are taken on the register.
        api.MapPost("/future-orders", async (NewBody body, HttpContext http, Db db, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("pos.sell");
            var name = Opt(body.CustomerName) ?? throw new DomainException("Enter the customer's name.");
            var phone = Opt(body.CustomerPhone) ?? throw new DomainException("Enter the customer's phone number.");
            var type = (body.Type ?? "takeaway").Trim().ToLowerInvariant();
            if (type is not ("takeaway" or "delivery")) throw new DomainException("A future order is collected (takeaway) or delivered.");
            if (type == "delivery" && Opt(body.DeliveryAddress) is null) throw new DomainException("Enter the delivery address.");
            var collectAt = body.CollectAt.ToUniversalTime();
            if (collectAt <= DateTime.UtcNow) throw new DomainException("Choose a collection time that is still to come.");
            if (collectAt > DateTime.UtcNow.AddDays(366)) throw new DomainException("A collection time is at most a year ahead.");
            var detail = await db.Company(scope.CompanyId, async (c, tx) =>
            {
                await RequireOnAsync(c, tx, scope.Branch);
                var id = await Orders.OpenAsync(c, tx, http, scope, new Orders.OpenBody(type, null, null, name, phone, Opt(body.DeliveryAddress), null));
                var futureRef = await Returns.NextAsync(c, tx, scope.CompanyId, scope.Branch, "FO");
                await c.ExecuteAsync("update pos_order set collect_at = @collectAt, future_status = 'waiting', future_ref = @futureRef, note = @note where id = @id",
                    new { id, collectAt, futureRef, note = Opt(body.Note) }, tx);
                await Audit.RecordAsync(c, tx, scope.CompanyId, scope.Branch, scope.UserId, "order", id.ToString(), "future", $"Future order {futureRef} for {name}, collected {collectAt:yyyy-MM-dd HH:mm} UTC");
                return await Orders.DetailAsync(c, tx, id);
            });
            await live.ToBranch(scope.Branch, "order.changed", new { id = detail.Order.Id });
            return Results.Ok(detail);
        });

        // Another collection time, or a note (e.g. the writing on the cake).
        api.MapPut("/future-orders/{id:guid}", (Guid id, ChangeBody body, HttpContext http, Db db, Live live) => Orders.Mutate(http, db, live, id, "pos.sell", async (c, tx, o, scope) =>
        {
            Waiting(o);
            DateTime? collectAt = body.CollectAt?.ToUniversalTime();
            if (collectAt is { } t && t != o.CollectAt && t <= DateTime.UtcNow) throw new DomainException("Choose a collection time that is still to come.");
            await c.ExecuteAsync("update pos_order set collect_at = coalesce(@collectAt, collect_at), note = case when @noteSet then @note else note end where id = @id",
                new { id, collectAt, noteSet = body.Note is not null, note = Opt(body.Note) }, tx);
            if (collectAt is { } at && at != o.CollectAt)
                await Audit.RecordAsync(c, tx, o.CompanyId, o.BranchId, scope.UserId, "order", id.ToString(), "future", $"Future order {o.FutureRef}: collection time changed",
                    [new("Collected", o.CollectAt?.ToString("yyyy-MM-dd HH:mm"), at.ToString("yyyy-MM-dd HH:mm"))]);
        }));

        // Made and waiting on the shelf (or back to not ready).
        api.MapPost("/future-orders/{id:guid}/ready", (Guid id, HttpContext http, Db db, Live live) => Orders.Mutate(http, db, live, id, "pos.sell", async (c, tx, o, scope) =>
        {
            Waiting(o);
            await c.ExecuteAsync("update pos_order set ready_at = case when ready_at is null then now() end where id = @id", new { id }, tx);
        }));

        // The customer is here: the order becomes today's bill. Nothing left to pay: finished now (handed over). Otherwise the till
        // takes the balance on the register.
        api.MapPost("/future-orders/{id:guid}/collect", (Guid id, HttpContext http, Db db, Live live) => Orders.Mutate(http, db, live, id, "pos.sell", async (c, tx, o, scope) =>
        {
            Waiting(o);
            if (!await c.ExecuteScalarAsync<bool>("select exists (select 1 from order_line where order_id = @id and not is_void)", new { id }, tx))
                throw new DomainException("This order has no items. Add them on the register first.");
            if (o.Paid > o.Total)
                throw new DomainException($"The advance ({o.Paid:N2}) is more than the order now ({o.Total:N2}). Add the items back, or cancel the order to refund it.");
            var day = (await Days.CurrentAsync(c, tx, o.BranchId, scope.UserId)).Date;
            await c.ExecuteAsync("update pos_order set future_status = 'collected', business_date = @day, register_id = coalesce(@reg, register_id) where id = @id",
                new { id, day, reg = scope.RegisterId }, tx);
            await Audit.RecordAsync(c, tx, o.CompanyId, o.BranchId, scope.UserId, "order", id.ToString(), "collected",
                $"Future order {o.FutureRef} collected: advance {o.Paid:N2}, balance {o.Due:N2}");
            if (o.Due <= 0)
            {
                o.BusinessDate = day;
                await Orders.FinishAsync(c, tx, o, scope);
                await c.ExecuteAsync("update pos_order set collected_at = coalesce(collected_at, now()) where id = @id", new { id }, tx);
            }
        }));

        // Cancelled, as a bill is returned: anyone at the till when every advance was taken today; an advance from an earlier day
        // needs a manager (day.manage) or a manager's approval. Every advance goes back the way it was paid (cash from this drawer,
        // a card back to the card, a voucher as a new voucher, points back to the customer), the kitchen's tickets are cancelled,
        // and the order is voided.
        api.MapPost("/future-orders/{id:guid}/cancel", (Guid id, CancelBody body, HttpContext http, Db db, Live live) => Orders.Mutate(http, db, live, id, "pos.sell", async (c, tx, o, scope) =>
        {
            Waiting(o);
            var reason = Opt(body.Reason) ?? throw new DomainException("Give a reason for cancelling.");
            var advances = (await c.QueryAsync<(Guid Id, string Method, decimal Amount, string? CardType, string? AdvanceNo, DateOnly BusinessDate)>(
                "select id, method, amount, card_type, advance_no, business_date from payment where order_id = @id and kind = 'payment' order by at", new { id }, tx)).ToList();
            if (advances.Count > 0)
            {
                var day = (await Days.CurrentAsync(c, tx, o.BranchId, scope.UserId)).Date;
                if (advances.Any(a => a.BusinessDate != day) && !scope.IsAdmin && !scope.Can("day.manage"))
                    await Approvals.RequireAsync(c, tx, http, scope, "refund", advances.Sum(a => a.Amount),
                        "The advance was taken on an earlier day: only a manager cancels it. A manager can approve it.", late: true, orderId: o.Id);
                var shift = await Days.ShiftOfAsync(c, tx, scope.RegisterId, scope.UserId);
                if (advances.Any(a => a.Method == "cash") && scope.RegisterId is null) throw new DomainException("A cash advance goes back out of a drawer: pick the register you're at first (on the Dashboard).");
                if (scope.RegisterId is not null && shift is null) throw new DomainException("Open your shift first: count the float in the drawer (on the Dashboard).");
                foreach (var a in advances)
                {
                    // Its own number; the advance it gives back is its reference (FACTS reverses that one).
                    var advanceNo = await Returns.NextAsync(c, tx, o.CompanyId, o.BranchId, "ADV");
                    // A voucher advance comes back as a new voucher for the amount (its code is on the order's receipt); points go back.
                    Guid? voucherId = a.Method == "voucher"
                        ? (await Rewards.IssueAsync(c, tx, o.CompanyId, o.BranchId, scope.UserId, a.Amount, "refund", null, o.CustomerId, $"Cancelled {o.FutureRef}", o.Id)).Id
                        : null;
                    await c.ExecuteAsync("""
                        insert into payment (company_id, branch_id, register_id, order_id, business_date, kind, method, amount, reason, reference, taken_by, shift_id, card_type, is_advance, advance_no, voucher_id)
                        values (@co, @b, @reg, @id, @day, 'refund', @Method, @Amount, @reason, @AdvanceNo, @user, @shift, @CardType, true, @advanceNo2, @voucherId)
                        """, new { co = o.CompanyId, b = o.BranchId, reg = scope.RegisterId, id, day, a.Method, a.Amount, reason, a.AdvanceNo, user = scope.UserId, shift, a.CardType, advanceNo2 = advanceNo, voucherId }, tx);
                    if (a.Method == "points") await Rewards.RefundAsync(c, tx, o, scope.UserId, "points", a.Amount);
                    // Not sent to FACTS: finance books an advance given back by hand.
                }
                await c.ExecuteAsync("update pos_order set refunded = @paid where id = @id", new { id, paid = advances.Sum(a => a.Amount) }, tx);
            }
            await Kitchen.CancelOrderAsync(c, tx, o, scope.UserId);
            await c.ExecuteAsync("update pos_order set status = 'void', future_status = 'cancelled', void_reason = @reason, closed_at = now(), lock_session = null where id = @id",
                new { id, reason }, tx);
            await Audit.RecordAsync(c, tx, o.CompanyId, o.BranchId, scope.UserId, "order", id.ToString(), "void",
                $"Future order {o.FutureRef} cancelled{(advances.Count > 0 ? $", advance {advances.Sum(a => a.Amount):N2} refunded ({string.Join(", ", advances.Select(a => $"{a.CardType ?? a.Method} {a.Amount:N2}"))})" : "")}",
                note: reason);
        }));
    }

    /// <summary>
    /// A collected future order's bill was returned (Return on Orders): only the bill is undone. The order goes back to waiting as a
    /// new order with the same FO number, customer, collection time, note and items (not sent to the kitchen), and its advances
    /// move onto it: the same payment rows (their day and shift don't change), the same QRV51s in FACTS. The balance paid at
    /// collection was refunded with the credit note. In FACTS the return (PSR51, a copy of the bill) puts the ADVANCE part back on
    /// 2802, and the next collection's bill takes it off again.
    /// </summary>
    public static async Task<Guid?> BackToWaitingAsync(NpgsqlConnection c, NpgsqlTransaction tx, Orders.OrderRow o, Scope scope)
    {
        if (o.FutureStatus != "collected") return null;
        if (!await c.ExecuteScalarAsync<bool>("select exists (select 1 from payment where order_id = @Id and kind = 'payment' and is_advance)", new { o.Id }, tx)) return null;
        var day = (await Days.CurrentAsync(c, tx, o.BranchId, scope.UserId)).Date;
        var id = await c.ExecuteScalarAsync<Guid>("""
            insert into pos_order (company_id, branch_id, register_id, business_date, number, order_type, customer_name, customer_phone, delivery_address, note,
                                   vat_rate, prices_include_vat, service_pct, opened_by, customer_id, collect_at, future_status, future_ref)
            select company_id, branch_id, coalesce(@reg, register_id), @day, null, order_type, customer_name, customer_phone, delivery_address, note,
                   vat_rate, prices_include_vat, service_pct, @user, customer_id, collect_at, 'waiting', future_ref
            from pos_order where id = @Id returning id
            """, new { o.Id, reg = scope.RegisterId, day, user = scope.UserId }, tx);
        await c.ExecuteAsync("""
            insert into order_line (company_id, order_id, item_id, name, name_ar, unit_price, qty, modifiers, note, station, sort, added_by,
                                    disc_source, disc_id, disc_name, disc_type, disc_value, disc_note, disc_by, erp_unit)
            select company_id, @id, item_id, name, name_ar, unit_price, qty, modifiers, note, station, sort, @user,
                   disc_source, disc_id, disc_name, disc_type, disc_value, disc_note, disc_by, erp_unit
            from order_line where order_id = @fromId and not is_void order by sort
            """, new { id, fromId = o.Id, user = scope.UserId }, tx);
        // The advances, with their FACTS postings (QRV51), move to the waiting order.
        var moved = await c.ExecuteScalarAsync<decimal>("""
            with m as (update payment set order_id = @id where order_id = @fromId and kind = 'payment' and is_advance returning id, amount),
                 e as (update erp_post set order_id = @id where kind = 'advance' and payment_id in (select id from m))
            select coalesce(sum(amount), 0) from m
            """, new { id, fromId = o.Id }, tx);
        var copy = await c.QuerySingleAsync<Orders.OrderRow>("select * from pos_order where id = @id", new { id }, tx);
        await Orders.NumberAsync(c, tx, copy);
        await Orders.RecalcAsync(c, tx, id);
        await c.ExecuteAsync("update pos_order set paid = @moved where id = @id", new { id, moved }, tx);
        await Audit.RecordAsync(c, tx, o.CompanyId, o.BranchId, scope.UserId, "order", id.ToString(), "future",
            $"Future order {o.FutureRef}: bill {o.InvoiceNo} returned, back to waiting with its advance {moved:N2}");
        return id;
    }

    private static void Waiting(Orders.OrderRow o)
    {
        if (o.FutureStatus != "waiting")
            throw new DomainException(o.FutureStatus is null ? "This isn't a future order." : $"Future order {o.FutureRef} was already {o.FutureStatus}.");
    }
}
