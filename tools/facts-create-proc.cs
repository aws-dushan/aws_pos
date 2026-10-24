#:sdk Microsoft.NET.Sdk.Web
#:package Microsoft.Data.SqlClient@7.1.1
#:package System.Security.Cryptography.Pkcs@10.0.13
#:package Npgsql@10.0.3
// Creates ONE One POS procedure in a company's FACTS database (the user's go-ahead is needed for every run).
//   dotnet run tools/facts-create-proc.cs --no-cache -- <file.sql> <COMPANY CODE>
// Guarded: the file must be a single "CREATE PROCEDURE dbo.usp_ONEPOS_…" and nothing else; an existing procedure of that name is
// left as it is (never replaced). Uses the company's saved FACTS connection (never printed), not read-only.
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;

if (args.Length < 2) { Console.WriteLine("usage: facts-create-proc.cs <file.sql> <COMPANY CODE>"); return 1; }
var sql = File.ReadAllText(args[0]).Trim();
var m = Regex.Match(sql, @"^CREATE\s+PROCEDURE\s+dbo\.(usp_ONEPOS_[A-Za-z0-9_]+)\b", RegexOptions.IgnoreCase);
if (!m.Success) { Console.WriteLine("Refused: the file must start with CREATE PROCEDURE dbo.usp_ONEPOS_<name>."); return 1; }
if (Regex.IsMatch(sql, @"^\s*GO\s*$", RegexOptions.Multiline | RegexOptions.IgnoreCase)) { Console.WriteLine("Refused: one batch only (no GO)."); return 1; }
var name = m.Groups[1].Value;

var root = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", ".."));
root = Directory.Exists(Path.Combine(root, "data", "keys")) ? root : @"C:\Users\Saboor.a\Desktop\AWS One POS_Restaurant";
var sc = new ServiceCollection();
sc.AddDataProtection().SetApplicationName("OnePos").PersistKeysToFileSystem(new DirectoryInfo(Path.Combine(root, "data", "keys"))).ProtectKeysWithDpapi(true);
var protector = sc.BuildServiceProvider().GetRequiredService<IDataProtectionProvider>().CreateProtector("OnePos.Erp.ConnectionString.v1");
var settings = System.Text.Json.JsonDocument.Parse(File.ReadAllText(Path.Combine(root, "src", "OnePos.Api", "appsettings.Development.json")));
string secret;
await using (var pg = new NpgsqlConnection(settings.RootElement.GetProperty("ConnectionStrings").GetProperty("Owner").GetString()))
{
    await pg.OpenAsync();
    await using var cmd = new NpgsqlCommand("select e.secret from company_erp e join company c on c.id = e.company_id where c.code = @code", pg);
    cmd.Parameters.AddWithValue("code", args[1]);
    secret = (string?)await cmd.ExecuteScalarAsync() ?? throw new InvalidOperationException($"Company {args[1]} has no FACTS connection.");
}
var b = new SqlConnectionStringBuilder(protector.Unprotect(secret)) { ApplicationName = "One POS setup" };
Console.WriteLine($"FACTS {b.DataSource} / {b.InitialCatalog} (company {args[1]})");
await using var f = new SqlConnection(b.ConnectionString);
await f.OpenAsync();
await using (var chk = new SqlCommand("select count(*) from sys.procedures where name = @n and schema_id = schema_id('dbo')", f))
{
    chk.Parameters.AddWithValue("n", name);
    if ((int)(await chk.ExecuteScalarAsync())! > 0) { Console.WriteLine($"dbo.{name} already exists: left as it is."); return 0; }
}
await using (var create = new SqlCommand(sql, f) { CommandTimeout = 60 })
    await create.ExecuteNonQueryAsync();
await using (var chk = new SqlCommand("select create_date from sys.procedures where name = @n and schema_id = schema_id('dbo')", f))
{
    chk.Parameters.AddWithValue("n", name);
    Console.WriteLine($"Created dbo.{name} at {await chk.ExecuteScalarAsync():yyyy-MM-dd HH:mm:ss}.");
}
return 0;
