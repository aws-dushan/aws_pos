using Dapper;
using Npgsql;
using OnePos.Api.Data;
using OnePos.Api.Platform;

namespace OnePos.Api.Pos;

/// <summary>
/// Floors and tables of a branch (REQ TBL-01 … TBL-04): the floor-plan designer (tables.manage) and the live floor every till sees
/// (who is seated, for how long, the running total, bill printed, reserved). Tables sit on a grid of Cols × Rows cells.
/// </summary>
public static class Tables
{
    public const int Cols = 24, Rows = 14;

    public sealed record FloorBody(string Name, int? Sort);
    public sealed record TableBody(Guid FloorId, string Name, int Seats, string Shape, int X, int Y, int W, int H, bool? IsActive);
    public sealed record ReservedBody(bool Reserved);

    public sealed class FloorRow { public Guid Id { get; set; } public string Name { get; set; } = ""; public int Sort { get; set; } }

    public sealed class TableRow
    {
        public Guid Id { get; set; }
        public Guid FloorId { get; set; }
        public string Name { get; set; } = "";
        public int Seats { get; set; }
        public string Shape { get; set; } = "";
        public int X { get; set; }
        public int Y { get; set; }
        public int W { get; set; }
        public int H { get; set; }
        public bool Reserved { get; set; }
        public bool IsActive { get; set; }
        // The open order on it, if any.
        public Guid? OrderId { get; set; }
        public int? OrderNumber { get; set; }
        public int? Guests { get; set; }
        public decimal? Total { get; set; }
        public DateTime? OpenedAt { get; set; }
        public DateTime? BillPrintedAt { get; set; }
        public string? LockLabel { get; set; }
        public int? Items { get; set; }
        // The next booking within two hours (or running now), shown on the table and offered when seating it.
        public Guid? BookingId { get; set; }
        public string? BookingName { get; set; }
        public DateTime? BookingAt { get; set; }
        public int? BookingGuests { get; set; }
        public string State => OrderId is null ? (Reserved || BookingId is not null ? "reserved" : "free") : BillPrintedAt is null ? "seated" : "bill";
    }

    private static readonly string[] Shapes = ["round", "square", "rect"];

