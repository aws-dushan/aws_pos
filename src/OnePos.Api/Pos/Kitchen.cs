using System.Text.Json;
using Dapper;
using Npgsql;
using OnePos.Api.Data;
using OnePos.Api.Platform;

namespace OnePos.Api.Pos;

/// <summary>
/// The kitchen (REQ KIT-01 … KIT-05). "Send" turns an order's new quantities into tickets, one per station (a combo's components go
/// to their own stations; ready-to-sell items make none). Voiding sent items sends a cancel ticket. The kitchen display moves tickets
/// New → Preparing → Ready → Served; tills see each order's kitchen status; one till prints each ticket on its station's printer.
/// </summary>
public static class Kitchen
{
    public sealed record StatusBody(string Status);
    public sealed record StationBody(string Kind, string Name, string? PrinterName);

    public sealed class TicketRow
    {
        public Guid Id { get; set; }
        public Guid OrderId { get; set; }
        public int OrderNumber { get; set; }
        public string Label { get; set; } = "";
        public string OrderType { get; set; } = "";
        public string Station { get; set; } = "";
        public bool IsCancel { get; set; }
        public string Status { get; set; } = "";
        public DateTime CreatedAt { get; set; }
        public DateTime? StartedAt { get; set; }
        public DateTime? ReadyAt { get; set; }
        public DateTime? ServedAt { get; set; }
        public DateTime? PrintedAt { get; set; }
        public string? SentByName { get; set; }
        public List<TicketLine> Lines { get; set; } = [];
    }

    public sealed class TicketLine
    {
        public Guid TicketId { get; set; }
        public decimal Qty { get; set; }
        public string Name { get; set; } = "";
        public string? Extras { get; set; }
        public string? Note { get; set; }
    }

    private sealed record Part(string Station, decimal Qty, string Name, string? Extras, string? Note);
    private sealed class Mod { public string? Name { get; set; } public Guid? ItemId { get; set; } public string? Station { get; set; } }
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private static readonly string[] Stations = ["kitchen", "bar"];
    private static readonly string[] Statuses = ["new", "preparing", "ready", "served"];

    /// <summary>What making `qty` of a line means for the stations: the item itself, or a combo's components at their stations.</summary>
    private static IEnumerable<Part> Parts(Orders.LineRow l, decimal qty)
    {
        var mods = JsonSerializer.Deserialize<List<Mod>>(l.Modifiers, Json) ?? [];
        var components = mods.Where(m => m.ItemId is not null).ToList();
        var extras = string.Join(", ", mods.Where(m => m.ItemId is null).Select(m => m.Name));
        if (components.Count > 0)
        {
            foreach (var m in components.Where(m => Stations.Contains(m.Station)))
                yield return new Part(m.Station!, qty, m.Name ?? "", $"{l.Name}{(extras.Length > 0 ? $" · {extras}" : "")}", l.Note);
            if (Stations.Contains(l.Station)) yield return new Part(l.Station, qty, l.Name, extras.Length > 0 ? extras : null, l.Note);
        }
        else if (Stations.Contains(l.Station))
            yield return new Part(l.Station, qty, l.Name, extras.Length > 0 ? extras : null, l.Note);
    }

    private static async Task<string> LabelAsync(NpgsqlConnection c, NpgsqlTransaction tx, Orders.OrderRow o) =>
        o.OrderType == "dine_in"
            ? $"Table {await c.ExecuteScalarAsync<string?>("select table_label from pos_order where id = @id", new { o.Id }, tx) ?? "?"}"
            : o.PlatformId is not null
                ? $"{await c.ExecuteScalarAsync<string>("select name from delivery_platform where id = @PlatformId", new { o.PlatformId }, tx)} #{o.PlatformRef}"
                : $"{(o.OrderType == "delivery" ? "Delivery" : "Takeaway")}{(o.CustomerName is { Length: > 0 } n ? $" · {n}" : "")}";

    /// <summary>Whether the branch runs a kitchen. Off (a café or counter): no tickets at all, orders are made where they're paid.</summary>
    public static Task<bool> EnabledAsync(NpgsqlConnection c, NpgsqlTransaction tx, Guid branchId) =>
        c.ExecuteScalarAsync<bool>("select kitchen_enabled from branch where id = @branchId", new { branchId }, tx);

