using Dapper;
using Npgsql;
using OnePos.Api.Data;
using OnePos.Api.Platform;

namespace OnePos.Api.Pos;

/// <summary>
/// The order-ready screen (REQ KIT-06): takeaway and delivery orders of the business day, Preparing then Ready, until collected.
/// With a kitchen the tickets move them (all ready → Ready, all served → Collected); the till can also mark them by hand
/// (the branch's mode decides: off, automatic, or one tap by the cashier). Ready numbers leave by themselves after the branch's minutes.
/// </summary>
public static class Pickup
{
    public sealed record StateBody(string State);

    public sealed class Row
    {
        public Guid Id { get; set; }
        public int? Number { get; set; }
        public string OrderType { get; set; } = "";
        public string? CustomerName { get; set; }
        public string? PlatformName { get; set; }
        public string? PlatformRef { get; set; }
        public DateTime OpenedAt { get; set; }
        public DateTime? ReadyAt { get; set; }
    }

    /// <summary>After a kitchen ticket moves: the order is Ready when every ticket is ready or served, Collected when every one is served.</summary>
    public static async Task FromTicketsAsync(NpgsqlConnection c, NpgsqlTransaction tx, Guid orderId)
    {
        await c.ExecuteAsync("""
            with t as (
              select count(*) as n, count(*) filter (where status in ('ready','served')) as ready, count(*) filter (where status = 'served') as served
              from kitchen_ticket where order_id = @orderId and not is_cancel)
            update pos_order o set
              ready_at = case when t.n > 0 and t.ready = t.n then coalesce(o.ready_at, now()) else null end,
              collected_at = case when t.n > 0 and t.served = t.n then coalesce(o.collected_at, now()) else null end
            from t where o.id = @orderId and o.order_type <> 'dine_in'
            """, new { orderId }, tx);
    }

    /// <summary>Paid: where the screen is automatic and there's no kitchen, the number shows as ready straight away.</summary>
    public static Task OnPaidAsync(NpgsqlConnection c, NpgsqlTransaction tx, Guid orderId) =>
        c.ExecuteAsync("""
            update pos_order o set ready_at = coalesce(o.ready_at, now()) from branch b
            where o.id = @orderId and b.id = o.branch_id and b.pickup_mode = 'auto' and not b.kitchen_enabled and o.order_type <> 'dine_in'
            """, new { orderId }, tx);

    public static void Map(RouteGroupBuilder api)
    {
        api.MapGet("/pickup", async (HttpContext http, Db db) =>
        {
            var scope = await http.ScopeAsync(db);
            if (!scope.Can("pos.sell")) scope.Require("kitchen.view");
            return await db.Company<object>(scope.CompanyId, async (c, tx) =>
            {
                var day = await Days.DateAsync(c, tx, scope.Branch);
                var br = await c.QuerySingleAsync<(string Name, string? NameAr, string Mode, int Minutes)>(
                    "select name, name_ar, pickup_mode, pickup_minutes from branch where id = @b", new { b = scope.Branch }, tx);
                if (br.Mode == "off") return new { mode = br.Mode, branch = br.Name, branchAr = br.NameAr, preparing = Enumerable.Empty<Row>(), ready = Enumerable.Empty<Row>() };
                // On the screen, not voided or collected: with a kitchen, what it's making (has tickets); without one, what's paid.
                // Marked ready by hand shows either way. Still preparing after 3 hours (never marked) or ready for 30 minutes: off the screen.
                var rows = (await c.QueryAsync<Row>("""
                    select o.id, o.number, o.order_type, o.customer_name, dp.name as platform_name, o.platform_ref, o.opened_at, o.ready_at
                    from pos_order o join branch br on br.id = o.branch_id left join delivery_platform dp on dp.id = o.platform_id
                    where o.branch_id = @b and o.business_date = @day and o.order_type <> 'dine_in' and o.number is not null
                      and o.collected_at is null and o.status <> 'void'
                      and (o.ready_at > now() - make_interval(mins => br.pickup_minutes)
                           or o.ready_at is null and o.opened_at > now() - interval '3 hours'
                              and case when br.kitchen_enabled then exists (select 1 from kitchen_ticket k where k.order_id = o.id and not k.is_cancel)
                                       else br.pickup_mode = 'cashier' and o.status in ('paid','refunded') end)
                    order by coalesce(o.ready_at, o.opened_at)
                    """, new { b = scope.Branch, day }, tx)).ToList();
                return new
                {
                    mode = br.Mode, branch = br.Name, branchAr = br.NameAr,
                    preparing = rows.Where(r => r.ReadyAt is null),
                    ready = rows.Where(r => r.ReadyAt is not null).OrderByDescending(r => r.ReadyAt),
                };
            });
        });

        // By hand at the till: ready, collected, or back to preparing (a mistake).
        api.MapPut("/orders/{id:guid}/pickup", async (Guid id, StateBody body, HttpContext http, Db db, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            if (!scope.Can("pos.sell")) scope.Require("kitchen.view");
            var state = (body.State ?? "").Trim().ToLowerInvariant();
            if (state is not ("preparing" or "ready" or "collected")) throw new DomainException("Preparing, ready or collected.");
            var branchId = await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var o = await c.QuerySingleOrDefaultAsync<(Guid BranchId, string Type, string Status)>("select branch_id, order_type, status from pos_order where id = @id for update", new { id }, tx);
                if (o.BranchId == Guid.Empty) throw new NotFoundException("Order not found.");
                if (o.Type == "dine_in") throw new DomainException("Dine-in orders are served at the table, not collected.");
                if (o.Status == "void") throw new DomainException("This order was voided.");
                await c.ExecuteAsync("""
                    update pos_order set
                      ready_at = case when @state = 'preparing' then null else coalesce(ready_at, now()) end,
                      collected_at = case when @state = 'collected' then now() else null end
                    where id = @id
                    """, new { id, state }, tx);
                return o.BranchId;
            });
            await live.ToBranch(branchId, "pickup.changed", new { id, state });
            await live.ToBranch(branchId, "order.changed", new { id });
            return Results.Ok(new { id, state });
        });
    }
}
