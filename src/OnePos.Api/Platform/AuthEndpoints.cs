using System.Collections.Concurrent;
using System.Security.Claims;
using Dapper;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using OnePos.Api.Data;

namespace OnePos.Api.Platform;

/// <summary>
/// Sign-in (REQ USR-01). Back office: username + password. Till: the branch's PIN pad, a PIN alone identifies the cashier
/// and the session is bound to that company and branch. Five wrong tries lock: the user (password) or the till's PIN pad
/// from that address (PIN) for a few minutes.
/// </summary>
public static class AuthEndpoints
{
    public sealed record LoginBody(string Username, string Password);
    public sealed record PinBody(Guid BranchId, string Pin, Guid? RegisterId);
    public sealed record PasswordBody(string Current, string Next);

    private sealed class UserRow
    {
        public Guid Id { get; set; }
        public string Username { get; set; } = "";
        public string DisplayName { get; set; } = "";
        public string? PasswordHash { get; set; }
        public bool IsAdmin { get; set; }
        public bool IsActive { get; set; }
        public int FailedLogins { get; set; }
        public DateTime? LockedUntil { get; set; }
        public bool MustChangePassword { get; set; }
    }

    /// <summary>Failed PIN tries per branch + address (in memory: a restart clears it, which is fine for a 5-minute lock).</summary>
    private static readonly ConcurrentDictionary<string, (int Count, DateTime Until)> PinFailures = new();