    private static async Task<int> WriteTicketsAsync(NpgsqlConnection c, NpgsqlTransaction tx, Orders.OrderRow o, Guid userId, List<Part> parts, bool cancel)
    {
        if (!await EnabledAsync(c, tx, o.BranchId)) return 0;
        var label = await LabelAsync(c, tx, o);
        var made = 0;
        foreach (var g in parts.GroupBy(p => p.Station))
        {
            var ticketId = await c.ExecuteScalarAsync<Guid>("""
                insert into kitchen_ticket (company_id, branch_id, order_id, order_number, label, order_type, station, is_cancel, sent_by)
                values (@co, @b, @o, @n, @label, @type, @station, @cancel, @userId) returning id
                """, new { co = o.CompanyId, b = o.BranchId, o = o.Id, n = o.Number, label, type = o.OrderType, station = g.Key, cancel, userId }, tx);
            var sort = 0;
            foreach (var p in g)
                await c.ExecuteAsync("insert into kitchen_ticket_line (company_id, ticket_id, qty, name, extras, note, sort) values (@co, @t, @Qty, @Name, @Extras, @Note, @s)",
                    new { co = o.CompanyId, t = ticketId, p.Qty, p.Name, p.Extras, p.Note, s = sort++ }, tx);
            made++;
        }
        return made;
    }

    /// <summary>Sends what's new on the order: tickets per station, then marks it sent. Returns the number of items sent.</summary>
    public static async Task<decimal> SendAsync(NpgsqlConnection c, NpgsqlTransaction tx, Orders.OrderRow o, Guid userId)
    {
        var lines = (await c.QueryAsync<Orders.LineRow>("select * from order_line where order_id = @id and not is_void and sent_qty < qty order by sort", new { o.Id }, tx)).ToList();
        var parts = lines.SelectMany(l => Parts(l, l.Qty - l.SentQty)).ToList();
        if (parts.Count > 0) await WriteTicketsAsync(c, tx, o, userId, parts, cancel: false);
        await c.ExecuteAsync("update order_line set sent_qty = qty where order_id = @id and not is_void", new { o.Id }, tx);
        return lines.Sum(l => l.Qty - l.SentQty);
    }

    /// <summary>A cancel ticket for `qty` of a sent line (REQ KIT-05).</summary>
    public static async Task CancelAsync(NpgsqlConnection c, NpgsqlTransaction tx, Orders.OrderRow o, Orders.LineRow l, decimal qty, Guid userId)
    {
        var parts = Parts(l, qty).ToList();
        if (parts.Count > 0 && qty > 0) await WriteTicketsAsync(c, tx, o, userId, parts, cancel: true);
    }

    /// <summary>Cancel tickets for everything sent on a voided order that the kitchen hasn't served.</summary>
    public static async Task CancelOrderAsync(NpgsqlConnection c, NpgsqlTransaction tx, Orders.OrderRow o, Guid userId)
    {
        if (!await c.ExecuteScalarAsync<bool>("select exists (select 1 from kitchen_ticket where order_id = @id and not is_cancel and status <> 'served')", new { o.Id }, tx)) return;
        var lines = (await c.QueryAsync<Orders.LineRow>("select * from order_line where order_id = @id and not is_void and sent_qty > 0", new { o.Id }, tx)).ToList();
        var parts = lines.SelectMany(l => Parts(l, l.SentQty)).ToList();
        if (parts.Count > 0) await WriteTicketsAsync(c, tx, o, userId, parts, cancel: true);
        // The order's own tickets leave the board: the red cancel ticket is what the kitchen acts on.
        await c.ExecuteAsync("update kitchen_ticket set status = 'served', served_at = now() where order_id = @id and not is_cancel and status <> 'served'", new { o.Id }, tx);
    }

    public static async Task<List<TicketRow>> TicketsAsync(NpgsqlConnection c, NpgsqlTransaction tx, string where, object args)
    {
        var tickets = (await c.QueryAsync<TicketRow>($"""
            select t.*, u.display_name as sent_by_name from kitchen_ticket t left join app_user u on u.id = t.sent_by
            where {where} order by t.created_at
            """, args, tx)).ToList();
        var ids = tickets.Select(t => t.Id).ToArray();
        var lines = (await c.QueryAsync<TicketLine>("select ticket_id, qty, name, extras, note from kitchen_ticket_line where ticket_id = any(@ids) order by sort", new { ids }, tx)).ToList();
        foreach (var t in tickets) t.Lines = lines.Where(l => l.TicketId == t.Id).ToList();
        return tickets;
    }

