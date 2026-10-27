using System.Security.Claims;
using Dapper;
using OnePos.Api.Data;

namespace OnePos.Api.Platform;

/// <summary>The signed-in user. A till session (PIN sign-in) is bound to one company and branch.</summary>
public sealed record CurrentUser(Guid Id, bool IsAdmin, Guid? TillCompanyId, Guid? TillBranchId, Guid? TillRegisterId);

/// <summary>The user's company and branch for this request, after access checks, with their role's permissions.</summary>
public sealed record Scope(Guid UserId, bool IsAdmin, Guid CompanyId, Guid? BranchId, HashSet<string> Perms, Guid? RegisterId = null, string Limits = "{}")
{
    public bool Can(string perm) => IsAdmin || Perms.Contains(perm);

    public void Require(string perm)
    {
        if (!Can(perm))
            throw new ForbiddenException($"Your role doesn't allow this ({Permissions.All.FirstOrDefault(p => p.Key == perm)?.Label ?? perm}).");
    }

    public Guid Branch => BranchId ?? throw new DomainException("Choose a branch first.");

    /// <summary>A limit of the user (their own, else their role's; e.g. maxDiscountPct); null = no limit. Administrators have no limits.</summary>
    public decimal? Limit(string key)
    {
        if (IsAdmin) return null;
        using var doc = System.Text.Json.JsonDocument.Parse(Limits);
        return doc.RootElement.TryGetProperty(key, out var v) && v.ValueKind == System.Text.Json.JsonValueKind.Number && v.TryGetDecimal(out var d) ? d : null;
    }
}

public static class RequestContext
{
    public const string CompanyHeader = "X-Company-Id";
    public const string BranchHeader = "X-Branch-Id";
    /// <summary>A back-office browser's register (picked to take payments there); a till session's register comes from its sign-in.</summary>
    public const string RegisterHeader = "X-Register-Id";
    public const string AdminClaim = "onepos:admin";
    public const string MustChangePasswordClaim = "onepos:mustchange";
    public const string TillCompanyClaim = "onepos:till-company";
    public const string TillBranchClaim = "onepos:till-branch";
    public const string TillRegisterClaim = "onepos:till-register";

    /// <summary>The session was signed in with a password someone else set: until it is changed, nothing else is allowed.</summary>
    public static bool MustChangePassword(HttpContext http) => http.User.HasClaim(MustChangePasswordClaim, "true");

    public static CurrentUser CurrentUser(this HttpContext http) => new(
        Guid.Parse(http.User.FindFirstValue(ClaimTypes.NameIdentifier) ?? throw new ForbiddenException("You are not signed in.")),
        http.User.HasClaim(AdminClaim, "true"),
        Guid.TryParse(http.User.FindFirstValue(TillCompanyClaim), out var tc) ? tc : null,
        Guid.TryParse(http.User.FindFirstValue(TillBranchClaim), out var tb) ? tb : null,
        Guid.TryParse(http.User.FindFirstValue(TillRegisterClaim), out var tr) ? tr : null);

    public static void RequireAdmin(this HttpContext http)
    {
        if (!http.CurrentUser().IsAdmin) throw new ForbiddenException("Only administrators can do this.");
    }

    /// <summary>
    /// The company (X-Company-Id) and branch (X-Branch-Id, optional) the request works in. A till session is fixed to its own
    /// company and branch. Admins may open any company; others only companies they belong to, and only their branches.
    /// </summary>
    public static async Task<Scope> ScopeAsync(this HttpContext http, Db db, Guid? company = null)
    {
        var user = http.CurrentUser();
        Guid companyId;
        Guid? branchId;
        if (user.TillCompanyId is { } tc)
        {
            if (company is { } want && want != tc) throw new ForbiddenException("This till belongs to another company.");
            companyId = tc;
            branchId = user.TillBranchId;
        }
        else if (company is { } named)
        {
            companyId = named;
            branchId = null;
        }
        else
        {
            if (!Guid.TryParse(http.Request.Headers[CompanyHeader].ToString(), out companyId)) throw new DomainException("Choose a company first.");
            branchId = Guid.TryParse(http.Request.Headers[BranchHeader].ToString(), out var b) ? b : null;
        }

        var registerId = user.TillCompanyId is not null ? user.TillRegisterId
            : branchId is not null && Guid.TryParse(http.Request.Headers[RegisterHeader].ToString(), out var r) ? r : (Guid?)null;
        return await LoadScopeAsync(db, user.Id, user.IsAdmin, companyId, branchId, registerId);
    }

    /// <summary>A user's scope in a company and branch (their role's permissions and limits), e.g. a manager approving at a till.</summary>
    public static async Task<Scope> LoadScopeAsync(Db db, Guid userId, bool isAdmin, Guid companyId, Guid? branchId, Guid? registerId = null)
    {
        // Administrator: the sign-in says so AND the user still is one (taken away, it ends at once, not at the next sign-in).
        isAdmin = isAdmin && await db.Platform((c, tx) => c.ExecuteScalarAsync<bool>("select coalesce((select is_admin and is_active from app_user where id = @userId), false)", new { userId }, tx));
        var row = await db.Platform((c, tx) => c.QuerySingleOrDefaultAsync<(bool Ok, string[]? Perms, bool BranchOk, string? Limits, bool RegisterOk)>("""
            select (co.is_active or @isAdmin) and (@isAdmin or uc.user_id is not null) as ok,
                   r.permissions as perms,
                   @branchId is null or exists (
                     select 1 from branch b where b.id = @branchId and b.company_id = co.id and (b.is_active or @isAdmin)
                       and (@isAdmin or exists (select 1 from user_branch ub where ub.user_id = @userId and ub.branch_id = b.id))) as branch_ok,
                   -- The role's limits, with the user's own over them (a null there: no limit for this user).
                   (coalesce(r.limits, '{}') || coalesce(uc.limits, '{}'))::text as limits,
                   cast(@registerId as uuid) is null or exists (select 1 from register g where g.id = @registerId and g.branch_id = @branchId and g.is_active) as register_ok
            from company co
            left join user_company uc on uc.company_id = co.id and uc.user_id = @userId
            left join role r on r.id = uc.role_id
            where co.id = @companyId
            """, new { companyId, branchId, userId, isAdmin, registerId }, tx));
        if (!row.Ok) throw new ForbiddenException("You do not have access to this company.");
        if (!row.BranchOk) throw new ForbiddenException("You do not have access to this branch.");
        // A register of another branch, or one switched off: as if none was picked (the screen asks again).
        return new Scope(userId, isAdmin, companyId, branchId, (row.Perms ?? []).ToHashSet(), row.RegisterOk ? registerId : null, row.Limits ?? "{}");
    }
}
