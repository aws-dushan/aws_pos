using Dapper;
using Npgsql;
using OnePos.Api.Data;
using OnePos.Api.Platform;

namespace OnePos.Api.Pos;

/// <summary>
/// Customers (REQ CUS-01 … CUS-04), optional on every order. The register finds one by phone (or name) and attaches it; a paid
/// order with a phone number nobody has yet and a name creates the customer. Visits and spend are their paid orders. Customers are
/// per branch: a branch only finds, lists and changes its own (the same phone can be a customer at two branches).
/// </summary>
public static class Customers
{
    public sealed record Body(string Name, string? Phone, string? Email, string? Address, string? Notes, bool? IsActive);
    public sealed record AttachBody(Guid? CustomerId);
    /// <summary>A customer's pre-approved discount: Pct null takes it off.</summary>
    public sealed record PreapprovedBody(decimal? Pct, string? Reason, DateOnly? Until);

    public static readonly Dictionary<string, string> PreapprovedReasons = new()
    {
        ["complimentary"] = "Complimentary", ["owner"] = "Owner", ["guest"] = "Owner guest", ["staff"] = "Staff meal", ["company"] = "Company VIP",
    };

    public sealed class Row
    {
        public Guid Id { get; set; }
        public string Name { get; set; } = "";
        public string? Phone { get; set; }
        public string? Email { get; set; }
        public string? Address { get; set; }
        public string? Notes { get; set; }
        public bool IsActive { get; set; }
        public int Points { get; set; }
        public DateTime CreatedAt { get; set; }
        public int Visits { get; set; }
        public decimal Spend { get; set; }
        public DateTime? LastVisit { get; set; }
        public decimal? PreapprovedPct { get; set; }
        public string? PreapprovedReason { get; set; }
        public DateOnly? PreapprovedUntil { get; set; }
        public Guid? PreapprovedBy { get; set; }
        public DateTime? PreapprovedAt { get; set; }
        public string? PreapprovedByName { get; set; }
    }

    private const string RowSql = """
        select c.*, coalesce(s.visits, 0)::int as visits, coalesce(s.spend, 0) as spend, s.last_visit,
               (select display_name from app_user u where u.id = c.preapproved_by) as preapproved_by_name
        from customer c left join lateral (
          select count(*) as visits, sum(o.total - o.refunded) as spend, max(o.closed_at) as last_visit
          from pos_order o where o.customer_id = c.id and o.status in ('paid','refunded')) s on true
        """;

    /// <summary>The phone as lookups match it: digits only, UAE numbers as 05XXXXXXXX. Null when too short to be a phone.</summary>
    public static string? PhoneKey(string? phone)
    {
        var d = new string((phone ?? "").Where(char.IsDigit).ToArray());
        if (d.StartsWith("00")) d = d[2..];
        if (d.StartsWith("971") && d.Length >= 11) d = "0" + d[3..];
        else if (d.Length == 9 && d[0] == '5') d = "0" + d;
        return d.Length >= 6 ? d : null;
    }

    /// <summary>After an order is paid: attach the customer with its phone number, or create one from the order's name and phone.</summary>
    public static async Task LinkAsync(NpgsqlConnection c, NpgsqlTransaction tx, Guid orderId, Guid userId)
    {
        var o = await c.QuerySingleAsync<(Guid CompanyId, Guid BranchId, Guid? CustomerId, string? Name, string? Phone, string? Address, string Type)>(
            "select company_id, branch_id, customer_id, customer_name, customer_phone, delivery_address, order_type from pos_order where id = @orderId", new { orderId }, tx);
        if (o.CustomerId is not null) return;
        var key = PhoneKey(o.Phone);
        if (key is null) return;
        var id = await c.ExecuteScalarAsync<Guid?>("select id from customer where branch_id = @BranchId and phone_key = @key", new { o.BranchId, key }, tx);
        if (id is null)
        {
            if (string.IsNullOrWhiteSpace(o.Name)) return;
            id = await c.ExecuteScalarAsync<Guid>("""
                insert into customer (company_id, branch_id, name, phone, phone_key, address, created_by) values (@co, @BranchId, @name, @phone, @key, @address, @userId)
                on conflict (branch_id, phone_key) where phone_key is not null do update set name = customer.name returning id
                """, new { co = o.CompanyId, o.BranchId, name = o.Name.Trim(), phone = o.Phone!.Trim(), key, address = o.Type == "delivery" ? o.Address : null, userId }, tx);
        }
        await c.ExecuteAsync("update pos_order set customer_id = @id where id = @orderId", new { id, orderId }, tx);
    }

    private static Body Clean(Body b)
    {
        if (string.IsNullOrWhiteSpace(b.Name)) throw new DomainException("Enter the customer's name.");
        if (!string.IsNullOrWhiteSpace(b.Phone) && PhoneKey(b.Phone) is null) throw new DomainException("That doesn't look like a phone number.");
        static string? Opt(string? s) => string.IsNullOrWhiteSpace(s) ? null : s.Trim();
        return new Body(b.Name.Trim(), Opt(b.Phone), Opt(b.Email), Opt(b.Address), Opt(b.Notes), b.IsActive);
    }

