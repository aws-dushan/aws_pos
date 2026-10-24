using Dapper;
using Npgsql;
using OnePos.Api.Data;
using OnePos.Api.Platform;

namespace OnePos.Api.Pos;

/// <summary>
/// Table reservations (REQ TBL-07). A booking holds tables for a time window (no table is booked twice at once); the floor shows
/// a table's booking in the two hours before it; seating the booking opens the dine-in order on its tables with the customer.
/// A known customer is found by phone; the booking keeps the name and phone as given.
/// </summary>
public static class Reservations
{
    public sealed record Body(string Name, string? Phone, int Guests, DateTime StartsAt, int? DurationMin, Guid[]? TableIds, string? Note);
    public sealed record StatusBody(string Status);

    public sealed class Row
    {
        public Guid Id { get; set; }
        public Guid? CustomerId { get; set; }
        public string Name { get; set; } = "";
        public string? Phone { get; set; }
        public int Guests { get; set; }
        public DateTime StartsAt { get; set; }
        public DateTime EndsAt { get; set; }
        public string Status { get; set; } = "";
        public string? Note { get; set; }
        public Guid? OrderId { get; set; }
        public string? CreatedByName { get; set; }
        public Guid[] TableIds { get; set; } = [];
        public string? TableNames { get; set; }
        public int? CustomerVisits { get; set; }
    }

    private const string RowSql = """
        select r.*, u.display_name as created_by_name,
               coalesce(array(select rt.table_id from reservation_table rt where rt.reservation_id = r.id), '{}') as table_ids,
               (select string_agg(t.name, ' + ' order by t.name) from reservation_table rt join dining_table t on t.id = rt.table_id where rt.reservation_id = r.id) as table_names,
               (select count(*)::int from pos_order o where o.customer_id = r.customer_id and o.status in ('paid','refunded')) as customer_visits
        from reservation r join app_user u on u.id = r.created_by
        """;

    /// <summary>Checks and saves a booking's details and tables: free in that window, on this branch.</summary>
    private static async Task SaveAsync(NpgsqlConnection c, NpgsqlTransaction tx, Scope scope, Guid id, Body b, bool isNew)
    {
        var branchId = scope.Branch;
        if (!await c.ExecuteScalarAsync<bool>("select table_service from branch where id = @branchId", new { branchId }, tx))
            throw new DomainException("This branch has no table service, so no table bookings.");
        if (string.IsNullOrWhiteSpace(b.Name)) throw new DomainException("Enter the name the table is booked under.");
        if (b.Guests is < 1 or > 200) throw new DomainException("Guests are 1 to 200.");
        var minutes = b.DurationMin ?? 90;
        if (minutes is < 15 or > 600) throw new DomainException("A booking lasts 15 minutes to 10 hours.");
        var start = b.StartsAt.ToUniversalTime();
        if (isNew && start < DateTime.UtcNow.AddMinutes(-30)) throw new DomainException("That time has passed.");
        if (start > DateTime.UtcNow.AddDays(366)) throw new DomainException("Bookings are taken up to a year ahead.");
        var end = start.AddMinutes(minutes);
        var tables = (b.TableIds ?? []).Distinct().ToArray();
        if (tables.Length > 0)
        {
            var found = await c.ExecuteScalarAsync<int>("select count(*) from dining_table where id = any(@tables) and branch_id = @branchId and is_active", new { tables, branchId }, tx);
            if (found != tables.Length) throw new DomainException("A chosen table isn't on this branch's floor.");
            var clash = await c.QuerySingleOrDefaultAsync<(string Table, string Name, DateTime At)>("""
                select t.name, r.name, r.starts_at from reservation r join reservation_table rt on rt.reservation_id = r.id join dining_table t on t.id = rt.table_id
                where rt.table_id = any(@tables) and r.id <> @id and r.status in ('booked','seated') and tstzrange(r.starts_at, r.ends_at) && tstzrange(@start, @end)
                order by r.starts_at limit 1
                """, new { tables, id, start, end }, tx);
            if (clash.Table is not null) throw new ConflictException($"Table {clash.Table} is booked for {clash.Name} then. Choose another table or time.");
        }
        var key = Customers.PhoneKey(b.Phone);
        var customerId = key is null ? null : await c.ExecuteScalarAsync<Guid?>("select id from customer where phone_key = @key", new { key }, tx);
        var note = string.IsNullOrWhiteSpace(b.Note) ? null : b.Note.Trim();
        var phone = string.IsNullOrWhiteSpace(b.Phone) ? null : b.Phone.Trim();
        if (isNew)
            await c.ExecuteAsync("""
                insert into reservation (id, company_id, branch_id, customer_id, name, phone, guests, starts_at, ends_at, note, created_by)
                values (@id, @co, @branchId, @customerId, @name, @phone, @Guests, @start, @end, @note, @u)
                """, new { id, co = scope.CompanyId, branchId, customerId, name = b.Name.Trim(), phone, b.Guests, start, end, note, u = scope.UserId }, tx);
        else
            await c.ExecuteAsync("""
                update reservation set customer_id = @customerId, name = @name, phone = @phone, guests = @Guests, starts_at = @start, ends_at = @end, note = @note where id = @id
                """, new { id, customerId, name = b.Name.Trim(), phone, b.Guests, start, end, note }, tx);
        await c.ExecuteAsync("delete from reservation_table where reservation_id = @id", new { id }, tx);
        foreach (var t in tables)
            await c.ExecuteAsync("insert into reservation_table (company_id, reservation_id, table_id) values (@co, @id, @t)", new { co = scope.CompanyId, id, t }, tx);
    }

