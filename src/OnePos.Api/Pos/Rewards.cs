using System.Security.Cryptography;
using Dapper;
using Npgsql;
using OnePos.Api.Data;
using OnePos.Api.Platform;

namespace OnePos.Api.Pos;

/// <summary>
/// Gift vouchers and loyalty points (REQ CUS-02, CUS-03).
/// Vouchers: a code and a balance; paying by voucher takes from it (part payments too); a refund can be given as a new voucher.
/// Loyalty: a customer on a paid order earns points at the company's rate (on what wasn't paid with points); points pay at the
/// company's value per point once the customer has the minimum; a refund takes back that share of the order's points.
/// </summary>
public static class Rewards
{
    public sealed record IssueBody(decimal Value, string Reason, DateOnly? ExpiresOn, Guid? CustomerId, string? Note);
    public sealed record SettingsBody(bool VouchersEnabled, bool LoyaltyEnabled, decimal PointsPerUnit, decimal PointValue, int MinRedeem);

    public sealed class VoucherRow
    {
        public Guid Id { get; set; }
        public string Code { get; set; } = "";
        public decimal InitialValue { get; set; }
        public decimal Balance { get; set; }
        public string Reason { get; set; } = "";
        public string Status { get; set; } = "";
        public DateOnly? ExpiresOn { get; set; }
        public Guid? CustomerId { get; set; }
        public string? CustomerName { get; set; }
        public string? Note { get; set; }
        public string? IssuedByName { get; set; }
        public string? BranchCode { get; set; }
        public DateTime IssuedAt { get; set; }
    }

    private const string VoucherSql = """
        select v.*, c.name as customer_name, u.display_name as issued_by_name, b.code as branch_code
        from voucher v left join customer c on c.id = v.customer_id join app_user u on u.id = v.issued_by left join branch b on b.id = v.issued_branch
        """;

    // No 0/O, 1/I/L: a code is read out over the counter and typed in.
    private const string Alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

    private static string NewCode()
    {
        Span<char> s = stackalloc char[9];
        for (var i = 0; i < 9; i++) s[i] = i == 4 ? '-' : Alphabet[RandomNumberGenerator.GetInt32(Alphabet.Length)];
        return new string(s);
    }

    private static string Clean(string? code) => new string((code ?? "").Trim().ToUpperInvariant().Where(ch => char.IsLetterOrDigit(ch) || ch == '-').ToArray());

    /// <summary>Issues a voucher (a goodwill gesture, a promotion, a sale, or a refund as store credit); returns it with its new code.</summary>
    public static async Task<VoucherRow> IssueAsync(NpgsqlConnection c, NpgsqlTransaction tx, Guid companyId, Guid? branchId, Guid userId,
        decimal value, string reason, DateOnly? expiresOn, Guid? customerId, string? note, Guid? orderId = null)
    {
        if (!await c.ExecuteScalarAsync<bool>("select vouchers_enabled from company where id = @companyId", new { companyId }, tx))
            throw new DomainException("Vouchers aren't switched on for this company (an administrator does it under Companies & branches).");
        if (value <= 0) throw new DomainException("A voucher is worth more than zero.");
        if (value > 100_000) throw new DomainException("A voucher is worth at most 100,000.");
        for (var attempt = 0; ; attempt++)
        {
            var code = NewCode();
            var id = await c.ExecuteScalarAsync<Guid?>("""
                insert into voucher (company_id, code, initial_value, balance, reason, expires_on, customer_id, note, issued_branch, issued_by)
                values (@companyId, @code, @value, @value, @reason, @expiresOn, @customerId, @note, @branchId, @userId)
                on conflict (company_id, code) do nothing returning id
                """, new { companyId, code, value = Money.Round(value), reason, expiresOn, customerId, note, branchId, userId }, tx);
            if (id is null) { if (attempt > 5) throw new DomainException("Couldn't make a voucher code; try again."); continue; }
            await c.ExecuteAsync("""
                insert into voucher_move (company_id, voucher_id, kind, amount, order_id, branch_id, by_user, note) values (@companyId, @id, 'issue', @value, @orderId, @branchId, @userId, @reason)
                """, new { companyId, id, value = Money.Round(value), orderId, branchId, userId, reason }, tx);
            await Audit.RecordAsync(c, tx, companyId, branchId, userId, "voucher", id.ToString(), "issued", $"Voucher {code} issued for {value:N2} ({reason})", note: note);
            return await c.QuerySingleAsync<VoucherRow>($"{VoucherSql} where v.id = @id", new { id }, tx);
        }
    }

