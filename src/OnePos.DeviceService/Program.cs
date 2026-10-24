using System.Collections.Concurrent;
using System.Reflection;
using OnePos.DeviceService;

// One POS Device Service: runs as a Windows service on each till and listens only on this PC (127.0.0.1:5199).
// The One POS web app (in Chrome/Edge on the same till) calls it to print receipts, open the drawer and drive a pole display.
var builder = WebApplication.CreateBuilder(args);
builder.Host.UseWindowsService(o => o.ServiceName = "OnePosDevice");
builder.WebHost.ConfigureKestrel(k => k.ListenLocalhost(builder.Configuration.GetValue("Port", 5199)));
builder.Services.AddSingleton<SettingsStore>();
builder.Services.AddSingleton<Updater>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<Updater>());
var app = builder.Build();
var store = app.Services.GetRequiredService<SettingsStore>();
var version = Updater.Version;
var updater = app.Services.GetRequiredService<Updater>();
// Job ids already printed (a retried request never prints twice, REQ HW-07); the last 500.
var done = new ConcurrentDictionary<string, DateTime>();
string? lastError = null;
DateTime? lastPrintAt = null;

// Only the One POS web app may call the service: its origin must be allowed. Chrome's "local network access" preflight is answered too.
app.Use(async (ctx, next) =>
{
    var origin = ctx.Request.Headers.Origin.ToString();
    if (origin.Length > 0)
    {
        if (!store.Get().AllowedOrigins.Contains(origin, StringComparer.OrdinalIgnoreCase))
        {
            ctx.Response.StatusCode = 403;
            await ctx.Response.WriteAsJsonAsync(new { error = $"{origin} may not use this till's devices." });
            return;
        }
        ctx.Response.Headers.AccessControlAllowOrigin = origin;
        ctx.Response.Headers.Vary = "Origin";
        ctx.Response.Headers.AccessControlAllowHeaders = "content-type";
        ctx.Response.Headers.AccessControlAllowMethods = "GET, POST, PUT";
        ctx.Response.Headers["Access-Control-Allow-Private-Network"] = "true";
        if (HttpMethods.IsOptions(ctx.Request.Method)) { ctx.Response.StatusCode = 204; return; }
    }
    await next();
});

app.MapGet("/status", () =>
{
    var s = store.Get();
    return new
    {
        service = "One POS Device Service", version, machine = Environment.MachineName,
        s.ReceiptPrinter, s.PaperWidth, s.DrawerOnCash, s.PoleDisplayPort,
        printers = RawPrinter.Installed(), ports = System.IO.Ports.SerialPort.GetPortNames(),
        lastError, lastPrintAt,
        printerState = s.ReceiptPrinter is { } rp ? RawPrinter.State(rp) : null,
        update = new { s.AutoUpdate, latest = updater.LatestVersion, lastCheck = updater.LastCheck, result = updater.LastResult, paired = s.ServerApi is not null },
        // The One POS web address (the tray's "Open One POS"): the server's API address without /api.
        server = s.ServerApi is { } api && api.EndsWith("/api", StringComparison.OrdinalIgnoreCase) ? api[..^4] : s.ServerApi,
    };
});

app.MapPut("/settings", (DeviceSettings body) =>
{
    var s = store.Get();
    if (body.PaperWidth is not (58 or 80)) return Results.BadRequest(new { error = "Paper width is 58 or 80 mm." });
    store.Save(new DeviceSettings
    {
        ReceiptPrinter = string.IsNullOrWhiteSpace(body.ReceiptPrinter) ? null : body.ReceiptPrinter.Trim(),
        PaperWidth = body.PaperWidth, DrawerOnCash = body.DrawerOnCash,
        PoleDisplayPort = string.IsNullOrWhiteSpace(body.PoleDisplayPort) ? null : body.PoleDisplayPort.Trim(),
        AllowedOrigins = s.AllowedOrigins, AutoUpdate = s.AutoUpdate, ServerApi = s.ServerApi,
    });
    return Results.Ok(new { ok = true });
});

// The web app says which One POS server it came from (updates come only from there); only an allowed origin can say so,
// and the address must be on that same origin.
app.MapPut("/server", (ServerBody body, HttpContext ctx) =>
{
    var origin = ctx.Request.Headers.Origin.ToString();
    if (string.IsNullOrWhiteSpace(body.Api) || !Uri.TryCreate(body.Api, UriKind.Absolute, out var u) || origin.Length == 0
        || !string.Equals(u.GetLeftPart(UriPartial.Authority), origin, StringComparison.OrdinalIgnoreCase))
        return Results.BadRequest(new { error = "The server address must be on the web app's own address." });
    var s = store.Get();
    if (s.ServerApi != body.Api) { s.ServerApi = body.Api.TrimEnd('/'); store.Save(s); }
    return Results.Ok(new { ok = true });
});

