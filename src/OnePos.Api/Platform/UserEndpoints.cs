using System.Text.Json;
using Dapper;
using Npgsql;
using OnePos.Api.Data;

namespace OnePos.Api.Platform;

/// <summary>
/// Users and roles of a company (REQ USR-01 … USR-04). Needs users.manage in that company (or administrator).
/// A user can belong to several companies, with a role, a till PIN and branches in each.
/// </summary>
public static class UserEndpoints
{
    /// <summary>Limits: the user's own over the role's (null value: no limit for them; left out: as the role). Not sent: unchanged.</summary>
    /// <summary>IsAdmin: an administrator of One POS (every company); only an administrator changes it. Not sent: unchanged.</summary>
    public sealed record UserBody(string? Username, string DisplayName, string? Password, Guid RoleId, Guid[]? BranchIds, string? Pin, bool? ClearPin, bool? IsActive,
        JsonElement? Limits = null, bool? IsAdmin = null);
    public sealed record RoleBody(string Name, string[]? Permissions, JsonElement? Limits);

    public sealed class UserRow
    {
        public Guid Id { get; set; }
        public string Username { get; set; } = "";
        public string DisplayName { get; set; } = "";
        public bool IsActive { get; set; }
        public bool IsAdmin { get; set; }
        public Guid RoleId { get; set; }
        public string RoleName { get; set; } = "";
        public bool HasPin { get; set; }
        public bool HasPassword { get; set; }
        public Guid[] BranchIds { get; set; } = [];
        public string Limits { get; set; } = "{}";
    }

    public sealed class RoleRow
    {
        public Guid Id { get; set; }
        public string Name { get; set; } = "";
        public string[] Permissions { get; set; } = [];
        public string Limits { get; set; } = "{}";
        public int Users { get; set; }
    }

