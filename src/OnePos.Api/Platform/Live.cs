using Dapper;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;
using OnePos.Api.Data;

namespace OnePos.Api.Platform;

/// <summary>
/// Live updates (REQ NFR-02): every till, kitchen screen and dashboard of a branch joins that branch's group and hears
/// what changed (orders, tables, tickets, devices, settings) within a second. Clients re-read what they show; events carry ids, not data.
/// </summary>
[Authorize]
public sealed class LiveHub(Db db) : Hub
{
    public static string BranchGroup(Guid branchId) => $"branch:{branchId:N}";
    public static string CompanyGroup(Guid companyId) => $"company:{companyId:N}";

    /// <summary>Joins the branch's group after checking access (same rules as the API).</summary>
    public async Task JoinBranch(Guid branchId)
    {
        var http = Context.GetHttpContext() ?? throw new HubException("No connection.");
        var user = http.CurrentUser();
        if (user.TillBranchId is { } tb && tb != branchId) throw new HubException("This till belongs to another branch.");
        var companyId = await db.Platform((c, tx) => c.ExecuteScalarAsync<Guid?>("""
            select b.company_id from branch b
            where b.id = @branchId and (@isAdmin or exists (select 1 from user_branch ub where ub.branch_id = b.id and ub.user_id = @userId))
            """, new { branchId, userId = user.Id, isAdmin = user.IsAdmin }, tx))
            ?? throw new HubException("You do not have access to this branch.");
        await Groups.AddToGroupAsync(Context.ConnectionId, BranchGroup(branchId));
        await Groups.AddToGroupAsync(Context.ConnectionId, CompanyGroup(companyId));
    }

    public Task LeaveBranch(Guid branchId) => Groups.RemoveFromGroupAsync(Context.ConnectionId, BranchGroup(branchId));
}

/// <summary>Sends live events. Call after the transaction commits.</summary>
public sealed class Live(IHubContext<LiveHub> hub)
{
    public Task ToBranch(Guid branchId, string kind, object? data = null) =>
        hub.Clients.Group(LiveHub.BranchGroup(branchId)).SendAsync("event", new { kind, data, at = DateTime.UtcNow });

    public Task ToCompany(Guid companyId, string kind, object? data = null) =>
        hub.Clients.Group(LiveHub.CompanyGroup(companyId)).SendAsync("event", new { kind, data, at = DateTime.UtcNow });
}
