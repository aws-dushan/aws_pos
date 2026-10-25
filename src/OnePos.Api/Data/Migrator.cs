using Dapper;
using Npgsql;

namespace OnePos.Api.Data;

/// <summary>
/// Applies db/migrations/*.sql in name order, once each, as the owner role.
/// Each file runs in its own transaction; a failure stops startup with the file name.
/// </summary>
public static class Migrator
{
    public static async Task RunAsync(string ownerConnectionString, ILogger logger)
    {
        var dir = Path.Combine(AppContext.BaseDirectory, "migrations");
        var files = Directory.GetFiles(dir, "*.sql").OrderBy(Path.GetFileName, StringComparer.Ordinal).ToArray();

        await using var conn = new NpgsqlConnection(ownerConnectionString);
        await conn.OpenAsync();
        await conn.ExecuteAsync("""
            CREATE TABLE IF NOT EXISTS schema_migration (
              name       text PRIMARY KEY,
              applied_at timestamptz NOT NULL DEFAULT now())
            """);
        var applied = (await conn.QueryAsync<string>("select name from schema_migration")).ToHashSet();

        foreach (var file in files)
        {
            var name = Path.GetFileName(file);
            if (applied.Contains(name)) continue;

            await using var tx = await conn.BeginTransactionAsync();
            try
            {
                await conn.ExecuteAsync(await File.ReadAllTextAsync(file), transaction: tx);
                await conn.ExecuteAsync("insert into schema_migration(name) values (@name)", new { name }, tx);
                await tx.CommitAsync();
                logger.LogInformation("Applied migration {Migration}", name);
            }
            catch (Exception ex)
            {
                throw new InvalidOperationException($"Migration {name} failed: {ex.Message}", ex);
            }
        }
    }
}
