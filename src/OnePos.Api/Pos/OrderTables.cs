using Dapper;
using Npgsql;
using OnePos.Api.Data;
using OnePos.Api.Platform;

namespace OnePos.Api.Pos;

/// <summary>
/// Dine-in operations on orders (REQ TBL-05, TBL-06, TBL-08, PAY-02): seat at tables, move, join tables, merge two orders, split by
/// item (to another table or a separate bill), bill printed, and the edit lock ("Open on Till 1 · Sara", take over).
/// </summary>
public static class OrderTables
{
    public sealed record LockBody(bool? TakeOver);
    public sealed record TablesBody(Guid[] TableIds);
    public sealed record MergeBody(Guid FromOrderId);
    public sealed record SplitLine(Guid LineId, decimal Qty);
    public sealed record SplitBody(SplitLine[] Lines, Guid? TableId);

    public const string SessionHeader = "X-Device-Session";

    /// <summary>This browser tab (sent by the web app); a back-office call without one counts as the user.</summary>
    public static string Session(HttpContext http, Scope scope)
    {
        var s = http.Request.Headers[SessionHeader].ToString();
        return s.Length is >= 8 and <= 64 ? s : $"user:{scope.UserId:N}";
    }

    /// <summary>Takes (or refreshes) the edit lock for this device; refused while another device holds a fresh one, unless taking over.</summary>
    public static async Task LockAsync(NpgsqlConnection c, NpgsqlTransaction tx, HttpContext http, Scope scope, Guid id, Orders.OrderRow? o = null, bool takeOver = false)
    {
        o ??= await c.QuerySingleAsync<Orders.OrderRow>("select * from pos_order where id = @id", new { id }, tx);
        var session = Session(http, scope);
        var held = o.LockSession is not null && o.LockSession != session && o.LockAt > DateTime.UtcNow.AddSeconds(-90);
        if (held && !takeOver) throw new ConflictException($"Order #{o.Number} is open on {o.LockLabel}. Take it over to change it here.");
        var label = await c.ExecuteScalarAsync<string>("""
            select coalesce((select name from register where id = @reg), 'Back office') || ' · ' || (select display_name from app_user where id = @user)
            """, new { reg = scope.RegisterId, user = scope.UserId }, tx);
        await c.ExecuteAsync("update pos_order set lock_session = @session, lock_user = @user, lock_label = @label, lock_at = now() where id = @id",
            new { id, session, user = scope.UserId, label }, tx);
        if (held) await Audit.RecordAsync(c, tx, o.CompanyId, o.BranchId, scope.UserId, "order", id.ToString(), "taken_over", $"Order #{o.Number} taken over from {o.LockLabel}");
    }

    /// <summary>Puts an order on tables (the first is the main one); the tables must be free. Clears their reservation.</summary>
    public static async Task SeatAsync(NpgsqlConnection c, NpgsqlTransaction tx, Guid companyId, Guid branchId, Guid orderId, Guid[] tableIds)
    {
        var ids = tableIds.Distinct().ToArray();
        if (ids.Length == 0) throw new DomainException("Choose a table.");
        var tables = (await c.QueryAsync<(Guid Id, string Name)>("select id, name from dining_table where id = any(@ids) and branch_id = @branchId and is_active", new { ids, branchId }, tx)).ToList();
        if (tables.Count != ids.Length) throw new DomainException("A chosen table isn't on this branch's floor.");
        var taken = await c.ExecuteScalarAsync<string?>("""
            select t.name from order_table ot join dining_table t on t.id = ot.table_id where ot.table_id = any(@ids) and ot.order_id <> @orderId limit 1
            """, new { ids, orderId }, tx);
        if (taken is not null) throw new ConflictException($"Table {taken} already has an open order.");
        await c.ExecuteAsync("delete from order_table where order_id = @orderId", new { orderId }, tx);
        for (var i = 0; i < ids.Length; i++)
            await c.ExecuteAsync("insert into order_table (company_id, order_id, table_id, is_primary) values (@companyId, @orderId, @t, @primary)",
                new { companyId, orderId, t = ids[i], primary = i == 0 }, tx);
        await c.ExecuteAsync("update dining_table set reserved = false where id = any(@ids)", new { ids }, tx);
        var label = string.Join(" + ", ids.Select(x => tables.First(t => t.Id == x).Name));
        await c.ExecuteAsync("update pos_order set table_label = @label, order_type = 'dine_in' where id = @orderId", new { orderId, label }, tx);
    }

    /// <summary>Frees the order's tables (paid, voided, merged).</summary>
    public static Task ReleaseAsync(NpgsqlConnection c, NpgsqlTransaction tx, Guid orderId) =>
        c.ExecuteAsync("delete from order_table where order_id = @orderId", new { orderId }, tx);

