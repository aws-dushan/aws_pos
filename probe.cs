#:sdk Microsoft.NET.Sdk.Web
#:package Microsoft.Data.SqlClient@7.1.1
#:package System.Security.Cryptography.Pkcs@10.0.13
#:package Npgsql@10.0.3
// Read-only FACTS probe: decrypts the company's saved connection (never printed), runs SELECT/WITH queries from a file
// inside a transaction that is always rolled back, with ApplicationIntent=ReadOnly. Output as tab-separated rows.
using Microsoft.AspNetCore.DataProtection;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;

var root = @"C:\Users\Saboor.a\Desktop\AWS One POS_Restaurant";
var sc = new ServiceCollection();
sc.AddDataProtection().SetApplicationName("OnePos").PersistKeysToFileSystem(new DirectoryInfo(Path.Combine(root, "data", "keys"))).ProtectKeysWithDpapi(true);
var protector = sc.BuildServiceProvider().GetRequiredService<IDataProtectionProvider>().CreateProtector("OnePos.Erp.ConnectionString.v1");

string secret;
var settings = System.Text.Json.JsonDocument.Parse(File.ReadAllText(Path.Combine(root, "src", "OnePos.Api", "appsettings.Development.json")));
var owner = settings.RootElement.GetProperty("ConnectionStrings").GetProperty("Owner").GetString();
await using (var pg = new NpgsqlConnection(owner))
{
    await pg.OpenAsync();
    await using var cmd = new NpgsqlCommand("select e.secret from company_erp e join company c on c.id = e.company_id where c.code = 'ABK'", pg);
    secret = (string)(await cmd.ExecuteScalarAsync())!;
}
var b = new SqlConnectionStringBuilder(protector.Unprotect(secret)) { ApplicationIntent = ApplicationIntent.ReadOnly, ApplicationName = "One POS probe" };

var sql = File.ReadAllText(args[0]);
var max = args.Length > 1 ? int.Parse(args[1]) : 200;
foreach (var q in sql.Split("\n;;\n", StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
{
    var head = q.TrimStart().Split(' ', '\n', '\r', '\t')[0].ToUpperInvariant();
    if (head is not ("SELECT" or "WITH" or "--")) { Console.WriteLine($"!! refused (read-only): {head}"); continue; }
    await using var c = new SqlConnection(b.ConnectionString);
    await c.OpenAsync();
    await using var tx = c.BeginTransaction(System.Data.IsolationLevel.ReadUncommitted);
    try
    {
        await using var cmd = new SqlCommand(q, c, tx) { CommandTimeout = 60 };
        await using var r = await cmd.ExecuteReaderAsync();
        Console.WriteLine("== " + q.Split('\n')[0].Trim());
        Console.WriteLine(string.Join("\t", Enumerable.Range(0, r.FieldCount).Select(r.GetName)));
        var n = 0;
        while (await r.ReadAsync() && n++ < max)
            Console.WriteLine(string.Join("\t", Enumerable.Range(0, r.FieldCount).Select(i => r.IsDBNull(i) ? "" : Convert.ToString(r.GetValue(i))?.Replace("\t", " ").Replace("\n", " ").Replace("\r", ""))));
    }
    catch (SqlException ex) { Console.WriteLine("!! " + ex.Message.Split('\n')[0]); }
    finally { tx.Rollback(); }
}
