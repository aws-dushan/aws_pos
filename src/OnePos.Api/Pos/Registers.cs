using Dapper;
using OnePos.Api.Data;
using OnePos.Api.Platform;

namespace OnePos.Api.Pos;

/// <summary>The tills (registers) of a branch. A browser set up as a till points at one; its sales show as "register sales".</summary>
public static class Registers
{
    /// <summary>SharedDrawer: several cashiers share the till's open shift (one drawer count). Not sent: unchanged.</summary>
    public sealed record Body(string Code, string Name, bool? IsActive, bool? SharedDrawer = null);

    public sealed class Row
    {
        public Guid Id { get; set; }
        public Guid BranchId { get; set; }
        public string Code { get; set; } = "";
        public string Name { get; set; } = "";
        public bool IsActive { get; set; }
        public bool SharedDrawer { get; set; }
    }

    public static void Map(RouteGroupBuilder api)
    {
        api.MapGet("/branches/{branchId:guid}/registers", async (Guid branchId, HttpContext http, Db db) =>
        {
            var companyId = await CompanyOfAsync(db, branchId);
            await http.ScopeAsync(db, companyId);
            return await db.Company(companyId, async (c, tx) => (await c.QueryAsync<Row>(
                "select * from register where branch_id = @branchId order by code", new { branchId }, tx)).ToList());
        });

        api.MapPost("/branches/{branchId:guid}/registers", async (Guid branchId, Body body, HttpContext http, Db db, Live live) =>
        {
            var companyId = await CompanyOfAsync(db, branchId);
            var scope = await http.ScopeAsync(db, companyId);
            scope.Require("branch.manage");
            var (code, name) = Clean(body);
            var id = await db.Company(companyId, async (c, tx) =>
            {
                var id = await c.ExecuteScalarAsync<Guid>("insert into register (company_id, branch_id, code, name) values (@companyId, @branchId, @code, @name) returning id",
                    new { companyId, branchId, code, name }, tx);
                await Audit.RecordAsync(c, tx, companyId, branchId, scope.UserId, "register", id.ToString(), "created", $"Register {code} created", Audit.Created(("Name", name)));
                return id;
            });
            await live.ToBranch(branchId, "registers.changed");
            return Results.Ok(new { id });
        });

        api.MapPut("/registers/{id:guid}", async (Guid id, Body body, HttpContext http, Db db, Live live) =>
        {
            var reg = await db.Platform((c, tx) => c.QuerySingleOrDefaultAsync<(Guid CompanyId, Guid BranchId)>("select company_id, branch_id from register where id = @id", new { id }, tx));
            if (reg.CompanyId == Guid.Empty) throw new NotFoundException("Register not found.");
            var scope = await http.ScopeAsync(db, reg.CompanyId);
            scope.Require("branch.manage");
            var (code, name) = Clean(body);
            await db.Company(reg.CompanyId, async (c, tx) =>
            {
                var old = await c.QuerySingleAsync<Row>("select * from register where id = @id for update", new { id }, tx);
                await c.ExecuteAsync("update register set code = @code, name = @name, is_active = @active, shared_drawer = coalesce(@shared, shared_drawer) where id = @id",
                    new { id, code, name, active = body.IsActive ?? old.IsActive, shared = body.SharedDrawer }, tx);
                await Audit.RecordAsync(c, tx, reg.CompanyId, reg.BranchId, scope.UserId, "register", id.ToString(), "changed", $"Register {old.Code} changed",
                    [new("Code", old.Code, code), new("Name", old.Name, name), new("Active", old.IsActive, body.IsActive ?? old.IsActive)]);
                return 0;
            });
            await live.ToBranch(reg.BranchId, "registers.changed");
            return Results.Ok(new { id });
        });
    }

    public static async Task<Guid> CompanyOfAsync(Db db, Guid branchId) =>
        await db.Platform((c, tx) => c.ExecuteScalarAsync<Guid?>("select company_id from branch where id = @branchId", new { branchId }, tx))
        ?? throw new NotFoundException("Branch not found.");

    private static (string Code, string Name) Clean(Body b)
    {
        var code = (b.Code ?? "").Trim().ToUpperInvariant();
        if (code.Length is < 1 or > 10 || !code.All(ch => char.IsAsciiLetterOrDigit(ch) || ch == '-')) throw new DomainException("A register code is 1–10 capitals, digits or dashes (e.g. T1).");
        if (string.IsNullOrWhiteSpace(b.Name)) throw new DomainException("Enter the register's name (e.g. Till 1).");
        return (code, b.Name.Trim());
    }
}
