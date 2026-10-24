using Dapper;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.Data.SqlClient;
using OnePos.Api.Data;
using OnePos.Api.Platform;

namespace OnePos.Api.Erp;

/// <summary>
/// Each company's ERP connection (REQ ERP-01). An administrator pastes the FACTS connection string in Companies &amp; branches; it is
/// stored encrypted (Data Protection) and never sent back to the browser, which sees only a summary. "Test" connects and reports the
/// server, database and login, and warns when the login can write (One POS only reads FACTS; returns go in as STV documents).
/// </summary>
public sealed class ErpConnections(IDataProtectionProvider dp, Db db)
{
    private readonly IDataProtector protector = dp.CreateProtector("OnePos.Erp.ConnectionString.v1");

    public sealed record SetBody(string ConnectionString);
    public sealed record TestBody(string? ConnectionString);
    public sealed record TestResult(bool Ok, string Message, string? Server, string? Database, string? Login, string? Version, int? Tables, bool? CanWrite);

    /// <summary>The company's connection string, for the connector (phase 3). Null when none is set.</summary>
    public async Task<string?> GetAsync(Guid companyId)
    {
        var secret = await db.Company(companyId, (c, tx) => c.ExecuteScalarAsync<string?>("select secret from company_erp where company_id = @companyId", new { companyId }, tx));
        return secret is null ? null : protector.Unprotect(secret);
    }

    /// <summary>Parses it (SQL Server syntax) and describes it without the password.</summary>
    private static (SqlConnectionStringBuilder Builder, string Summary) Parse(string? s)
    {
        if (string.IsNullOrWhiteSpace(s)) throw new DomainException("Paste the connection string.");
        SqlConnectionStringBuilder b;
        try { b = new SqlConnectionStringBuilder(s.Trim()); }
        catch (Exception ex) when (ex is ArgumentException or FormatException or KeyNotFoundException)
        { throw new DomainException($"This isn't a valid SQL Server connection string: {ex.Message}"); }
        if (string.IsNullOrWhiteSpace(b.DataSource)) throw new DomainException("The connection string has no server (Server= or Data Source=).");
        if (string.IsNullOrWhiteSpace(b.InitialCatalog)) throw new DomainException("The connection string has no database (Database= or Initial Catalog=).");
        var login = b.IntegratedSecurity ? "Windows login" : string.IsNullOrWhiteSpace(b.UserID) ? "no login" : b.UserID;
        return (b, $"{b.DataSource} · {b.InitialCatalog} · {login}");
    }

    private static async Task<TestResult> TestAsync(string connectionString)
    {
        var (b, _) = Parse(connectionString);
        b.ConnectTimeout = Math.Min(b.ConnectTimeout, 10);
        b.ApplicationName = "One POS";
        try
        {
            await using var c = new SqlConnection(b.ConnectionString);
            await c.OpenAsync();
            var r = await c.QuerySingleAsync<(string Version, string Database, string Login, int Tables, int CanWrite)>("""
                select cast(serverproperty('ProductVersion') as nvarchar(64)) + ' ' + cast(serverproperty('Edition') as nvarchar(128)),
                       db_name(), suser_sname(),
                       (select count(*) from information_schema.tables where table_type = 'BASE TABLE'),
                       isnull(has_perms_by_name(db_name(), 'DATABASE', 'INSERT'), 0) | isnull(has_perms_by_name(db_name(), 'DATABASE', 'UPDATE'), 0)
                """, commandTimeout: 15);
            var write = r.CanWrite == 1;
            return new TestResult(true,
                write ? "Connected. This login can also change data in FACTS: ask for a read-only login (One POS only reads it)." : "Connected with a read-only login.",
                b.DataSource, r.Database, r.Login, r.Version, r.Tables, write);
        }
        catch (SqlException ex)
        {
            var hint = ex.Message.Contains("certificate", StringComparison.OrdinalIgnoreCase)
                ? " The server's certificate isn't trusted: add TrustServerCertificate=True to the connection string (or install a trusted certificate on the server)."
                : ex.Number is 18456 ? " The login or password is wrong." : ex.Number is -2 or 53 or 40 or 258 || ex.Message.Contains("network-related", StringComparison.OrdinalIgnoreCase) ? " The server can't be reached from the One POS server (address, port 1433, firewall or VPN)." : "";
            return new TestResult(false, $"Couldn't connect: {ex.Message.Split('\n')[0].Trim()}{hint}", b.DataSource, b.InitialCatalog, null, null, null, null);
        }
    }