app.MapPut("/update/auto", (AutoBody body) =>
{
    var s = store.Get();
    s.AutoUpdate = body.On;
    store.Save(s);
    return Results.Ok(new { ok = true });
});

// "Check for updates" on the Devices screen: install when asked to.
app.MapPost("/update/check", async (CheckBody body) => Results.Ok(new { result = await updater.CheckAsync(body.Install) }));

IResult Print(string jobId, Func<DeviceSettings, byte[]> bytes, string name, string? printer = null)
{
    var s = store.Get();
    var target = printer ?? s.ReceiptPrinter;
    if (target is null) return Results.BadRequest(new { error = "No receipt printer chosen on this till. Choose one under Devices." });
    if (printer is not null && !printer.StartsWith("file:", StringComparison.OrdinalIgnoreCase) && !RawPrinter.Installed().Contains(printer, StringComparer.OrdinalIgnoreCase))
        return Results.Json(new { error = $"The printer \"{printer}\" isn't installed on this till." }, statusCode: 502);
    if (!done.TryAdd(jobId, DateTime.UtcNow)) return Results.Ok(new { ok = true, duplicate = true });
    try
    {
        RawPrinter.Send(target, bytes(s), name);
        lastError = null;
        lastPrintAt = DateTime.UtcNow;
        foreach (var old in done.OrderBy(x => x.Value).Take(Math.Max(0, done.Count - 500))) done.TryRemove(old.Key, out _);
        return Results.Ok(new { ok = true });
    }
    catch (Exception ex)
    {
        done.TryRemove(jobId, out _);   // failed: may be retried
        lastError = ex.Message;
        app.Logger.LogWarning(ex, "Print failed");
        return Results.Json(new { error = ex.Message }, statusCode: 502);
    }
}

app.MapPost("/print/receipt", (ReceiptJob job) =>
    Print(job.JobId, s => ReceiptRenderer.Render(job with { OpenDrawer = job.Printer is null && job.OpenDrawer && s.DrawerOnCash }, s.Dots),
        job.Printer is null ? "One POS receipt" : "One POS kitchen ticket", job.Printer));

// The same receipt as a sharp picture (a PDF or a preview of exactly what prints), `scale` times the printer's resolution.
app.MapPost("/print/preview", (ReceiptJob job, int? scale) =>
    Results.File(ReceiptRenderer.Preview(job, store.Get().Dots, scale ?? 3), "image/png"));

app.MapPost("/drawer/open", (DrawerBody body) => Print(body.JobId, _ => [.. EscPos.Init, .. EscPos.OpenDrawer], "One POS drawer"));

app.MapPost("/print/test", () => Print(Guid.NewGuid().ToString(), s => ReceiptRenderer.Render(new ReceiptJob("test",
[
    new("One POS", null, "center", true, "large", false),
    new("Test print · طباعة تجريبية", null, "center", false, null, false),
    new(null, null, null, false, null, true),
    new("Printer", s.ReceiptPrinter, null, false, null, false),
    new("Paper", $"{s.PaperWidth} mm", null, false, null, false),
    new("Till", Environment.MachineName, null, false, null, false),
    new("Time", DateTime.UtcNow.ToString("u"), null, false, null, false),
    new(null, null, null, false, null, true),
    new("If you can read this, receipts will print.", null, "center", false, "small", false),
], OpenDrawer: false), s.Dots), "One POS test"));

app.MapPost("/display", (DisplayBody body) =>
{
    var port = store.Get().PoleDisplayPort;
    if (port is null) return Results.Ok(new { ok = true, skipped = true });
    try { PoleDisplay.Show(port, body.Line1 ?? "", body.Line2 ?? ""); return Results.Ok(new { ok = true }); }
    catch (Exception ex) { lastError = ex.Message; return Results.Json(new { error = ex.Message }, statusCode: 502); }
});

app.Run();

record DrawerBody(string JobId);
record ServerBody(string Api);
record AutoBody(bool On);
record CheckBody(bool Install);
record DisplayBody(string? Line1, string? Line2);
