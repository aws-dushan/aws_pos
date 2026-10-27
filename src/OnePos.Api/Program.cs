using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.ResponseCompression;
using Npgsql;
using OnePos.Api.Data;
using OnePos.Api.Platform;
using OnePos.Api.Pos;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddSingleton(_ =>
{
    var cs = new NpgsqlConnectionStringBuilder(builder.Configuration.GetConnectionString("App")
        ?? throw new InvalidOperationException("ConnectionStrings:App is not configured."));
    // No JIT: Postgres compiles queries that merely look expensive (reports over a year, the menu) and that alone took
    // 0.2–0.4 s per query; a POS's queries are short, so it only ever slows them down.
    // random_page_cost 1.1: the database is on SSD; Postgres' spinning-disk default made it read every bill line instead of
    // using the index for a month's report (338 ms -> 127 ms).
    const string tuning = "-c jit=off -c random_page_cost=1.1";
    cs.Options = string.IsNullOrWhiteSpace(cs.Options) ? tuning : $"{cs.Options} {tuning}";
    return NpgsqlDataSource.Create(cs.ConnectionString);
});
builder.Services.AddSingleton<Db>();
builder.Services.AddSingleton<Pins>();
builder.Services.AddSingleton<Live>();
builder.Services.AddSingleton<OnePos.Api.Erp.ErpConnections>();
builder.Services.AddSingleton<OnePos.Api.Erp.FactsSync>();
builder.Services.AddHostedService<OnePos.Api.Erp.FactsSync.Schedule>();
builder.Services.AddHostedService<Idempotency.Cleanup>();
builder.Services.AddHostedService<SalesSummary.Builder>();
builder.Services.AddHostedService<EmptyOrderSweep>();
builder.Services.AddHostedService<Days.AutoDay>();
builder.Services.AddHostedService<Notices.Sender>();
builder.Services.AddHostedService<ApprovalReminders>();
builder.Services.AddHostedService<OnePos.Api.Erp.FactsPosting.Sender>();
builder.Services.AddSignalR();
// Answers go compressed (Brotli, else gzip; the fastest level): the register's menu is ~67 KB of JSON and ~8 KB compressed, which
// matters on a shop's Wi-Fi or a remote branch's line. Images are already compressed and are left alone.
builder.Services.AddResponseCompression(o =>
{
    o.EnableForHttps = true;
    o.Providers.Add<BrotliCompressionProvider>();
    o.Providers.Add<GzipCompressionProvider>();
});
builder.Services.Configure<BrotliCompressionProviderOptions>(o => o.Level = System.IO.Compression.CompressionLevel.Fastest);
builder.Services.Configure<GzipCompressionProviderOptions>(o => o.Level = System.IO.Compression.CompressionLevel.Fastest);
// Keys that protect the sign-in cookie and the stored ERP connection strings: kept with the data (config DataProtection:Keys,
// else data/keys), as in AWS One. On Windows the key files are themselves encrypted for this machine (DPAPI).
var dataProtection = builder.Services.AddDataProtection().SetApplicationName("OnePos").PersistKeysToFileSystem(new DirectoryInfo(builder.Configuration["DataProtection:Keys"]
    ?? Path.GetFullPath(Path.Combine(builder.Environment.ContentRootPath, "..", "..", "data", "keys"))));
if (OperatingSystem.IsWindows()) dataProtection.ProtectKeysWithDpapi(protectToLocalMachine: true);
builder.Services.ConfigureHttpJsonOptions(o => o.SerializerOptions.Converters.Add(new JsonStringEnumConverter()));

builder.Services.AddAuthentication(CookieAuthenticationDefaults.AuthenticationScheme)
    .AddCookie(o =>
    {
        // Live and test share one web address on the servers, so each has its own cookie name and path (config Auth:CookieName, Auth:CookiePath).
        o.Cookie.Name = builder.Configuration["Auth:CookieName"] is { Length: > 0 } cn ? cn : "onepos";
        if (builder.Configuration["Auth:CookiePath"] is { Length: > 0 } cp) o.Cookie.Path = cp;
        o.Cookie.HttpOnly = true;
        o.Cookie.SameSite = SameSiteMode.Lax;
        o.Cookie.SecurePolicy = CookieSecurePolicy.SameAsRequest;
        // A till stays signed in for the shift; the PIN pad's lock and day control end sessions in phase 2.
        o.ExpireTimeSpan = TimeSpan.FromHours(16);
        o.SlidingExpiration = true;
        // An API answers 401/403; the web app decides where to send the user.
        o.Events.OnRedirectToLogin = ctx => { ctx.Response.StatusCode = 401; return Task.CompletedTask; };
        o.Events.OnRedirectToAccessDenied = ctx => { ctx.Response.StatusCode = 403; return Task.CompletedTask; };
    });
builder.Services.AddAuthorization();

var app = builder.Build();

await Migrator.RunAsync(builder.Configuration.GetConnectionString("Owner")
    ?? throw new InvalidOperationException("ConnectionStrings:Owner is not configured."), app.Logger);
await AuthEndpoints.SeedAdminAsync(app.Services.GetRequiredService<Db>(), builder.Configuration, app.Logger);

app.UseResponseCompression();
app.UseApiErrors();
app.UseAuthentication();
app.UseAuthorization();
// A session signed in with a password someone else set may only change it (and read who it is) until it does.
app.Use(async (http, next) =>
{
    var path = http.Request.Path.Value ?? "";
    if (RequestContext.MustChangePassword(http) && path.StartsWith("/api/", StringComparison.OrdinalIgnoreCase)
        && !(path.Equals("/api/me", StringComparison.OrdinalIgnoreCase) || path.Equals("/api/me/password", StringComparison.OrdinalIgnoreCase)
             || path.StartsWith("/api/auth/", StringComparison.OrdinalIgnoreCase)))
        throw new ForbiddenException("Change your password first.");
    await next();
});
app.UseIdempotency();

var api = app.MapGroup("/api").RequireAuthorization();
AuthEndpoints.Map(api);
CompanyEndpoints.Map(api);
UserEndpoints.Map(api);
Audit.Map(api);
Registers.Map(api);
Menu.Map(api);
Orders.Map(api);
Tables.Map(api);
OrderTables.Map(api);
Kitchen.Map(api);
Returns.Map(api);
Days.Map(api);
Approvals.Map(api);
Paper.Map(api);
Customers.Map(api);
Reports.Map(api);
BranchComparison.Map(api);
StockReport.Map(api);
Reservations.Map(api);
Stock.Map(api);
WastageApproval.Map(api);
StockReturns.Map(api);
StockRequests.Map(api);
Rewards.Map(api);
Recipes.Map(api);
Boms.Map(api);
Discounts.Map(api);
Platforms.Map(api);
Pickup.Map(api);
Exceptions.Map(api);
OnePos.Api.Erp.ErpConnections.Map(api);
OnePos.Api.Erp.FactsSync.Map(api);
Dashboard.Map(api);
ItemImages.Map(api, builder.Configuration, app.Environment);
Branding.Map(app, api, builder.Configuration, app.Environment);
PublicReceipts.Map(app);
DeviceReleases.Map(app, builder.Configuration, app.Environment);
DeviceStatus.Map(api);
Notices.Map(api);
OnePos.Api.Erp.FactsPosting.Map(api);
Feedback.Map(api, builder.Configuration, app.Environment);

app.MapHub<LiveHub>("/hubs/live");
app.MapGet("/health", () => "ok");

app.Run();