    public static void Map(RouteGroupBuilder api)
    {
        api.MapGet("/permissions", () => new
        {
            permissions = Permissions.All,
            limits = Permissions.LimitDefs.Select(l => new { key = l.Key, label = l.Label }),
        });

        api.MapGet("/companies/{companyId:guid}/users", async (Guid companyId, HttpContext http, Db db) =>
        {
            (await http.ScopeAsync(db, companyId)).Require("users.manage");
            return await db.Platform(async (c, tx) => (await c.QueryAsync<UserRow>("""
                select u.id, u.username, u.display_name, u.is_active, u.is_admin, uc.role_id, r.name as role_name,
                       uc.pin_lookup is not null as has_pin, u.password_hash is not null as has_password,
                       coalesce(array(select ub.branch_id from user_branch ub join branch b on b.id = ub.branch_id
                                      where ub.user_id = u.id and b.company_id = @companyId), '{}') as branch_ids,
                       uc.limits::text as limits
                from user_company uc join app_user u on u.id = uc.user_id join role r on r.id = uc.role_id
                where uc.company_id = @companyId
                order by u.display_name
                """, new { companyId }, tx)).Select(u => new
                {
                    u.Id, u.Username, u.DisplayName, u.IsActive, u.IsAdmin, u.RoleId, u.RoleName, u.HasPin, u.HasPassword, u.BranchIds,
                    limits = JsonDocument.Parse(u.Limits).RootElement,
                }).ToList());
        });

        api.MapPost("/companies/{companyId:guid}/users", async (Guid companyId, UserBody body, HttpContext http, Db db, Pins pins) =>
        {
            var scope = await http.ScopeAsync(db, companyId);
            scope.Require("users.manage");
            var username = (body.Username ?? "").Trim().ToLowerInvariant();
            if (username.Length == 0) throw new DomainException("Enter a username.");
            if (string.IsNullOrWhiteSpace(body.DisplayName)) throw new DomainException("Enter the user's name.");
            var id = await db.Platform(async (c, tx) =>
            {
                await CheckRoleAndBranchesAsync(c, tx, companyId, body);
                var existing = await c.QuerySingleOrDefaultAsync<(Guid Id, bool IsAdmin)?>("select id, is_admin from app_user where username = @username", new { username }, tx);
                Guid id;
                if (existing is { } e)
                {
                    // The same person in a second company: only an administrator links an existing user.
                    if (!scope.IsAdmin) throw new ConflictException("This username is already taken.");
                    if (await c.ExecuteScalarAsync<bool>("select exists (select 1 from user_company where user_id = @id and company_id = @companyId)", new { e.Id, companyId }, tx))
                        throw new ConflictException("This user is already in the company.");
                    id = e.Id;
                }
                else
                {
                    if (body.Password is { Length: > 0 }) Passwords.Check(body.Password, username);
                    id = await c.ExecuteScalarAsync<Guid>("insert into app_user (username, display_name, password_hash, must_change_password) values (@username, @name, @hash, @hash is not null) returning id",
                        new { username, name = body.DisplayName.Trim(), hash = body.Password is { Length: > 0 } p ? Passwords.Hash(p) : null }, tx);
                }
                string? lookup = null;
                if (body.Pin is { Length: > 0 }) { Pins.Check(body.Pin); lookup = pins.Lookup(companyId, body.Pin); }
                await c.ExecuteAsync("insert into user_company (user_id, company_id, role_id, pin_lookup, limits) values (@id, @companyId, @RoleId, @lookup, cast(@limits as jsonb))",
                    new { id, companyId, body.RoleId, lookup, limits = Permissions.CleanUserLimits(body.Limits) }, tx);
                await SetBranchesAsync(c, tx, id, companyId, body.BranchIds ?? []);
                if (body.IsAdmin == true) await SetAdminAsync(c, tx, scope, id, existing?.IsAdmin ?? false, true);
                await Audit.RecordAsync(c, tx, companyId, null, scope.UserId, "user", id.ToString(), "added", $"User {username} added",
                    Audit.Created(("Name", body.DisplayName.Trim()), ("Role", body.RoleId), ("Branches", (body.BranchIds ?? []).Length), ("PIN set", lookup is not null)));
                return id;
            });
            return Results.Ok(new { id });
        });

        api.MapPut("/companies/{companyId:guid}/users/{id:guid}", async (Guid companyId, Guid id, UserBody body, HttpContext http, Db db, Pins pins) =>
        {
            var scope = await http.ScopeAsync(db, companyId);
            scope.Require("users.manage");
            if (string.IsNullOrWhiteSpace(body.DisplayName)) throw new DomainException("Enter the user's name.");
            await db.Platform(async (c, tx) =>
            {
                var old = await c.QuerySingleOrDefaultAsync<UserRow>("""
                    select u.id, u.username, u.display_name, u.is_active, u.is_admin, uc.role_id, uc.pin_lookup is not null as has_pin
                    from user_company uc join app_user u on u.id = uc.user_id where uc.user_id = @id and uc.company_id = @companyId for update of uc
                    """, new { id, companyId }, tx) ?? throw new NotFoundException("User not found in this company.");
                if (old.IsAdmin && !scope.IsAdmin) throw new ForbiddenException("Only administrators can change an administrator.");
                if (id == scope.UserId && body.IsActive is false) throw new DomainException("You can't switch yourself off.");
                if (old.IsAdmin && old.IsActive && body.IsActive is false && await OtherAdminsAsync(c, tx, id) == 0)
                    throw new DomainException("This is the last administrator: make someone else an administrator first.");
                if (body.IsAdmin is { } admin && admin != old.IsAdmin) await SetAdminAsync(c, tx, scope, id, old.IsAdmin, admin);
                await CheckRoleAndBranchesAsync(c, tx, companyId, body);
                if (body.Password is { Length: > 0 }) Passwords.Check(body.Password, old.Username);
                await c.ExecuteAsync("""
                    update app_user set display_name = @name, is_active = @active,
                      password_hash = coalesce(@hash, password_hash), failed_logins = case when @active then 0 else failed_logins end,
                      -- A password an administrator gives someone else is changed by its owner at the next sign-in.
                      must_change_password = case when @hash is not null and @id <> @me then true else must_change_password end,
                      locked_until = case when @active then null else locked_until end
                    where id = @id
                    """, new { id, name = body.DisplayName.Trim(), active = body.IsActive ?? old.IsActive, me = scope.UserId,
                               hash = body.Password is { Length: > 0 } p ? Passwords.Hash(p) : null }, tx);
                string? lookup = null;
                if (body.Pin is { Length: > 0 }) { Pins.Check(body.Pin); lookup = pins.Lookup(companyId, body.Pin); }
                await c.ExecuteAsync("""
                    update user_company set role_id = @RoleId,
                      pin_lookup = case when @clear then null else coalesce(@lookup, pin_lookup) end,
                      limits = coalesce(cast(@limits as jsonb), limits)
                    where user_id = @id and company_id = @companyId
                    """, new { id, companyId, body.RoleId, lookup, clear = body.ClearPin == true,
                               limits = body.Limits is null ? null : Permissions.CleanUserLimits(body.Limits) }, tx);
                await SetBranchesAsync(c, tx, id, companyId, body.BranchIds ?? []);
                await Audit.RecordAsync(c, tx, companyId, null, scope.UserId, "user", id.ToString(), "changed", $"User {old.Username} changed",
                [
                    new("Name", old.DisplayName, body.DisplayName.Trim()), new("Active", old.IsActive, body.IsActive ?? old.IsActive),
                    new("Role", old.RoleId, body.RoleId),
                    new("PIN", old.HasPin ? "set" : "none", body.ClearPin == true ? "none" : lookup is not null ? "changed" : old.HasPin ? "set" : "none"),
                    new("Password", null, body.Password is { Length: > 0 } ? "changed" : null),
                    new("Own limits", null, body.Limits is null ? null : Permissions.CleanUserLimits(body.Limits)),
                ]);
                return 0;
            });
            return Results.Ok(new { id });
        });

        api.MapDelete("/companies/{companyId:guid}/users/{id:guid}", async (Guid companyId, Guid id, HttpContext http, Db db) =>
        {
            var scope = await http.ScopeAsync(db, companyId);
            scope.Require("users.manage");
            if (id == scope.UserId) throw new DomainException("You can't remove yourself from the company.");
            await db.Platform(async (c, tx) =>
            {
                await c.ExecuteAsync("delete from user_branch ub using branch b where ub.branch_id = b.id and b.company_id = @companyId and ub.user_id = @id", new { id, companyId }, tx);
                if (await c.ExecuteAsync("delete from user_company where user_id = @id and company_id = @companyId", new { id, companyId }, tx) == 0)
                    throw new NotFoundException("User not found in this company.");
                await Audit.RecordAsync(c, tx, companyId, null, scope.UserId, "user", id.ToString(), "removed", "User removed from the company");
                return 0;
            });
            return Results.Ok(new { id });
        });

        api.MapGet("/companies/{companyId:guid}/roles", async (Guid companyId, HttpContext http, Db db) =>
        {
            (await http.ScopeAsync(db, companyId)).Require("users.manage");
            return await db.Company(companyId, async (c, tx) => (await c.QueryAsync<RoleRow>("""
                select r.id, r.name, r.permissions, r.limits::text as limits,
                       (select count(*) from user_company uc where uc.role_id = r.id)::int as users
                from role r order by r.name
                """, transaction: tx)).Select(r => new { r.Id, r.Name, r.Permissions, limits = JsonDocument.Parse(r.Limits).RootElement, r.Users }).ToList());
        });

        api.MapPost("/companies/{companyId:guid}/roles", async (Guid companyId, RoleBody body, HttpContext http, Db db) =>
        {
            var scope = await http.ScopeAsync(db, companyId);
            scope.Require("users.manage");
            if (string.IsNullOrWhiteSpace(body.Name)) throw new DomainException("Enter the role's name.");
            var perms = Permissions.Clean(body.Permissions);
            var limits = Permissions.CleanLimits(body.Limits);
            var id = await db.Company(companyId, async (c, tx) =>
            {
                var id = await c.ExecuteScalarAsync<Guid>("insert into role (company_id, name, permissions, limits) values (@companyId, @name, @perms, cast(@limits as jsonb)) returning id",
                    new { companyId, name = body.Name.Trim(), perms, limits }, tx);
                await Audit.RecordAsync(c, tx, companyId, null, scope.UserId, "role", id.ToString(), "created", $"Role {body.Name.Trim()} created",
                    Audit.Created(("Permissions", perms), ("Limits", limits)));
                return id;
            });
            return Results.Ok(new { id });
        });

        api.MapPut("/companies/{companyId:guid}/roles/{id:guid}", async (Guid companyId, Guid id, RoleBody body, HttpContext http, Db db) =>
        {
            var scope = await http.ScopeAsync(db, companyId);
            scope.Require("users.manage");
            if (string.IsNullOrWhiteSpace(body.Name)) throw new DomainException("Enter the role's name.");
            var perms = Permissions.Clean(body.Permissions);
            var limits = Permissions.CleanLimits(body.Limits);
            await db.Company(companyId, async (c, tx) =>
            {
                var old = await c.QuerySingleOrDefaultAsync<RoleRow>("select id, name, permissions, limits::text as limits from role where id = @id for update", new { id }, tx)
                          ?? throw new NotFoundException("Role not found.");
                await c.ExecuteAsync("update role set name = @name, permissions = @perms, limits = cast(@limits as jsonb) where id = @id",
                    new { id, name = body.Name.Trim(), perms, limits }, tx);
                await Audit.RecordAsync(c, tx, companyId, null, scope.UserId, "role", id.ToString(), "changed", $"Role {old.Name} changed",
                    [new("Name", old.Name, body.Name.Trim()), new("Permissions", old.Permissions, perms), new("Limits", old.Limits, limits)]);
                return 0;
            });
            return Results.Ok(new { id });
        });
    }