    public static void Map(RouteGroupBuilder api)
    {
        // The board: everything not yet served, plus what was served in the last 15 minutes (to recall).
        api.MapGet("/kitchen", async (HttpContext http, Db db, string? station) =>
        {
            var scope = await http.ScopeAsync(db);
            if (!scope.Can("kitchen.view")) scope.Require("pos.sell");
            return await db.Company(scope.CompanyId, async (c, tx) => new
            {
                stations = (await c.QueryAsync<(string Kind, string Name, string? PrinterName)>("select kind, name, printer_name from kitchen_station where branch_id = @b", new { b = scope.Branch }, tx))
                    .Select(s => new { kind = s.Kind, name = s.Name, printerName = s.PrinterName }),
                tickets = await TicketsAsync(c, tx, """
                    t.branch_id = @b and (@station is null or t.station = @station)
                      and (t.status <> 'served' or t.served_at > now() - interval '15 minutes')
                    """, new { b = scope.Branch, station }),
            });
        });

        api.MapPut("/kitchen/tickets/{id:guid}", async (Guid id, StatusBody body, HttpContext http, Db db, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            if (!scope.Can("kitchen.view")) scope.Require("pos.sell");
            var status = (body.Status ?? "").Trim().ToLowerInvariant();
            if (!Statuses.Contains(status)) throw new DomainException("The status is new, preparing, ready or served.");
            var orderId = await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var orderId = await c.ExecuteScalarAsync<Guid?>("""
                    update kitchen_ticket set status = @status,
                      started_at = case when @status = 'preparing' then coalesce(started_at, now()) when @status = 'new' then null else started_at end,
                      ready_at = case when @status = 'ready' then now() when @status in ('new','preparing') then null else ready_at end,
                      served_at = case when @status = 'served' then now() else null end
                    where id = @id and branch_id = @b returning order_id
                    """, new { id, status, b = scope.Branch }, tx);
                if (orderId is { } oid) await Pickup.FromTicketsAsync(c, tx, oid);
                return orderId ?? throw new NotFoundException("Ticket not found.");
            });
            await live.ToBranch(scope.Branch, "kitchen.changed", new { id, orderId, status });
            await live.ToBranch(scope.Branch, "pickup.changed", new { orderId });
            return Results.Ok(new { id, status });
        });

        // The one till that claims a ticket prints it (a ticket never prints twice). Answers the ticket and the station's printer.
        api.MapPost("/kitchen/tickets/{id:guid}/claim-print", async (Guid id, HttpContext http, Db db) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("pos.sell");
            return await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var claimed = await c.ExecuteAsync("update kitchen_ticket set printed_at = now() where id = @id and branch_id = @b and printed_at is null", new { id, b = scope.Branch }, tx) == 1;
                var ticket = (await TicketsAsync(c, tx, "t.id = @id", new { id })).Single();
                var printer = await c.ExecuteScalarAsync<string?>("select printer_name from kitchen_station where branch_id = @b and kind = @k", new { b = scope.Branch, k = ticket.Station }, tx);
                return new { claimed, printer, ticket };
            });
        });

        // A reprint from the kitchen display or the register.
        api.MapPost("/kitchen/tickets/{id:guid}/reprint", async (Guid id, HttpContext http, Db db) =>
        {
            var scope = await http.ScopeAsync(db);
            if (!scope.Can("kitchen.view")) scope.Require("pos.sell");
            return await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var ticket = (await TicketsAsync(c, tx, "t.id = @id and t.branch_id = @b", new { id, b = scope.Branch })).SingleOrDefault() ?? throw new NotFoundException("Ticket not found.");
                var printer = await c.ExecuteScalarAsync<string?>("select printer_name from kitchen_station where branch_id = @b and kind = @k", new { b = scope.Branch, k = ticket.Station }, tx);
                return new { claimed = true, printer, ticket };
            });
        });

        api.MapPut("/kitchen/stations", async (StationBody body, HttpContext http, Db db, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("branch.manage");
            var kind = (body.Kind ?? "").Trim().ToLowerInvariant();
            if (!Stations.Contains(kind)) throw new DomainException("A station is the kitchen or the bar.");
            if (string.IsNullOrWhiteSpace(body.Name)) throw new DomainException("Enter the station's name.");
            await db.Company(scope.CompanyId, async (c, tx) =>
            {
                await c.ExecuteAsync("""
                    insert into kitchen_station (company_id, branch_id, kind, name, printer_name) values (@co, @b, @kind, @name, @printer)
                    on conflict (branch_id, kind) do update set name = excluded.name, printer_name = excluded.printer_name
                    """, new { co = scope.CompanyId, b = scope.Branch, kind, name = body.Name.Trim(), printer = string.IsNullOrWhiteSpace(body.PrinterName) ? null : body.PrinterName.Trim() }, tx);
                await Audit.RecordAsync(c, tx, scope.CompanyId, scope.Branch, scope.UserId, "station", kind, "changed", $"Station {body.Name.Trim()} set",
                    [new("Printer", null, body.PrinterName)]);
                return 0;
            });
            await live.ToBranch(scope.Branch, "kitchen.changed");
            return Results.Ok(new { kind });
        });
    }
}
