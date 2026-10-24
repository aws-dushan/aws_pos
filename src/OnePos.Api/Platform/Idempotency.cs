using Dapper;
using OnePos.Api.Data;

namespace OnePos.Api.Platform;

/// <summary>
/// REQ ONL-02: a write sent with an <c>Idempotency-Key</c> header runs once. Sent again (a retry after a dropped connection),
/// it answers the stored result of the first run and changes nothing. A run that failed with a server error is forgotten,
/// so it can be retried. Keys are kept 7 days.
/// </summary>
public static class Idempotency
{
    public const string Header = "Idempotency-Key";

    public static void UseIdempotency(this WebApplication app) => app.Use(async (ctx, next) =>
    {
        var key = ctx.Request.Headers[Header].ToString();
        if (key.Length == 0 || HttpMethods.IsGet(ctx.Request.Method) || ctx.User.Identity?.IsAuthenticated != true)
        {
            await next();
            return;
        }
        if (key.Length is < 8 or > 100) { ctx.Response.StatusCode = 400; await ctx.Response.WriteAsJsonAsync(new { error = "The Idempotency-Key must be 8–100 characters." }); return; }

        var db = ctx.RequestServices.GetRequiredService<Db>();
        var userId = ctx.CurrentUser().Id;
        var path = ctx.Request.Path.ToString();
        var first = await db.Platform((c, tx) => c.ExecuteAsync("""
            insert into idempotency_key (key, user_id, method, path) values (@key, @userId, @method, @path) on conflict (key) do nothing
            """, new { key, userId, method = ctx.Request.Method, path }, tx)) == 1;
        if (!first)
        {
            var seen = await db.Platform((c, tx) => c.QuerySingleAsync<(Guid UserId, string Path, int? StatusCode, string? Response)>(
                "select user_id, path, status_code, response from idempotency_key where key = @key", new { key }, tx));
            ctx.Response.ContentType = "application/json";
            if (seen.UserId != userId || seen.Path != path)
            {
                ctx.Response.StatusCode = 422;
                await ctx.Response.WriteAsJsonAsync(new { error = "This request key was already used for a different request." });
            }
            else if (seen.StatusCode is null)
            {
                ctx.Response.StatusCode = 409;
                await ctx.Response.WriteAsJsonAsync(new { error = "The same request is still being processed. Wait a moment." });
            }
            else
            {
                ctx.Response.StatusCode = seen.StatusCode.Value;
                ctx.Response.Headers["Idempotent-Replay"] = "true";
                if (seen.Response is { Length: > 0 }) await ctx.Response.WriteAsync(seen.Response);
            }
            return;
        }

        var original = ctx.Response.Body;
        await using var buffer = new MemoryStream();
        ctx.Response.Body = buffer;
        try
        {
            await next();
        }
        finally
        {
            ctx.Response.Body = original;
        }
        buffer.Position = 0;
        var body = await new StreamReader(buffer).ReadToEndAsync();
        if (ctx.Response.StatusCode >= 500)
            await db.Platform((c, tx) => c.ExecuteAsync("delete from idempotency_key where key = @key", new { key }, tx));
        else
            await db.Platform((c, tx) => c.ExecuteAsync("update idempotency_key set status_code = @s, response = @body where key = @key",
                new { key, s = ctx.Response.StatusCode, body }, tx));
        buffer.Position = 0;
        await buffer.CopyToAsync(original);
    });

    /// <summary>Drops keys older than 7 days, hourly.</summary>
    public sealed class Cleanup(Db db, ILogger<Cleanup> logger) : BackgroundService
    {
        protected override async Task ExecuteAsync(CancellationToken stop)
        {
            while (!stop.IsCancellationRequested)
            {
                try { await db.Platform((c, tx) => c.ExecuteAsync("delete from idempotency_key where created_at < now() - interval '7 days'", transaction: tx)); }
                catch (Exception ex) { logger.LogWarning(ex, "Idempotency cleanup failed"); }
                // The FACTS sync log (a row per sync, every few minutes): 90 days are kept, and always each kind's latest.
                try
                {
                    var companies = await db.Platform((c, tx) => c.QueryAsync<Guid>("select id from company", transaction: tx));
                    foreach (var co in companies)
                        await db.Company(co, (c, tx) => c.ExecuteAsync("""
                            delete from erp_sync s where s.started_at < now() - interval '90 days'
                              and s.id <> (select x.id from erp_sync x where x.kind = s.kind and x.branch_id is not distinct from s.branch_id order by x.started_at desc limit 1)
                            """, transaction: tx));
                }
                catch (Exception ex) { logger.LogWarning(ex, "Sync log cleanup failed"); }
                await Task.Delay(TimeSpan.FromHours(1), stop).ContinueWith(_ => { });
            }
        }
    }
}