    public static void Map(RouteGroupBuilder api)
    {
        // This branch's customers, by name or phone (any part); newest visitors first. Empty search: the most recent customers.
        api.MapGet("/customers", async (HttpContext http, Db db, string? q) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("pos.sell");
            var term = string.IsNullOrWhiteSpace(q) ? null : q.Trim();
            var key = PhoneKey(term) ?? (term is not null && term.Count(char.IsDigit) >= 3 ? new string(term.Where(char.IsDigit).ToArray()) : null);
            return await db.Company(scope.CompanyId, (c, tx) => c.QueryAsync<Row>($"""
                select * from ({RowSql} where c.branch_id = @b) x
                where (@term is null or lower(x.name) like '%' || lower(@term) || '%' or (@key is not null and x.phone_key like '%' || @key || '%'))
                order by x.last_visit desc nulls last, x.created_at desc limit 50
                """, new { term, key, b = scope.Branch }, tx));
        });

        api.MapGet("/customers/{id:guid}", async (Guid id, HttpContext http, Db db) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("pos.sell");
            return await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var cu = await c.QuerySingleOrDefaultAsync<Row>($"{RowSql} where c.id = @id and c.branch_id = @b", new { id, b = scope.Branch }, tx) ?? throw new NotFoundException("Customer not found.");
                var orders = await c.QueryAsync<(Guid Id, int? Number, string? InvoiceNo, DateTime? ClosedAt, string BranchCode, string OrderType, decimal Total, decimal Refunded, string Status, int Items)>("""
                    select o.id, o.number, o.invoice_no, o.closed_at, b.code, o.order_type, o.total, o.refunded, o.status,
                           (select count(*) from order_line l where l.order_id = o.id and not l.is_void)::int
                    from pos_order o join branch b on b.id = o.branch_id where o.customer_id = @id and o.status in ('paid','refunded','open')
                    order by o.opened_at desc limit 30
                    """, new { id }, tx);
                var favourites = await c.QueryAsync<(string Name, decimal Qty)>("""
                    select l.name, sum(l.qty - l.returned_qty) from order_line l join pos_order o on o.id = l.order_id
                    where o.customer_id = @id and o.status in ('paid','refunded') and not l.is_void group by l.name order by 2 desc limit 5
                    """, new { id }, tx);
                return new
                {
                    customer = cu,
                    orders = orders.Select(o => new { o.Id, o.Number, o.InvoiceNo, o.ClosedAt, branch = o.BranchCode, type = o.OrderType, o.Total, o.Refunded, o.Status, o.Items }),
                    favourites = favourites.Select(f => new { f.Name, f.Qty }),
                };
            });
        });

        api.MapPost("/customers", async (Body body, HttpContext http, Db db) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("pos.sell");
            var b = Clean(body);
            return await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var key = PhoneKey(b.Phone);
                if (key is not null && await c.ExecuteScalarAsync<string?>("select name from customer where branch_id = @br and phone_key = @key", new { br = scope.Branch, key }, tx) is { } who)
                    throw new ConflictException($"{who} already has this phone number.");
                var id = await c.ExecuteScalarAsync<Guid>("""
                    insert into customer (company_id, branch_id, name, phone, phone_key, email, address, notes, created_by)
                    values (@co, @br, @Name, @Phone, @key, @Email, @Address, @Notes, @u) returning id
                    """, new { co = scope.CompanyId, br = scope.Branch, b.Name, b.Phone, key, b.Email, b.Address, b.Notes, u = scope.UserId }, tx);
                await Audit.RecordAsync(c, tx, scope.CompanyId, scope.BranchId, scope.UserId, "customer", id.ToString(), "created", $"Customer {b.Name} added");
                return await c.QuerySingleAsync<Row>($"{RowSql} where c.id = @id", new { id }, tx);
            });
        });

        api.MapPut("/customers/{id:guid}", async (Guid id, Body body, HttpContext http, Db db) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("pos.sell");
            var b = Clean(body);
            return await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var old = await c.QuerySingleOrDefaultAsync<Row>("select * from customer where id = @id and branch_id = @br for update", new { id, br = scope.Branch }, tx) ?? throw new NotFoundException("Customer not found.");
                var key = PhoneKey(b.Phone);
                if (key is not null && await c.ExecuteScalarAsync<string?>("select name from customer where branch_id = @br and phone_key = @key and id <> @id", new { br = scope.Branch, key, id }, tx) is { } who)
                    throw new ConflictException($"{who} already has this phone number.");
                await c.ExecuteAsync("""
                    update customer set name = @Name, phone = @Phone, phone_key = @key, email = @Email, address = @Address, notes = @Notes, is_active = @active where id = @id
                    """, new { id, b.Name, b.Phone, key, b.Email, b.Address, b.Notes, active = b.IsActive ?? old.IsActive }, tx);
                await Audit.RecordAsync(c, tx, scope.CompanyId, scope.BranchId, scope.UserId, "customer", id.ToString(), "changed", $"Customer {old.Name} changed",
                    [new("Name", old.Name, b.Name), new("Phone", old.Phone, b.Phone), new("Email", old.Email, b.Email), new("Address", old.Address, b.Address), new("Active", old.IsActive, b.IsActive ?? old.IsActive)]);
                return await c.QuerySingleAsync<Row>($"{RowSql} where c.id = @id", new { id }, tx);
            });
        });

        // A customer's pre-approved discount: set once by a manager allowed to (customers.preapprove); the till then gives it
        // on the whole bill when the customer is attached, with no approval request.
        api.MapPut("/customers/{id:guid}/preapproved", async (Guid id, PreapprovedBody body, HttpContext http, Db db) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("customers.preapprove");
            if (body.Pct is { } p && (p <= 0 || p > 100)) throw new DomainException("A pre-approved discount is more than 0 and at most 100 %.");
            var reason = body.Pct is null ? null : (body.Reason ?? "").Trim().ToLowerInvariant();
            if (reason is not null && !PreapprovedReasons.ContainsKey(reason)) throw new DomainException("Choose why this customer's discount is pre-approved.");
            return await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var old = await c.QuerySingleOrDefaultAsync<Row>("select * from customer where id = @id and branch_id = @br for update", new { id, br = scope.Branch }, tx) ?? throw new NotFoundException("Customer not found.");
                await c.ExecuteAsync("""
                    update customer set preapproved_pct = @pct, preapproved_reason = @reason, preapproved_until = @until,
                      preapproved_by = case when @pct is null then null else @u end, preapproved_at = case when @pct is null then null else now() end where id = @id
                    """, new { id, pct = body.Pct, reason, until = body.Pct is null ? null : body.Until, u = scope.UserId }, tx);
                await Audit.RecordAsync(c, tx, scope.CompanyId, scope.BranchId, scope.UserId, "customer", id.ToString(), "preapproved",
                    body.Pct is null ? $"{old.Name}: pre-approved discount taken off" : $"{old.Name}: {body.Pct:0.##} % pre-approved ({PreapprovedReasons[reason!]})",
                    [new("Pre-approved %", old.PreapprovedPct, body.Pct), new("Reason", old.PreapprovedReason, reason), new("Until", old.PreapprovedUntil, body.Until)]);
                return await c.QuerySingleAsync<Row>($"{RowSql} where c.id = @id", new { id }, tx);
            });
        });

        // Attach a customer to an order (their name, phone and, for delivery, address fill in), or take it off. A customer with a
        // pre-approved discount (still valid) brings it onto the whole bill; taking them off (or attaching another) takes it off.
        api.MapPost("/orders/{id:guid}/customer", (Guid id, AttachBody body, HttpContext http, Db db, Live live) => Orders.Mutate(http, db, live, id, "pos.sell", async (c, tx, o, scope) =>
        {
            if (await c.ExecuteScalarAsync<bool>("select coalesce(discount_source = 'customer', false) from pos_order where id = @id", new { id }, tx))
                await c.ExecuteAsync("""
                    update pos_order set discount_pct = 0, discount_amount = 0, discount_source = null, discount_id = null, discount_name = null, discount_note = null, discount_by = null
                    where id = @id
                    """, new { id }, tx);
            if (body.CustomerId is not { } cid)
            {
                await c.ExecuteAsync("update pos_order set customer_id = null, customer_name = null, customer_phone = null where id = @id", new { id }, tx);
                return;
            }
            var cu = await c.QuerySingleOrDefaultAsync<Row>("select * from customer where id = @cid and branch_id = @BranchId and is_active", new { cid, o.BranchId }, tx)
                ?? throw new NotFoundException("Customer not found at this branch.");
            await c.ExecuteAsync("""
                update pos_order set customer_id = @cid, customer_name = @Name, customer_phone = @Phone,
                  delivery_address = case when order_type = 'delivery' and delivery_address is null then @Address else delivery_address end
                where id = @id
                """, new { id, cid, cu.Name, cu.Phone, cu.Address }, tx);
            if (cu.PreapprovedPct is { } pct && cu.PreapprovedReason is { } reason && (cu.PreapprovedUntil is null || cu.PreapprovedUntil >= o.BusinessDate))
            {
                var label = PreapprovedReasons.GetValueOrDefault(reason, reason);
                await c.ExecuteAsync("""
                    update pos_order set discount_pct = @pct, discount_amount = 0, discount_source = 'customer', discount_id = null, discount_name = @label,
                      discount_note = @name, discount_by = @by where id = @id
                    """, new { id, pct, label, name = cu.Name, by = cu.PreapprovedBy }, tx);
                await Audit.RecordAsync(c, tx, o.CompanyId, o.BranchId, scope.UserId, "order", id.ToString(), "discount",
                    $"Order #{o.Number}: {pct:0.##} % pre-approved for {cu.Name} ({label})");
            }
        }));
    }
}