    public static void Map(RouteGroupBuilder api)
    {
        // A day's bookings at this branch (the branch's local day), earliest first.
        api.MapGet("/reservations", async (HttpContext http, Db db, DateOnly? date) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("pos.sell");
            return await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var tz = await c.ExecuteScalarAsync<string>("select time_zone from branch where id = @b", new { b = scope.Branch }, tx) ?? "Asia/Dubai";
                var zone = BusinessClock.Zone(tz);
                var day = date ?? BusinessClock.Today(tz);
                var from = TimeZoneInfo.ConvertTimeToUtc(day.ToDateTime(TimeOnly.MinValue), zone);
                var rows = await c.QueryAsync<Row>($"{RowSql} where r.branch_id = @b and r.starts_at >= @from and r.starts_at < @to order by r.starts_at, r.name",
                    new { b = scope.Branch, from, to = from.AddDays(1) }, tx);
                return new { date = day, reservations = rows };
            });
        });

        api.MapPost("/reservations", async (Body body, HttpContext http, Db db, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("pos.sell");
            var row = await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var id = Guid.NewGuid();
                await SaveAsync(c, tx, scope, id, body, isNew: true);
                await Audit.RecordAsync(c, tx, scope.CompanyId, scope.Branch, scope.UserId, "reservation", id.ToString(), "created",
                    $"Table booked for {body.Name.Trim()}, {body.Guests} guests, {body.StartsAt.ToUniversalTime():u}");
                return await c.QuerySingleAsync<Row>($"{RowSql} where r.id = @id", new { id }, tx);
            });
            await live.ToBranch(scope.Branch, "floor.changed");
            return Results.Ok(row);
        });

        api.MapPut("/reservations/{id:guid}", async (Guid id, Body body, HttpContext http, Db db, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("pos.sell");
            var row = await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var st = await c.ExecuteScalarAsync<string?>("select status from reservation where id = @id and branch_id = @b for update", new { id, b = scope.Branch }, tx)
                         ?? throw new NotFoundException("Booking not found.");
                if (st != "booked") throw new DomainException("Only a booking not seated yet can be changed.");
                await SaveAsync(c, tx, scope, id, body, isNew: false);
                await Audit.RecordAsync(c, tx, scope.CompanyId, scope.Branch, scope.UserId, "reservation", id.ToString(), "changed", $"Booking for {body.Name.Trim()} changed");
                return await c.QuerySingleAsync<Row>($"{RowSql} where r.id = @id", new { id }, tx);
            });
            await live.ToBranch(scope.Branch, "floor.changed");
            return Results.Ok(row);
        });

        // Cancelled, a no-show, or back to booked (a mistake).
        api.MapPost("/reservations/{id:guid}/status", async (Guid id, StatusBody body, HttpContext http, Db db, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("pos.sell");
            var status = (body.Status ?? "").Trim().ToLowerInvariant();
            if (status is not ("cancelled" or "no_show" or "booked")) throw new DomainException("A booking is cancelled, a no-show, or booked again.");
            var row = await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var r = await c.QuerySingleOrDefaultAsync<Row>($"{RowSql} where r.id = @id and r.branch_id = @b", new { id, b = scope.Branch }, tx) ?? throw new NotFoundException("Booking not found.");
                if (r.Status == "seated") throw new DomainException("This booking is already seated.");
                if (status == "booked" && r.TableIds.Length > 0)
                {
                    var clash = await c.ExecuteScalarAsync<string?>("""
                        select t.name from reservation x join reservation_table rt on rt.reservation_id = x.id join dining_table t on t.id = rt.table_id
                        where rt.table_id = any(@tables) and x.id <> @id and x.status in ('booked','seated') and tstzrange(x.starts_at, x.ends_at) && tstzrange(@s, @e) limit 1
                        """, new { tables = r.TableIds, id, s = r.StartsAt, e = r.EndsAt }, tx);
                    if (clash is not null) throw new ConflictException($"Table {clash} has been booked since. Edit the booking to choose another.");
                }
                await c.ExecuteAsync("update reservation set status = @status where id = @id", new { id, status }, tx);
                await Audit.RecordAsync(c, tx, scope.CompanyId, scope.Branch, scope.UserId, "reservation", id.ToString(), status, $"Booking for {r.Name}: {status.Replace('_', '-')}");
                return await c.QuerySingleAsync<Row>($"{RowSql} where r.id = @id", new { id }, tx);
            });
            await live.ToBranch(scope.Branch, "floor.changed");
            return Results.Ok(row);
        });

        // The guests arrived: open the dine-in order on the booked tables (or the ones chosen now) with the customer, on this device.
        api.MapPost("/reservations/{id:guid}/seat", async (Guid id, Reservations.SeatBody body, HttpContext http, Db db, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("pos.sell");
            var detail = await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var r = await c.QuerySingleOrDefaultAsync<Row>($"{RowSql} where r.id = @id and r.branch_id = @b for update of r", new { id, b = scope.Branch }, tx) ?? throw new NotFoundException("Booking not found.");
                if (r.Status != "booked") throw new DomainException(r.Status == "seated" ? "This booking is already seated." : "This booking was cancelled or marked as a no-show.");
                var tables = body.TableIds is { Length: > 0 } chosen ? chosen : r.TableIds;
                if (tables.Length == 0) throw new DomainException("Choose the table to seat them at.");
                var orderId = await Orders.OpenAsync(c, tx, http, scope, new Orders.OpenBody("dine_in", null, body.Guests ?? r.Guests, r.Name, r.Phone, null, null));
                await OrderTables.SeatAsync(c, tx, scope.CompanyId, scope.Branch, orderId, tables);
                if (r.CustomerId is { } cid) await c.ExecuteAsync("update pos_order set customer_id = @cid where id = @orderId", new { cid, orderId }, tx);
                await c.ExecuteAsync("update reservation set status = 'seated', order_id = @orderId where id = @id", new { id, orderId }, tx);
                await Audit.RecordAsync(c, tx, scope.CompanyId, scope.Branch, scope.UserId, "reservation", id.ToString(), "seated", $"Booking for {r.Name} seated");
                return await Orders.DetailAsync(c, tx, orderId);
            });
            await live.ToBranch(scope.Branch, "floor.changed");
            await live.ToBranch(scope.Branch, "order.changed", new { id = detail.Order.Id });
            return Results.Ok(detail);
        });
    }

    public sealed record SeatBody(Guid[]? TableIds, int? Guests);
}