    public static void Map(RouteGroupBuilder api)
    {
        api.MapPost("/auth/login", async (LoginBody body, HttpContext http, Db db) =>
        {
            var username = (body.Username ?? "").Trim().ToLowerInvariant();
            var user = await db.Platform((c, tx) => c.QuerySingleOrDefaultAsync<UserRow>("select * from app_user where username = @username", new { username }, tx));
            if (user?.LockedUntil > DateTime.UtcNow) throw new DomainException("Too many wrong passwords. Try again in a few minutes.");
            var (ok, rehash) = Passwords.Verify(user?.PasswordHash, body.Password ?? "");
            if (user is null || !ok || !user.IsActive)
            {
                if (user is not null)
                    await db.Platform((c, tx) => c.ExecuteAsync("""
                        update app_user set failed_logins = failed_logins + 1,
                          locked_until = case when failed_logins + 1 >= 5 then now() + interval '15 minutes' end
                        where id = @id
                        """, new { user.Id }, tx));
                throw new DomainException(user is { IsActive: false } && ok ? "This user is switched off. Ask an administrator." : "Wrong username or password.");
            }
            await db.Platform(async (c, tx) =>
            {
                await c.ExecuteAsync("update app_user set failed_logins = 0, locked_until = null, password_hash = coalesce(@hash, password_hash) where id = @id",
                    new { user.Id, hash = rehash ? Passwords.Hash(body.Password!) : null }, tx);
                await Audit.RecordAsync(c, tx, null, null, user.Id, "session", null, "signed_in", "Signed in (back office)");
                return 0;
            });
            await SignInAsync(http, user.Id, user.DisplayName, user.IsAdmin, null, null, null, user.MustChangePassword);
            return Results.Ok(new { ok = true, mustChangePassword = user.MustChangePassword });
        }).AllowAnonymous();

        // What the till's PIN pad shows before anyone signs in: the branch and company names.
        api.MapGet("/auth/branch/{id:guid}", async (Guid id, Db db) =>
            await db.Platform((c, tx) => c.QuerySingleOrDefaultAsync<(Guid Id, string Name, string Code, string CompanyName)>("""
                select b.id, b.name, b.code, co.name as company_name from branch b join company co on co.id = b.company_id
                where b.id = @id and b.is_active and co.is_active
                """, new { id }, tx)) is { Id: var bid } b && bid != Guid.Empty
                ? Results.Ok(new { id = b.Id, name = b.Name, code = b.Code, companyName = b.CompanyName,
                    registers = await db.Platform(async (c, tx) => (await c.QueryAsync<(Guid Id, string Name)>(
                        "select id, name from register where branch_id = @id and is_active order by code", new { id }, tx)).Select(r => new { id = r.Id, name = r.Name }).ToList()) })
                : Results.NotFound(new { error = "This till's branch was not found. Ask a manager to set the till up again." })).AllowAnonymous();

        api.MapPost("/auth/pin", async (PinBody body, HttpContext http, Db db, Pins pins) =>
        {
            var slot = $"{body.BranchId:N}|{http.Connection.RemoteIpAddress}";
            if (PinFailures.TryGetValue(slot, out var f) && f.Count >= Pins.MaxFailures && f.Until > DateTime.UtcNow)
                throw new DomainException("Too many wrong PINs. The PIN pad is locked for a few minutes.");
            var branch = await db.Platform((c, tx) => c.QuerySingleOrDefaultAsync<(Guid CompanyId, bool Active)>("""
                select b.company_id, b.is_active and co.is_active from branch b join company co on co.id = b.company_id where b.id = @id
                """, new { id = body.BranchId }, tx));
            if (branch.CompanyId == Guid.Empty || !branch.Active) throw new DomainException("This till's branch is not active.");
            if (body.RegisterId is { } rid && !await db.Platform((c, tx) => c.ExecuteScalarAsync<bool>(
                    "select exists (select 1 from register where id = @rid and branch_id = @BranchId and is_active)", new { rid, body.BranchId }, tx)))
                throw new DomainException("This till's register was removed or switched off. Ask a manager to set the till up again.");
            var lookup = pins.Lookup(branch.CompanyId, body.Pin ?? "");
            var user = await db.Platform((c, tx) => c.QuerySingleOrDefaultAsync<UserRow>("""
                select u.* from user_company uc join app_user u on u.id = uc.user_id
                where uc.company_id = @companyId and uc.pin_lookup = @lookup and u.is_active
                  and exists (select 1 from user_branch ub where ub.user_id = u.id and ub.branch_id = @branchId)
                """, new { branch.CompanyId, lookup, body.BranchId }, tx));
            if (user is null)
            {
                PinFailures.AddOrUpdate(slot, _ => (1, DateTime.UtcNow.Add(Pins.Lockout)),
                    (_, old) => (old.Until < DateTime.UtcNow ? 1 : old.Count + 1, DateTime.UtcNow.Add(Pins.Lockout)));
                throw new DomainException("Wrong PIN, or this user doesn't work at this branch.");
            }
            PinFailures.TryRemove(slot, out _);
            await db.Platform(async (c, tx) =>
            {
                await Audit.RecordAsync(c, tx, branch.CompanyId, body.BranchId, user.Id, "session", null, "signed_in", "Signed in at the till (PIN)");
                return 0;
            });
            await SignInAsync(http, user.Id, user.DisplayName, user.IsAdmin, branch.CompanyId, body.BranchId, body.RegisterId);
            return Results.Ok(new { ok = true });
        }).AllowAnonymous();

        api.MapPost("/auth/logout", async (HttpContext http) =>
        {
            await http.SignOutAsync(CookieAuthenticationDefaults.AuthenticationScheme);
            return Results.Ok(new { ok = true });
        }).AllowAnonymous();

        api.MapPost("/me/password", async (PasswordBody body, HttpContext http, Db db) =>
        {
            var me = http.CurrentUser();
            await db.Platform(async (c, tx) =>
            {
                var user = await c.QuerySingleAsync<UserRow>("select * from app_user where id = @id", new { me.Id }, tx);
                if (!Passwords.Verify(user.PasswordHash, body.Current ?? "").Ok) throw new DomainException("The current password is wrong.");
                Passwords.Check(body.Next, user.Username);
                if (body.Next == body.Current) throw new DomainException("Choose a new password, not the current one.");
                await c.ExecuteAsync("update app_user set password_hash = @h, must_change_password = false where id = @id", new { h = Passwords.Hash(body.Next), me.Id }, tx);
                await Audit.RecordAsync(c, tx, null, null, me.Id, "user", me.Id.ToString(), "password_changed", "Changed own password");
                return 0;
            });
            // The session no longer carries "must change the password".
            if (RequestContext.MustChangePassword(http))
            {
                var user = await db.Platform((c, tx) => c.QuerySingleAsync<UserRow>("select * from app_user where id = @id", new { me.Id }, tx));
                await SignInAsync(http, user.Id, user.DisplayName, user.IsAdmin, me.TillCompanyId, me.TillBranchId, me.TillRegisterId);
            }
            return Results.Ok(new { ok = true });
        });

        // Who is signed in, and every company and branch they can open, with their permissions in each.
        api.MapGet("/me", async (HttpContext http, Db db) =>
        {
            var me = http.CurrentUser();
            return await db.Platform(async (c, tx) =>
            {
                var user = await c.QuerySingleOrDefaultAsync<UserRow>("select * from app_user where id = @id and is_active", new { me.Id }, tx)
                           ?? throw new ForbiddenException("You are not signed in.");
                var companies = (await c.QueryAsync<MeCompany>("""
                    select co.id, co.code, co.name, co.base_currency as currency, co.vat_rate, co.prices_include_vat, co.erp_connector, co.vouchers_enabled, co.loyalty_enabled,
                           r.name as role, coalesce(r.permissions, '{}') as permissions
                    from company co
                    left join user_company uc on uc.company_id = co.id and uc.user_id = @id
                    left join role r on r.id = uc.role_id
                    where (@isAdmin or uc.user_id is not null) and (co.is_active or @isAdmin)
                      and (@tillCompany is null or co.id = @tillCompany)
                    order by co.name
                    """, new { me.Id, isAdmin = user.IsAdmin, tillCompany = me.TillCompanyId }, tx)).ToList();
                var branches = (await c.QueryAsync<MeBranch>("""
                    select b.id, b.company_id, b.code, b.name, b.table_service, b.kitchen_enabled, b.returns_enabled, b.day_control, b.is_active,
                           b.marketing_approver_id is not null and b.marketing_account is not null and b.erp_location_code is not null
                             and (select co.erp_connector from company co where co.id = b.company_id) = 'facts' as marketing_enabled,
                           b.request_approver_id is not null and b.request_facts_user is not null and b.erp_location_code is not null
                             and (select co.erp_connector from company co where co.id = b.company_id) = 'facts' as requests_enabled
                    from branch b
                    where b.company_id = any(@companyIds) and (b.is_active or @isAdmin)
                      and (@isAdmin or exists (select 1 from user_branch ub where ub.branch_id = b.id and ub.user_id = @id))
                      and (@tillBranch is null or b.id = @tillBranch)
                    order by b.name
                    """, new { me.Id, isAdmin = user.IsAdmin, companyIds = companies.Select(x => x.Id).ToArray(), tillBranch = me.TillBranchId }, tx)).ToList();
                return new
                {
                    user = new { user.Id, user.Username, user.DisplayName, user.IsAdmin, user.MustChangePassword },
                    till = me.TillBranchId is { } tb ? new
                    {
                        companyId = me.TillCompanyId, branchId = tb, registerId = me.TillRegisterId,
                        registerName = me.TillRegisterId is { } rid ? await c.ExecuteScalarAsync<string?>("select name from register where id = @rid", new { rid }, tx) : null,
                    } : null,
                    companies = companies.Select(co => new
                    {
                        co.Id, co.Code, co.Name, co.Currency, co.VatRate, co.PricesIncludeVat, co.ErpConnector, co.VouchersEnabled, co.LoyaltyEnabled, co.Role,
                        permissions = user.IsAdmin ? Permissions.All.Select(p => p.Key).ToArray() : co.Permissions,
                        branches = branches.Where(b => b.CompanyId == co.Id).Select(b => new { b.Id, b.Code, b.Name, b.TableService, b.KitchenEnabled, b.ReturnsEnabled, b.DayControl, b.IsActive, b.MarketingEnabled, b.RequestsEnabled }),
                    }),
                };
            });
        });
    }