    private static async Task CheckRoleAndBranchesAsync(NpgsqlConnection c, NpgsqlTransaction tx, Guid companyId, UserBody body)
    {
        if (!await c.ExecuteScalarAsync<bool>("select exists (select 1 from role where id = @RoleId and company_id = @companyId)", new { body.RoleId, companyId }, tx))
            throw new DomainException("Choose a role of this company.");
        var ids = body.BranchIds ?? [];
        var found = await c.ExecuteScalarAsync<int>("select count(*) from branch where id = any(@ids) and company_id = @companyId", new { ids, companyId }, tx);
        if (found != ids.Distinct().Count()) throw new DomainException("A chosen branch doesn't belong to this company.");
    }

    private static async Task SetBranchesAsync(NpgsqlConnection c, NpgsqlTransaction tx, Guid userId, Guid companyId, Guid[] branchIds)
    {
        await c.ExecuteAsync("delete from user_branch ub using branch b where ub.branch_id = b.id and b.company_id = @companyId and ub.user_id = @userId",
            new { userId, companyId }, tx);
        await c.ExecuteAsync("insert into user_branch (user_id, branch_id) select @userId, unnest(@ids) on conflict do nothing",
            new { userId, ids = branchIds.Distinct().ToArray() }, tx);
    }

    /// <summary>Active administrators other than this user.</summary>
    private static Task<int> OtherAdminsAsync(NpgsqlConnection c, NpgsqlTransaction tx, Guid id) =>
        c.ExecuteScalarAsync<int>("select count(*)::int from app_user where is_admin and is_active and id <> @id", new { id }, tx);

    /// <summary>
    /// Makes a user an administrator of One POS (every company) or takes it away: only an administrator does it, never for themselves,
    /// and never the last active administrator. Recorded in the audit log.
    /// </summary>
    private static async Task SetAdminAsync(NpgsqlConnection c, NpgsqlTransaction tx, Scope scope, Guid id, bool was, bool admin)
    {
        if (!scope.IsAdmin) throw new ForbiddenException("Only an administrator can make someone an administrator.");
        if (!admin && id == scope.UserId) throw new DomainException("You can't take administrator away from yourself.");
        if (!admin && await OtherAdminsAsync(c, tx, id) == 0) throw new DomainException("This is the last administrator: make someone else an administrator first.");
        await c.ExecuteAsync("update app_user set is_admin = @admin where id = @id", new { id, admin }, tx);
        var name = await c.ExecuteScalarAsync<string>("select username from app_user where id = @id", new { id }, tx);
        await Audit.RecordAsync(c, tx, null, null, scope.UserId, "user", id.ToString(), admin ? "admin_on" : "admin_off",
            admin ? $"{name} made an administrator" : $"{name} is no longer an administrator", [new("Administrator", was, admin)]);
    }
}
