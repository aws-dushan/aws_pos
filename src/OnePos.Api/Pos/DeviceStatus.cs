using Dapper;
using OnePos.Api.Data;
using OnePos.Api.Platform;

namespace OnePos.Api.Pos;

/// <summary>
/// Device status per branch (REQ HW-08). Every PC running One POS reports each minute what its Device Service says (version,
/// receipt printer and its state, last print, last error); the Devices screen lists the branch's PCs with online / offline.
/// </summary>
public static class DeviceStatus
{
    public sealed record Beat(string DeviceKey, string? Machine, string? ServiceVersion, string? ReceiptPrinter, string? PrinterState, DateTime? LastPrintAt, string? LastError);

    public sealed class Row
    {
        public Guid Id { get; set; }
        public string DeviceKey { get; set; } = "";
        public string? RegisterName { get; set; }
        public string? Machine { get; set; }
        public string? UserName { get; set; }
        public string? ServiceVersion { get; set; }
        public string? ReceiptPrinter { get; set; }
        public string? PrinterState { get; set; }
        public DateTime? LastPrintAt { get; set; }
        public string? LastError { get; set; }
        public DateTime LastSeen { get; set; }
        public bool Online { get; set; }
    }

    private static string? Cut(string? s, int n) => string.IsNullOrWhiteSpace(s) ? null : s.Trim().Length > n ? s.Trim()[..n] : s.Trim();

    public static void Map(RouteGroupBuilder api)
    {
        api.MapPost("/devices/heartbeat", async (Beat body, HttpContext http, Db db) =>
        {
            var scope = await http.ScopeAsync(db);
            var key = Cut(body.DeviceKey, 64) ?? throw new DomainException("No device key.");
            await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var user = await c.ExecuteScalarAsync<string?>("select display_name from app_user where id = @u", new { u = scope.UserId }, tx);
                await c.ExecuteAsync("""
                    insert into device_status (company_id, branch_id, device_key, register_id, machine, user_name, service_version, receipt_printer, printer_state, last_print_at, last_error, last_seen)
                    values (@co, @b, @key, @reg, @machine, @user, @ver, @printer, @state, @printed, @err, now())
                    on conflict (branch_id, device_key) do update set register_id = excluded.register_id, machine = coalesce(excluded.machine, device_status.machine),
                      user_name = excluded.user_name, service_version = excluded.service_version, receipt_printer = excluded.receipt_printer,
                      printer_state = excluded.printer_state, last_print_at = excluded.last_print_at, last_error = excluded.last_error, last_seen = now()
                    """, new
                    {
                        co = scope.CompanyId, b = scope.Branch, key, reg = scope.RegisterId, machine = Cut(body.Machine, 80), user, ver = Cut(body.ServiceVersion, 20),
                        printer = Cut(body.ReceiptPrinter, 200), state = Cut(body.PrinterState, 30), printed = body.LastPrintAt, err = Cut(body.LastError, 300),
                    }, tx);
                return 0;
            });
            return Results.Ok(new { ok = true });
        });

        // The branch's PCs: seen in the last 2 minutes is online; not seen for 30 days drops off the list.
        api.MapGet("/devices", async (HttpContext http, Db db) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("branch.manage");
            return await db.Company(scope.CompanyId, (c, tx) => c.QueryAsync<Row>("""
                select d.*, r.name as register_name, d.last_seen > now() - interval '2 minutes' as online
                from device_status d left join register r on r.id = d.register_id
                where d.branch_id = @b and d.last_seen > now() - interval '30 days'
                order by d.machine is null, d.machine, d.last_seen desc
                """, new { b = scope.Branch }, tx));
        });

        api.MapDelete("/devices/{id:guid}", async (Guid id, HttpContext http, Db db) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("branch.manage");
            await db.Company(scope.CompanyId, (c, tx) => c.ExecuteAsync("delete from device_status where id = @id and branch_id = @b", new { id, b = scope.Branch }, tx));
            return Results.Ok(new { id });
        });
    }
}