    private sealed class MeCompany
    {
        public bool VouchersEnabled { get; set; }
        public bool LoyaltyEnabled { get; set; }
        public Guid Id { get; set; }
        public string Code { get; set; } = "";
        public string Name { get; set; } = "";
        public string Currency { get; set; } = "";
        public decimal VatRate { get; set; }
        public bool PricesIncludeVat { get; set; }
        public string ErpConnector { get; set; } = "";
        public string? Role { get; set; }
        public string[] Permissions { get; set; } = [];
    }

    private sealed class MeBranch
    {
        public Guid Id { get; set; }
        public Guid CompanyId { get; set; }
        public string Code { get; set; } = "";
        public string Name { get; set; } = "";
        public bool TableService { get; set; }
        public bool KitchenEnabled { get; set; }
        public bool ReturnsEnabled { get; set; }
        public string DayControl { get; set; } = "";
        public bool IsActive { get; set; }
        /// <summary>Marketing give-aways on Stock: the branch has a marketing approver and expense account (Companies &amp; branches).</summary>
        public bool MarketingEnabled { get; set; }
        /// <summary>Stock requests (STR50) on Stock: the branch has a request approver with a FACTS username (Companies &amp; branches).</summary>
        public bool RequestsEnabled { get; set; }
    }

    private static Task SignInAsync(HttpContext http, Guid id, string name, bool isAdmin, Guid? tillCompany, Guid? tillBranch, Guid? tillRegister, bool mustChangePassword = false)
    {
        var claims = new List<Claim> { new(ClaimTypes.NameIdentifier, id.ToString()), new(ClaimTypes.Name, name) };
        if (isAdmin) claims.Add(new Claim(RequestContext.AdminClaim, "true"));
        if (mustChangePassword) claims.Add(new Claim(RequestContext.MustChangePasswordClaim, "true"));
        if (tillCompany is { } tc) claims.Add(new Claim(RequestContext.TillCompanyClaim, tc.ToString()));
        if (tillBranch is { } tb) claims.Add(new Claim(RequestContext.TillBranchClaim, tb.ToString()));
        if (tillRegister is { } tr) claims.Add(new Claim(RequestContext.TillRegisterClaim, tr.ToString()));
        var identity = new ClaimsIdentity(claims, CookieAuthenticationDefaults.AuthenticationScheme);
        return http.SignInAsync(CookieAuthenticationDefaults.AuthenticationScheme, new ClaimsPrincipal(identity));
    }

    /// <summary>The first administrator on an empty database (config Seed:*), as in AWS One.</summary>
    public static async Task SeedAdminAsync(Db db, IConfiguration config, ILogger logger)
    {
        // Usernames are kept lower case (sign-in lower-cases what is typed). The first password was given by whoever set the server
        // up, so its owner must change it at the first sign-in.
        var username = config["Seed:AdminUsername"]?.Trim().ToLowerInvariant();
        var password = config["Seed:AdminPassword"];
        if (string.IsNullOrEmpty(username) || string.IsNullOrEmpty(password)) return;
        var created = await db.Platform(async (c, tx) =>
        {
            if (await c.ExecuteScalarAsync<bool>("select exists (select 1 from app_user)", transaction: tx)) return false;
            await c.ExecuteAsync("insert into app_user (username, display_name, password_hash, is_admin, must_change_password) values (@username, 'Administrator', @hash, true, true)",
                new { username, hash = Passwords.Hash(password) }, tx);
            return true;
        });
        if (created) logger.LogWarning("Created first administrator '{User}'.", username);
    }
}
