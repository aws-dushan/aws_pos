using System.Text.Json;
using Dapper;
using Npgsql;
using OnePos.Api.Data;

namespace OnePos.Api.Platform;

/// <summary>Who did what, when (REQ USR-07). Changes record only the fields that differ, as in AWS One.</summary>
public static class Audit
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public sealed record FieldChange(string Field, object? Before, object? After);

    public static Task RecordAsync(NpgsqlConnection c, NpgsqlTransaction tx, Guid? companyId, Guid? branchId, Guid userId,
        string entity, string? entityId, string action, string label, IEnumerable<FieldChange>? fields = null, string? note = null)
    {
        var changes = (fields ?? []).Where(f => !Same(f.Before, f.After)).ToList();
        var data = JsonSerializer.Serialize(new { label, changes, note }, Json);
        return c.ExecuteAsync("""
            insert into audit_log (company_id, branch_id, user_id, entity, entity_id, action, data)
            values (@companyId, @branchId, @userId, @entity, @entityId, @action, cast(@data as jsonb))
            """, new { companyId, branchId, userId = userId == Guid.Empty ? (Guid?)null : userId, entity, entityId, action, data }, tx);   // Guid.Empty: done by the system (e.g. automatic day control)
    }

    public static IEnumerable<FieldChange> Created(params (string Field, object? Value)[] fields) => fields.Select(f => new FieldChange(f.Field, null, f.Value));

    private static bool Same(object? a, object? b) => JsonSerializer.Serialize(a, Json) == JsonSerializer.Serialize(b, Json);

    public sealed record Row(long Id, DateTime At, string? UserName, string? CompanyCode, string? BranchCode, string Entity, string? EntityId, string Action, string Data);

    public static void Map(RouteGroupBuilder api)
    {
        // The audit log: an admin sees everything (optionally one company); a user with audit.view sees their company's entries.
        api.MapGet("/audit", async (HttpContext http, Db db, string? companyId, string? entity, int? limit) =>
        {
            var user = http.CurrentUser();
            Guid? company = Guid.TryParse(companyId, out var cid) ? cid : null;
            if (!user.IsAdmin)
            {
                var scope = await http.ScopeAsync(db);
                scope.Require("audit.view");
                company = scope.CompanyId;
            }
            var take = Math.Clamp(limit ?? 200, 1, 1000);
            return await db.Platform(async (c, tx) => (await c.QueryAsync<Row>("""
                select a.id, a.at, u.display_name as user_name, co.code as company_code, b.code as branch_code, a.entity, a.entity_id, a.action, a.data::text as data
                from audit_log a
                left join app_user u on u.id = a.user_id
                left join company co on co.id = a.company_id
                left join branch b on b.id = a.branch_id
                where (@company is null or a.company_id = @company) and (@entity is null or a.entity = @entity)
                order by a.id desc limit @take
                """, new { company, entity, take }, tx)).ToList());
        });
    }
}