    /// <summary>Takes a payment from a voucher: it must be active, in date and have enough left. Returns the voucher.</summary>
    public static async Task<Guid> RedeemAsync(NpgsqlConnection c, NpgsqlTransaction tx, Scope scope, string? code, decimal amount, Orders.OrderRow o)
    {
        if (!await c.ExecuteScalarAsync<bool>("select vouchers_enabled from company where id = @CompanyId", new { o.CompanyId }, tx))
            throw new DomainException("Vouchers aren't in use at this company.");
        var clean = Clean(code);
        var v = await c.QuerySingleOrDefaultAsync<VoucherRow>("select * from voucher where code = @clean for update", new { clean }, tx)
                ?? throw new DomainException($"No voucher {clean}. Check the code.");
        if (v.Status != "active") throw new DomainException($"Voucher {v.Code} was cancelled.");
        var today = await Days.DateAsync(c, tx, o.BranchId);
        if (v.ExpiresOn is { } e && e < today) throw new DomainException($"Voucher {v.Code} expired on {e:dd MMM yyyy}.");
        if (v.Balance <= 0) throw new DomainException($"Voucher {v.Code} has been used up.");
        if (amount > v.Balance) throw new DomainException($"Voucher {v.Code} has {v.Balance:N2} left. Pay that much by voucher and the rest another way.");
        await c.ExecuteAsync("update voucher set balance = balance - @amount where id = @Id", new { amount, v.Id }, tx);
        await c.ExecuteAsync("""
            insert into voucher_move (company_id, voucher_id, kind, amount, order_id, branch_id, by_user) values (@co, @Id, 'redeem', -@amount, @order, @b, @u)
            """, new { co = o.CompanyId, v.Id, amount, order = o.Id, b = o.BranchId, u = scope.UserId }, tx);
        return v.Id;
    }

    public sealed record LoyaltySettings(bool Enabled, decimal PointsPerUnit, decimal PointValue, int MinRedeem);

    public static Task<LoyaltySettings> LoyaltyAsync(NpgsqlConnection c, NpgsqlTransaction tx, Guid companyId) =>
        c.QuerySingleAsync<LoyaltySettings>("select loyalty_enabled as enabled, loyalty_points_per_unit as points_per_unit, loyalty_point_value as point_value, loyalty_min_redeem as min_redeem from company where id = @companyId", new { companyId }, tx);

    /// <summary>Points paying part of a bill: the order's customer must have enough (and at least the minimum). Returns the points used.</summary>
    public static async Task<int> RedeemPointsAsync(NpgsqlConnection c, NpgsqlTransaction tx, Scope scope, decimal amount, Orders.OrderRow o)
    {
        var s = await LoyaltyAsync(c, tx, o.CompanyId);
        if (!s.Enabled || s.PointValue <= 0) throw new DomainException("Loyalty points aren't in use.");
        var customer = await c.ExecuteScalarAsync<Guid?>("select customer_id from pos_order where id = @Id", new { o.Id }, tx)
                       ?? throw new DomainException("Attach the customer to the order to pay with their points.");
        var have = await c.ExecuteScalarAsync<int>("select points from customer where id = @customer for update", new { customer }, tx);
        var needed = (int)decimal.Ceiling(amount / s.PointValue);
        if (have < s.MinRedeem) throw new DomainException($"Points can be used from {s.MinRedeem:N0}; this customer has {have:N0}.");
        if (needed > have) throw new DomainException($"That needs {needed:N0} points; this customer has {have:N0} (worth {Money.Round(have * s.PointValue):N2}).");
        await c.ExecuteAsync("update customer set points = points - @needed where id = @customer", new { needed, customer }, tx);
        await c.ExecuteAsync("""
            insert into loyalty_move (company_id, customer_id, kind, points, order_id, branch_id, by_user) values (@co, @customer, 'redeem', -@needed, @order, @b, @u)
            """, new { co = o.CompanyId, customer, needed, order = o.Id, b = o.BranchId, u = scope.UserId }, tx);
        return needed;
    }