    public static void Map(RouteGroupBuilder api)
    {
        api.MapGet("/companies/{companyId:guid}/erp", async (Guid companyId, HttpContext http, Db db) =>
        {
            http.RequireAdmin();
            return await db.Company(companyId, async (c, tx) =>
            {
                var connector = await c.ExecuteScalarAsync<string?>("select erp_connector from company where id = @companyId", new { companyId }, tx) ?? throw new NotFoundException("Company not found.");
                var row = await c.QuerySingleOrDefaultAsync<(string Summary, DateTime UpdatedAt, string UpdatedBy, DateTime? TestedAt, bool? TestOk, string? TestMessage)>("""
                    select e.summary, e.updated_at, u.display_name, e.tested_at, e.test_ok, e.test_message
                    from company_erp e join app_user u on u.id = e.updated_by where e.company_id = @companyId
                    """, new { companyId }, tx);
                return new
                {
                    connector, configured = row.Summary is not null, summary = row.Summary, updatedAt = row.Summary is null ? (DateTime?)null : row.UpdatedAt,
                    updatedBy = row.UpdatedBy, testedAt = row.TestedAt, testOk = row.TestOk, testMessage = row.TestMessage,
                };
            });
        });

        // Test a pasted string before saving it, or (no string) the saved one.
        api.MapPost("/companies/{companyId:guid}/erp/test", async (Guid companyId, TestBody body, HttpContext http, Db db, ErpConnections erp) =>
        {
            http.RequireAdmin();
            var pasted = !string.IsNullOrWhiteSpace(body.ConnectionString);
            var cs = pasted ? body.ConnectionString! : await erp.GetAsync(companyId) ?? throw new DomainException("No connection is saved yet.");
            var result = await TestAsync(cs);
            if (!pasted)
                await db.Company(companyId, (c, tx) => c.ExecuteAsync("update company_erp set tested_at = now(), test_ok = @Ok, test_message = @Message where company_id = @companyId",
                    new { companyId, result.Ok, result.Message }, tx));
            return result;
        });

        api.MapPut("/companies/{companyId:guid}/erp", async (Guid companyId, SetBody body, HttpContext http, Db db, ErpConnections erp) =>
        {
            http.RequireAdmin();
            var me = http.CurrentUser();
            var (_, summary) = Parse(body.ConnectionString);
            var result = await TestAsync(body.ConnectionString);
            await db.Company(companyId, async (c, tx) =>
            {
                await c.ExecuteAsync("""
                    insert into company_erp (company_id, secret, summary, updated_by, tested_at, test_ok, test_message) values (@companyId, @secret, @summary, @u, now(), @Ok, @Message)
                    on conflict (company_id) do update set secret = excluded.secret, summary = excluded.summary, updated_by = excluded.updated_by, updated_at = now(),
                      tested_at = now(), test_ok = excluded.test_ok, test_message = excluded.test_message
                    """, new { companyId, secret = erp.protector.Protect(body.ConnectionString.Trim()), summary, u = me.Id, result.Ok, result.Message }, tx);
                // The value itself is never written to the audit log.
                await Audit.RecordAsync(c, tx, companyId, null, me.Id, "company", companyId.ToString(), "erp_connection", $"ERP connection set: {summary}");
                return 0;
            });
            return Results.Ok(new { summary, test = result });
        });

        api.MapDelete("/companies/{companyId:guid}/erp", async (Guid companyId, HttpContext http, Db db) =>
        {
            http.RequireAdmin();
            var me = http.CurrentUser();
            await db.Company(companyId, async (c, tx) =>
            {
                await c.ExecuteAsync("delete from company_erp where company_id = @companyId", new { companyId }, tx);
                await Audit.RecordAsync(c, tx, companyId, null, me.Id, "company", companyId.ToString(), "erp_connection", "ERP connection removed");
                return 0;
            });
            return Results.Ok(new { ok = true });
        });
    }
}