    public static void Map(RouteGroupBuilder api)
    {
        // Open the order on this device, keep it (a heartbeat every 30 s), or take it over from another device.
        api.MapPost("/orders/{id:guid}/lock", async (Guid id, LockBody body, HttpContext http, Db db, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("pos.sell");
            await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var o = await c.QuerySingleOrDefaultAsync<Orders.OrderRow>("select * from pos_order where id = @id and branch_id = @b for update", new { id, b = scope.Branch }, tx)
                        ?? throw new NotFoundException("Order not found.");
                if (o.Status == "open") await LockAsync(c, tx, http, scope, id, o, body.TakeOver == true);
                return 0;
            });
            if (body.TakeOver == true) await live.ToBranch(scope.Branch, "order.changed", new { id });
            return Results.Ok(new { ok = true });
        });

        // Leaving the order on this device lets others edit it at once.
        api.MapDelete("/orders/{id:guid}/lock", async (Guid id, HttpContext http, Db db) =>
        {
            var scope = await http.ScopeAsync(db);
            await db.Company(scope.CompanyId, (c, tx) => c.ExecuteAsync(
                "update pos_order set lock_session = null, lock_at = null where id = @id and lock_session = @s", new { id, s = Session(http, scope) }, tx));
            return Results.Ok(new { ok = true });
        });

        // Move to other tables, or join more tables to the order (the first is the main table).
        api.MapPut("/orders/{id:guid}/tables", (Guid id, TablesBody body, HttpContext http, Db db, Live live) => Orders.Mutate(http, db, live, id, "tables.serve", async (c, tx, o, scope) =>
        {
            if (!await c.ExecuteScalarAsync<bool>("select table_service from branch where id = @b", new { b = o.BranchId }, tx))
                throw new DomainException("This branch has no table service.");
            await SeatAsync(c, tx, o.CompanyId, o.BranchId, id, body.TableIds ?? []);
            await Audit.RecordAsync(c, tx, o.CompanyId, o.BranchId, scope.UserId, "order", id.ToString(), "tables", $"Order #{o.Number} tables changed",
                [new("Tables", o.TableLabel, await c.ExecuteScalarAsync<string>("select table_label from pos_order where id = @id", new { id }, tx))]);
        }));

        // Merge another open order (e.g. two tables that joined) into this one: its lines, tables and guests come over.
        api.MapPost("/orders/{id:guid}/merge", (Guid id, MergeBody body, HttpContext http, Db db, Live live) => Orders.Mutate(http, db, live, id, "tables.serve", async (c, tx, o, scope) =>
        {
            if (body.FromOrderId == id) throw new DomainException("Choose another order to merge.");
            var from = await c.QuerySingleOrDefaultAsync<Orders.OrderRow>("select * from pos_order where id = @f for update", new { f = body.FromOrderId }, tx)
                       ?? throw new NotFoundException("That order no longer exists.");
            if (from.BranchId != o.BranchId || from.Status != "open") throw new DomainException($"Order #{from.Number} isn't open here.");
            if (from.Paid > 0) throw new DomainException($"Order #{from.Number} has payments; it can't be merged.");
            await LockAsync(c, tx, http, scope, from.Id, from);
            var offset = await c.ExecuteScalarAsync<int>("select coalesce(max(sort), 0) from order_line where order_id = @id", new { id }, tx);
            await c.ExecuteAsync("update order_line set order_id = @id, sort = sort + @offset where order_id = @f", new { id, f = from.Id, offset }, tx);
            await c.ExecuteAsync("update order_table set order_id = @id, is_primary = false where order_id = @f", new { id, f = from.Id }, tx);
            await c.ExecuteAsync("""
                update pos_order set guests = nullif(coalesce(guests, 0) + coalesce(@g, 0), 0),
                  table_label = (select string_agg(t.name, ' + ' order by ot.is_primary desc, t.name) from order_table ot join dining_table t on t.id = ot.table_id where ot.order_id = @id)
                where id = @id
                """, new { id, g = from.Guests }, tx);
            await c.ExecuteAsync("update pos_order set status = 'merged', closed_at = now(), void_reason = @note, lock_session = null where id = @f",
                new { f = from.Id, note = $"Merged into #{o.Number}" }, tx);
            await Orders.RecalcAsync(c, tx, from.Id);
            await Audit.RecordAsync(c, tx, o.CompanyId, o.BranchId, scope.UserId, "order", id.ToString(), "merged", $"Order #{from.Number} merged into #{o.Number}");
        }));

        api.MapPost("/orders/{id:guid}/bill", (Guid id, HttpContext http, Db db, Live live) => Orders.Mutate(http, db, live, id, "pos.sell", async (c, tx, o, scope) =>
        {
            await c.ExecuteAsync("update pos_order set bill_printed_at = now() where id = @id", new { id }, tx);
        }));

        // Split by item (REQ PAY-02, TBL-06): the chosen quantities move to a new order — on another table, or a separate bill for the same table.
        api.MapPost("/orders/{id:guid}/split", async (Guid id, SplitBody body, HttpContext http, Db db, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("pos.sell");
            var branchId = scope.Branch;
            var result = await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var o = await c.QuerySingleOrDefaultAsync<Orders.OrderRow>("select * from pos_order where id = @id for update", new { id }, tx) ?? throw new NotFoundException("Order not found.");
                if (o.BranchId != branchId || o.Status != "open") throw new ConflictException($"Order #{o.Number} isn't open here.");
                if (o.Paid > 0) throw new DomainException("Split before taking payments (this order has some).");
                await LockAsync(c, tx, http, scope, id, o);
                var wanted = (body.Lines ?? []).Where(l => l.Qty > 0).ToList();
                if (wanted.Count == 0) throw new DomainException("Choose what goes on the new bill.");
                var lines = (await c.QueryAsync<Orders.LineRow>("select * from order_line where order_id = @id and not is_void", new { id }, tx)).ToDictionary(l => l.Id);
                var moving = wanted.Sum(w => w.Qty);
                if (wanted.Any(w => !lines.TryGetValue(w.LineId, out var l) || w.Qty > l.Qty)) throw new DomainException("A chosen line or quantity isn't on the order any more.");
                if (moving >= lines.Values.Sum(l => l.Qty)) throw new DomainException("Leave at least one item on this order.");
                var number = await c.ExecuteScalarAsync<int>("""
                    insert into number_series (company_id, branch_id, series, next_no) values (@co, @b, @series, 2)
                    on conflict (branch_id, series) do update set next_no = number_series.next_no + 1 returning next_no - 1
                    """, new { co = o.CompanyId, b = branchId, series = $"order:{o.BusinessDate:yyyy-MM-dd}" }, tx);
                var newId = await c.ExecuteScalarAsync<Guid>("""
                    insert into pos_order (company_id, branch_id, register_id, business_date, number, order_type, table_label, customer_name, customer_phone, delivery_address,
                                           vat_rate, prices_include_vat, service_pct, opened_by, split_from)
                    select company_id, branch_id, @reg, business_date, @number, order_type, case when @tableId is null then table_label || ' · split' end, customer_name, customer_phone,
                           delivery_address, vat_rate, prices_include_vat, service_pct, @user, id
                    from pos_order where id = @id returning id
                    """, new { id, number, reg = scope.RegisterId ?? o.RegisterId, user = scope.UserId, tableId = body.TableId }, tx);
                foreach (var w in wanted)
                {
                    var l = lines[w.LineId];
                    if (w.Qty == l.Qty)
                        await c.ExecuteAsync("update order_line set order_id = @newId where id = @lid", new { newId, lid = l.Id }, tx);
                    else
                    {
                        var sentMoving = Math.Min(l.SentQty, w.Qty);
                        await c.ExecuteAsync("update order_line set qty = qty - @q, sent_qty = sent_qty - @s where id = @lid", new { q = w.Qty, s = sentMoving, lid = l.Id }, tx);
                        await c.ExecuteAsync("""
                            insert into order_line (company_id, order_id, item_id, name, name_ar, unit_price, qty, modifiers, note, station, sent_qty, sort, added_by)
                            select company_id, @newId, item_id, name, name_ar, unit_price, @q, modifiers, note, station, @s, sort, added_by from order_line where id = @lid
                            """, new { newId, q = w.Qty, s = sentMoving, lid = l.Id }, tx);
                    }
                }
                if (body.TableId is { } t) await SeatAsync(c, tx, o.CompanyId, branchId, newId, [t]);
                await Orders.RecalcAsync(c, tx, id);
                await Orders.RecalcAsync(c, tx, newId);
                await Audit.RecordAsync(c, tx, o.CompanyId, branchId, scope.UserId, "order", id.ToString(), "split", $"Order #{o.Number}: {moving} item(s) split to #{number}");
                return new { source = await Orders.DetailAsync(c, tx, id), created = await Orders.DetailAsync(c, tx, newId) };
            });
            await live.ToBranch(branchId, "order.changed", new { id });
            await live.ToBranch(branchId, "floor.changed");
            return Results.Ok(result);
        });
    }
}