    /// <summary>A paid order's customer earns points on what wasn't paid with points (whole points, rounded down).</summary>
    public static async Task EarnAsync(NpgsqlConnection c, NpgsqlTransaction tx, Guid orderId, Guid userId)
    {
        var o = await c.QuerySingleAsync<(Guid CompanyId, Guid BranchId, Guid? CustomerId, decimal Total)>("select company_id, branch_id, customer_id, total from pos_order where id = @orderId", new { orderId }, tx);
        if (o.CustomerId is not { } customer) return;
        var s = await LoyaltyAsync(c, tx, o.CompanyId);
        if (!s.Enabled || s.PointsPerUnit <= 0) return;
        if (await c.ExecuteScalarAsync<bool>("select exists (select 1 from loyalty_move where order_id = @orderId and kind = 'earn')", new { orderId }, tx)) return;
        var byPoints = await c.ExecuteScalarAsync<decimal>("select coalesce(sum(amount), 0) from payment where order_id = @orderId and method = 'points' and kind = 'payment'", new { orderId }, tx);
        var points = (int)decimal.Floor((o.Total - byPoints) * s.PointsPerUnit);
        if (points <= 0) return;
        await c.ExecuteAsync("update customer set points = points + @points where id = @customer", new { points, customer }, tx);
        await c.ExecuteAsync("""
            insert into loyalty_move (company_id, customer_id, kind, points, order_id, branch_id, by_user) values (@co, @customer, 'earn', @points, @orderId, @b, @userId)
            """, new { co = o.CompanyId, customer, points, orderId, b = o.BranchId, userId }, tx);
    }

    /// <summary>
    /// A refund of part of an order: that share of the points it earned is taken back; refunded "by points" gives the points back.
    /// </summary>
    public static async Task RefundAsync(NpgsqlConnection c, NpgsqlTransaction tx, Orders.OrderRow o, Guid userId, string method, decimal total)
    {
        var customer = await c.ExecuteScalarAsync<Guid?>("select customer_id from pos_order where id = @Id", new { o.Id }, tx);
        if (customer is null)
        {
            if (method == "points") throw new DomainException("Refunding as points needs a customer on the order.");
            return;
        }
        if (method == "points" && !(await LoyaltyAsync(c, tx, o.CompanyId)).Enabled) throw new DomainException("Loyalty points aren't switched on for this company.");
        var earned = await c.ExecuteScalarAsync<int>("select coalesce(sum(points), 0) from loyalty_move where order_id = @Id and kind = 'earn'", new { o.Id }, tx);
        var reversed = await c.ExecuteScalarAsync<int>("select coalesce(-sum(points), 0) from loyalty_move where order_id = @Id and kind = 'reverse'", new { o.Id }, tx);
        var back = o.Total <= 0 ? 0 : Math.Min(earned - reversed, (int)decimal.Floor(earned * total / o.Total));
        if (back > 0)
        {
            await c.ExecuteAsync("update customer set points = points - @back where id = @customer", new { back, customer }, tx);
            await c.ExecuteAsync("insert into loyalty_move (company_id, customer_id, kind, points, order_id, branch_id, by_user) values (@co, @customer, 'reverse', -@back, @Id, @b, @userId)",
                new { co = o.CompanyId, customer, back, o.Id, b = o.BranchId, userId }, tx);
        }
        if (method == "points")
        {
            var s = await LoyaltyAsync(c, tx, o.CompanyId);
            if (s.PointValue <= 0) throw new DomainException("Loyalty points aren't in use.");
            var give = (int)decimal.Ceiling(total / s.PointValue);
            await c.ExecuteAsync("update customer set points = points + @give where id = @customer", new { give, customer }, tx);
            await c.ExecuteAsync("insert into loyalty_move (company_id, customer_id, kind, points, order_id, branch_id, by_user) values (@co, @customer, 'refund', @give, @Id, @b, @userId)",
                new { co = o.CompanyId, customer, give, o.Id, b = o.BranchId, userId }, tx);
        }
    }