    public static void Map(RouteGroupBuilder api)
    {
        // The live floor: every floor and table of the branch with what is on each table now.
        api.MapGet("/floor", async (HttpContext http, Db db) =>
        {
            var scope = await http.ScopeAsync(db);
            var branchId = scope.Branch;
            return await db.Company(scope.CompanyId, async (c, tx) => new
            {
                cols = Cols, rows = Rows,
                floors = (await c.QueryAsync<FloorRow>("select id, name, sort from floor where branch_id = @branchId order by sort, name", new { branchId }, tx)).ToList(),
                tables = (await c.QueryAsync<TableRow>("""
                    select t.*, o.id as order_id, o.number as order_number, o.guests, o.total, o.opened_at, o.bill_printed_at,
                           case when o.lock_at > now() - interval '90 seconds' then o.lock_label end as lock_label,
                           (select coalesce(sum(qty), 0) from order_line l where l.order_id = o.id and not l.is_void)::int as items,
                           bk.id as booking_id, bk.name as booking_name, bk.starts_at as booking_at, bk.guests as booking_guests
                    from dining_table t
                    left join lateral (
                      select r.id, r.name, r.starts_at, r.guests from reservation r join reservation_table rt on rt.reservation_id = r.id
                      where rt.table_id = t.id and r.status = 'booked' and r.ends_at > now() and r.starts_at < now() + interval '2 hours'
                      order by r.starts_at limit 1) bk on true
                    left join order_table ot on ot.table_id = t.id
                    left join pos_order o on o.id = ot.order_id and o.status = 'open'
                    where t.branch_id = @branchId and t.is_active
                    order by t.name
                    """, new { branchId }, tx)).ToList(),
            });
        });

        api.MapPost("/floors", async (FloorBody body, HttpContext http, Db db, Live live) =>
        {
            var scope = await ManageAsync(http, db);
            if (string.IsNullOrWhiteSpace(body.Name)) throw new DomainException("Enter the floor's name (e.g. Main hall, Terrace).");
            var id = await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var sort = body.Sort ?? await c.ExecuteScalarAsync<int>("select coalesce(max(sort), 0) + 1 from floor where branch_id = @b", new { b = scope.Branch }, tx);
                var id = await c.ExecuteScalarAsync<Guid>("insert into floor (company_id, branch_id, name, sort) values (@co, @b, @name, @sort) returning id",
                    new { co = scope.CompanyId, b = scope.Branch, name = body.Name.Trim(), sort }, tx);
                await Audit.RecordAsync(c, tx, scope.CompanyId, scope.Branch, scope.UserId, "floor", id.ToString(), "created", $"Floor {body.Name.Trim()} created");
                return id;
            });
            await live.ToBranch(scope.Branch, "floor.changed");
            return Results.Ok(new { id });
        });

        api.MapPut("/floors/{id:guid}", async (Guid id, FloorBody body, HttpContext http, Db db, Live live) =>
        {
            var scope = await ManageAsync(http, db);
            if (string.IsNullOrWhiteSpace(body.Name)) throw new DomainException("Enter the floor's name.");
            await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var old = await c.QuerySingleOrDefaultAsync<FloorRow>("select id, name, sort from floor where id = @id and branch_id = @b", new { id, b = scope.Branch }, tx)
                          ?? throw new NotFoundException("Floor not found.");
                await c.ExecuteAsync("update floor set name = @name, sort = @sort where id = @id", new { id, name = body.Name.Trim(), sort = body.Sort ?? old.Sort }, tx);
                await Audit.RecordAsync(c, tx, scope.CompanyId, scope.Branch, scope.UserId, "floor", id.ToString(), "changed", $"Floor {old.Name} changed", [new("Name", old.Name, body.Name.Trim())]);
                return 0;
            });
            await live.ToBranch(scope.Branch, "floor.changed");
            return Results.Ok(new { id });
        });

        api.MapDelete("/floors/{id:guid}", async (Guid id, HttpContext http, Db db, Live live) =>
        {
            var scope = await ManageAsync(http, db);
            await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var name = await c.ExecuteScalarAsync<string?>("select name from floor where id = @id and branch_id = @b", new { id, b = scope.Branch }, tx) ?? throw new NotFoundException("Floor not found.");
                var busy = await c.ExecuteScalarAsync<string?>("select t.name from dining_table t join order_table ot on ot.table_id = t.id where t.floor_id = @id limit 1", new { id }, tx);
                if (busy is not null) throw new DomainException($"Table {busy} on this floor has an open order.");
                if (await c.ExecuteScalarAsync<int>("select count(*) from floor where branch_id = @b", new { b = scope.Branch }, tx) == 1)
                    throw new DomainException("Keep at least one floor while table service is on.");
                // Tables with history are switched off, not deleted (old orders still name them).
                await c.ExecuteAsync("update dining_table set is_active = false, name = name || ' (removed ' || left(id::text, 4) || ')' where floor_id = @id", new { id }, tx);
                await c.ExecuteAsync("delete from dining_table t where t.floor_id = @id and not exists (select 1 from order_table ot where ot.table_id = t.id)", new { id }, tx);
                if (!await c.ExecuteScalarAsync<bool>("select exists (select 1 from dining_table where floor_id = @id)", new { id }, tx))
                    await c.ExecuteAsync("delete from floor where id = @id", new { id }, tx);
                await Audit.RecordAsync(c, tx, scope.CompanyId, scope.Branch, scope.UserId, "floor", id.ToString(), "removed", $"Floor {name} removed");
                return 0;
            });
            await live.ToBranch(scope.Branch, "floor.changed");
            return Results.Ok(new { id });
        });

        api.MapPost("/tables", async (TableBody body, HttpContext http, Db db, Live live) =>
        {
            var scope = await ManageAsync(http, db);
            var b = Clean(body);
            var id = await db.Company(scope.CompanyId, async (c, tx) =>
            {
                await CheckPlaceAsync(c, tx, scope.Branch, null, b);
                var id = await c.ExecuteScalarAsync<Guid>("""
                    insert into dining_table (company_id, branch_id, floor_id, name, seats, shape, x, y, w, h)
                    values (@co, @br, @FloorId, @Name, @Seats, @Shape, @X, @Y, @W, @H) returning id
                    """, new { co = scope.CompanyId, br = scope.Branch, b.FloorId, b.Name, b.Seats, b.Shape, b.X, b.Y, b.W, b.H }, tx);
                await Audit.RecordAsync(c, tx, scope.CompanyId, scope.Branch, scope.UserId, "table", id.ToString(), "created", $"Table {b.Name} created", Audit.Created(("Seats", b.Seats), ("Shape", b.Shape)));
                return id;
            });
            await live.ToBranch(scope.Branch, "floor.changed");
            return Results.Ok(new { id });
        });

        api.MapPut("/tables/{id:guid}", async (Guid id, TableBody body, HttpContext http, Db db, Live live) =>
        {
            var scope = await ManageAsync(http, db);
            var b = Clean(body);
            await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var old = await c.QuerySingleOrDefaultAsync<TableRow>("select * from dining_table where id = @id and branch_id = @br for update", new { id, br = scope.Branch }, tx)
                          ?? throw new NotFoundException("Table not found.");
                await CheckPlaceAsync(c, tx, scope.Branch, id, b);
                await c.ExecuteAsync("update dining_table set floor_id = @FloorId, name = @Name, seats = @Seats, shape = @Shape, x = @X, y = @Y, w = @W, h = @H, is_active = @act where id = @id",
                    new { id, b.FloorId, b.Name, b.Seats, b.Shape, b.X, b.Y, b.W, b.H, act = body.IsActive ?? true }, tx);
                if (old.Name != b.Name || old.Seats != b.Seats || old.Shape != b.Shape || old.FloorId != b.FloorId)
                    await Audit.RecordAsync(c, tx, scope.CompanyId, scope.Branch, scope.UserId, "table", id.ToString(), "changed", $"Table {old.Name} changed",
                        [new("Name", old.Name, b.Name), new("Seats", old.Seats, b.Seats), new("Shape", old.Shape, b.Shape), new("Floor", old.FloorId, b.FloorId)]);
                return 0;
            });
            await live.ToBranch(scope.Branch, "floor.changed");
            return Results.Ok(new { id });
        });

        api.MapDelete("/tables/{id:guid}", async (Guid id, HttpContext http, Db db, Live live) =>
        {
            var scope = await ManageAsync(http, db);
            await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var name = await c.ExecuteScalarAsync<string?>("select name from dining_table where id = @id and branch_id = @br", new { id, br = scope.Branch }, tx)
                           ?? throw new NotFoundException("Table not found.");
                if (await c.ExecuteScalarAsync<bool>("select exists (select 1 from order_table where table_id = @id)", new { id }, tx))
                    throw new DomainException("This table has an open order. Pay or move it first.");
                if (await c.ExecuteScalarAsync<bool>("select exists (select 1 from pos_order where table_label = @name and branch_id = @br)", new { name, br = scope.Branch }, tx))
                    await c.ExecuteAsync("update dining_table set is_active = false, name = name || ' (removed ' || left(id::text, 4) || ')' where id = @id", new { id }, tx);
                else
                    await c.ExecuteAsync("delete from dining_table where id = @id", new { id }, tx);
                await Audit.RecordAsync(c, tx, scope.CompanyId, scope.Branch, scope.UserId, "table", id.ToString(), "removed", $"Table {name} removed");
                return 0;
            });
            await live.ToBranch(scope.Branch, "floor.changed");
            return Results.Ok(new { id });
        });

        // Hold or release a table for a reservation (any till: pos.sell).
        api.MapPut("/tables/{id:guid}/reserved", async (Guid id, ReservedBody body, HttpContext http, Db db, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("pos.sell");
            await db.Company(scope.CompanyId, async (c, tx) =>
            {
                if (await c.ExecuteAsync("update dining_table set reserved = @r where id = @id and branch_id = @br", new { id, r = body.Reserved, br = scope.Branch }, tx) == 0)
                    throw new NotFoundException("Table not found.");
                return 0;
            });
            await live.ToBranch(scope.Branch, "floor.changed");
            return Results.Ok(new { id });
        });
    }

    private static async Task<Scope> ManageAsync(HttpContext http, Db db)
    {
        var scope = await http.ScopeAsync(db);
        scope.Require("tables.manage");
        _ = scope.Branch;
        return scope;
    }

    private static TableBody Clean(TableBody b)
    {
        if (string.IsNullOrWhiteSpace(b.Name)) throw new DomainException("A table needs a name (e.g. T1).");
        var shape = (b.Shape ?? "square").Trim().ToLowerInvariant();
        if (!Shapes.Contains(shape)) throw new DomainException("The shape is round, square or long.");
        if (b.Seats is < 1 or > 40) throw new DomainException("Seats are 1 to 40.");
        if (b.W < 1 || b.H < 1 || b.X < 0 || b.Y < 0 || b.X + b.W > Cols || b.Y + b.H > Rows) throw new DomainException("The table must stay inside the floor plan.");
        return b with { Name = b.Name.Trim().ToUpperInvariant(), Shape = shape };
    }

    /// <summary>The table's floor is in this branch and it doesn't overlap another table there.</summary>
    private static async Task CheckPlaceAsync(NpgsqlConnection c, NpgsqlTransaction tx, Guid branchId, Guid? id, TableBody b)
    {
        if (!await c.ExecuteScalarAsync<bool>("select exists (select 1 from floor where id = @FloorId and branch_id = @branchId)", new { b.FloorId, branchId }, tx))
            throw new DomainException("Choose a floor of this branch.");
        var clash = await c.ExecuteScalarAsync<string?>("""
            select name from dining_table where floor_id = @FloorId and is_active and (@id is null or id <> @id)
              and x < @X + @W and @X < x + w and y < @Y + @H and @Y < y + h limit 1
            """, new { b.FloorId, id, b.X, b.Y, b.W, b.H }, tx);
        if (clash is not null) throw new DomainException($"There's no room there: it would overlap table {clash}.");
    }
}