    public static void Map(RouteGroupBuilder api)
    {
        // At the till: what a voucher code is worth now.
        api.MapGet("/vouchers/check", async (HttpContext http, Db db, string code) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("pos.sell");
            var clean = Clean(code);
            return await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var v = await c.QuerySingleOrDefaultAsync<VoucherRow>($"{VoucherSql} where v.code = @clean", new { clean }, tx) ?? throw new NotFoundException($"No voucher {clean}.");
                var today = await Days.DateAsync(c, tx, scope.Branch);
                var usable = v.Status == "active" && v.Balance > 0 && (v.ExpiresOn is null || v.ExpiresOn >= today);
                return new { v.Code, v.Balance, v.InitialValue, v.ExpiresOn, v.Status, usable, v.CustomerName };
            });
        });

        api.MapGet("/vouchers", async (HttpContext http, Db db, string? q) =>
        {
            var scope = await http.ScopeAsync(db);
            if (!scope.Can("day.manage")) scope.Require("reports.view");
            var term = string.IsNullOrWhiteSpace(q) ? null : q.Trim();
            return await db.Company(scope.CompanyId, (c, tx) => c.QueryAsync<VoucherRow>($"""
                {VoucherSql} where (@term is null or v.code ilike '%' || @term || '%' or c.name ilike '%' || @term || '%') order by v.issued_at desc limit 200
                """, new { term }, tx));
        });

        api.MapGet("/vouchers/{id:guid}", async (Guid id, HttpContext http, Db db) =>
        {
            var scope = await http.ScopeAsync(db);
            if (!scope.Can("day.manage")) scope.Require("reports.view");
            return await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var v = await c.QuerySingleOrDefaultAsync<VoucherRow>($"{VoucherSql} where v.id = @id", new { id }, tx) ?? throw new NotFoundException("Voucher not found.");
                var moves = await c.QueryAsync<(string Kind, decimal Amount, DateTime At, string By, int? OrderNumber, string? Branch, string? Note)>("""
                    select m.kind, m.amount, m.at, u.display_name, o.number, b.code, m.note from voucher_move m join app_user u on u.id = m.by_user
                    left join pos_order o on o.id = m.order_id left join branch b on b.id = m.branch_id where m.voucher_id = @id order by m.at
                    """, new { id }, tx);
                return new { voucher = v, moves = moves.Select(m => new { m.Kind, m.Amount, m.At, by = m.By, m.OrderNumber, m.Branch, m.Note }) };
            });
        });

        // Managers issue vouchers (goodwill, promotion, sold outside the till); refunds make their own.
        api.MapPost("/vouchers", async (IssueBody body, HttpContext http, Db db) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("day.manage");
            var reason = (body.Reason ?? "").Trim().ToLowerInvariant();
            if (reason is not ("goodwill" or "promotion" or "sold")) throw new DomainException("A voucher is a goodwill gesture, a promotion, or sold.");
            return await db.Company(scope.CompanyId, async (c, tx) =>
            {
                if (body.ExpiresOn is { } e && e < await Days.DateAsync(c, tx, scope.Branch)) throw new DomainException("The expiry date has passed.");
                return await IssueAsync(c, tx, scope.CompanyId, scope.BranchId, scope.UserId, body.Value, reason, body.ExpiresOn, body.CustomerId,
                    string.IsNullOrWhiteSpace(body.Note) ? null : body.Note.Trim());
            });
        });

        api.MapPost("/vouchers/{id:guid}/cancel", async (Guid id, HttpContext http, Db db) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("day.manage");
            return await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var v = await c.QuerySingleOrDefaultAsync<VoucherRow>("select * from voucher where id = @id for update", new { id }, tx) ?? throw new NotFoundException("Voucher not found.");
                if (v.Status == "cancelled") throw new DomainException("Already cancelled.");
                await c.ExecuteAsync("update voucher set status = 'cancelled', balance = 0 where id = @id", new { id }, tx);
                await c.ExecuteAsync("insert into voucher_move (company_id, voucher_id, kind, amount, branch_id, by_user) values (@co, @id, 'cancel', -@b, @br, @u)",
                    new { co = scope.CompanyId, id, b = v.Balance, br = scope.BranchId, u = scope.UserId }, tx);
                await Audit.RecordAsync(c, tx, scope.CompanyId, scope.BranchId, scope.UserId, "voucher", id.ToString(), "cancelled", $"Voucher {v.Code} cancelled ({v.Balance:N2} left)");
                return await c.QuerySingleAsync<VoucherRow>($"{VoucherSql} where v.id = @id", new { id }, tx);
            });
        });

        // Vouchers on/off and the loyalty rules of the company (switched on by an administrator).
        api.MapGet("/rewards", async (HttpContext http, Db db) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("pos.sell");
            return await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var s = await LoyaltyAsync(c, tx, scope.CompanyId);
                var vouchers = await c.ExecuteScalarAsync<bool>("select vouchers_enabled from company where id = @id", new { id = scope.CompanyId }, tx);
                var members = await c.QuerySingleAsync<(int Customers, long Points)>("select count(*) filter (where points > 0)::int, coalesce(sum(points), 0)::bigint from customer", transaction: tx);
                var open = await c.QuerySingleAsync<(int Count, decimal Balance)>("select count(*)::int, coalesce(sum(balance), 0) from voucher where status = 'active' and balance > 0", transaction: tx);
                return new
                {
                    vouchersEnabled = vouchers, loyaltyEnabled = s.Enabled, s.PointsPerUnit, s.PointValue, s.MinRedeem,
                    members = members.Customers, outstanding = members.Points, liability = Money.Round(members.Points * s.PointValue),
                    openVouchers = open.Count, voucherBalance = open.Balance,
                };
            });
        });

        api.MapPut("/companies/{companyId:guid}/rewards", async (Guid companyId, SettingsBody body, HttpContext http, Db db, Live live) =>
        {
            var scope = await http.ScopeAsync(db, companyId);
            if (!scope.IsAdmin) throw new ForbiddenException("Only administrators switch vouchers and loyalty on or off.");
            if (body.PointsPerUnit is < 0 or > 100) throw new DomainException("Points per 1.00 spent: 0 to 100.");
            if (body.PointValue is < 0 or > 100) throw new DomainException("A point is worth 0 to 100.");
            if (body.MinRedeem is < 0 or > 1_000_000) throw new DomainException("The minimum to use points is 0 to 1,000,000.");
            await db.Company(companyId, async (c, tx) =>
            {
                var old = await LoyaltyAsync(c, tx, companyId);
                var oldVouchers = await c.ExecuteScalarAsync<bool>("select vouchers_enabled from company where id = @companyId", new { companyId }, tx);
                await c.ExecuteAsync("""
                    update company set vouchers_enabled = @VouchersEnabled, loyalty_enabled = @LoyaltyEnabled, loyalty_points_per_unit = @PointsPerUnit,
                      loyalty_point_value = @PointValue, loyalty_min_redeem = @MinRedeem where id = @companyId
                    """, new { body.VouchersEnabled, body.LoyaltyEnabled, body.PointsPerUnit, body.PointValue, body.MinRedeem, companyId }, tx);
                await Audit.RecordAsync(c, tx, companyId, null, scope.UserId, "company", companyId.ToString(), "rewards", "Vouchers and loyalty changed",
                    [new("Vouchers", oldVouchers, body.VouchersEnabled), new("Loyalty", old.Enabled, body.LoyaltyEnabled), new("Points per 1.00", old.PointsPerUnit, body.PointsPerUnit),
                     new("Point value", old.PointValue, body.PointValue), new("Minimum", old.MinRedeem, body.MinRedeem)]);
                return 0;
            });
            await live.ToCompany(companyId, "branches.changed");
            return Results.Ok(new { ok = true });
        });
    }
}
