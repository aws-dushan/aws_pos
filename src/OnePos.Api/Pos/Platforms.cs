using Dapper;
using OnePos.Api.Data;
using OnePos.Api.Platform;

namespace OnePos.Api.Pos;

/// <summary>
/// Delivery platforms (aggregators) of the company, with their commission. Orders from them are entered at the register from
/// the platform's tablet; what they owe and their commission show over a range of business days. Editing needs branch.manage.
/// </summary>
public static class Platforms
{
    public sealed record PlatformBody(string Name, decimal CommissionPct, bool? IsActive, int? Sort, decimal? BankFeePct = null);
    public sealed record SettingsBody(bool PayoutsEnabled);
    public sealed record PayoutBody(Guid PlatformId, DateOnly ReceivedOn, DateOnly? PeriodFrom, DateOnly? PeriodTo, decimal Amount, decimal? Commission, string? Reference, string? Note, decimal? BankFee = null);

    public sealed class PayoutRow
    {
        public Guid Id { get; set; }
        public Guid PlatformId { get; set; }
        public string PlatformName { get; set; } = "";
        public DateOnly ReceivedOn { get; set; }
        public DateOnly? PeriodFrom { get; set; }
        public DateOnly? PeriodTo { get; set; }
        public decimal Amount { get; set; }
        public decimal Commission { get; set; }
        public decimal BankFee { get; set; }
        public string? Reference { get; set; }
        public string? Note { get; set; }
        public string? RecordedByName { get; set; }
        public DateTime RecordedAt { get; set; }
    }

    private const string PayoutSql = """
        select x.*, p.name as platform_name, u.display_name as recorded_by_name
        from platform_payout x join delivery_platform p on p.id = x.platform_id join app_user u on u.id = x.recorded_by
        """;

    private static Task<bool> PayoutsOnAsync(Npgsql.NpgsqlConnection c, Npgsql.NpgsqlTransaction tx, Guid companyId) =>
        c.ExecuteScalarAsync<bool>("select platform_payouts from company where id = @companyId", new { companyId }, tx);

    public sealed class Row
    {
        public Guid Id { get; set; }
        public string Name { get; set; } = "";
        public decimal CommissionPct { get; set; }
        public decimal BankFeePct { get; set; }
        public bool IsActive { get; set; }
        public int Sort { get; set; }
        /// <summary>The platform's FACTS customer (e.g. AR-D0005); its FACTS prices are the platform's prices.</summary>
        public string? FactsCustomer { get; set; }
        public string? FactsCustomerName { get; set; }
        public string? FactsPriceType { get; set; }
        public DateTime? FactsPriceAt { get; set; }
        public int FactsPriced { get; set; }
    }

    public sealed record FactsCustomerBody(string? Customer);

    private sealed class SummaryRow
    {
        public Guid Id { get; set; }
        public string Name { get; set; } = "";
        public decimal CommissionPct { get; set; }
        public decimal BankFeePct { get; set; }
        public decimal BankFee { get; set; }
        public int Orders { get; set; }
        public decimal Sales { get; set; }
        public decimal Refunded { get; set; }
        public decimal Commission { get; set; }
        public decimal Owed { get; set; }
    }

    private static PlatformBody Clean(PlatformBody b)
    {
        var name = (b.Name ?? "").Trim();
        if (name.Length is 0 or > 40) throw new DomainException("A platform needs a name (up to 40 characters).");
        if (b.CommissionPct is < 0 or > 100) throw new DomainException("Commission is 0 to 100 %.");
        if (b.BankFeePct is < 0 or > 100) throw new DomainException("Bank fee is 0 to 100 %.");
        return b with { Name = name };
    }

    public static void Map(RouteGroupBuilder api)
    {
        api.MapGet("/platforms", async (HttpContext http, Db db) =>
        {
            var scope = await http.ScopeAsync(db);
            if (!scope.Can("pos.sell") && !scope.Can("reports.view")) scope.Require("branch.manage");
            return await db.Company(scope.CompanyId, (c, tx) => c.QueryAsync<Row>("""
                select dp.*, (select count(*) from platform_item_price pp where pp.platform_id = dp.id)::int as facts_priced
                from delivery_platform dp order by dp.is_active desc, dp.sort, dp.name
                """, transaction: tx));
        });

        // FACTS customers to link a platform to (receivable accounts, e.g. AR-D0005 DELIVERY HERO TALABAT), by code or name.
        api.MapGet("/platforms/facts-customers", async (HttpContext http, Db db, Erp.FactsSync facts, string? q) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("branch.manage");
            var text = (q ?? "").Trim();
            if (text.Length < 2) return Results.Ok(Array.Empty<object>());
            await using var f = await facts.OpenAsync(scope.CompanyId);
            var rows = await f.QueryAsync<(string Code, string Name, string? PriceType)>("""
                select top 30 ltrim(rtrim(ACMST_ACCODE)), ltrim(rtrim(ACMST_DESC)), ltrim(rtrim(ACMST_PRICE_TYPE_DOCNO)) from ACMST_POPULATED
                where ACMST_ACCODE like 'AR-%' and (ACMST_ACCODE like @like or ACMST_DESC like @like) order by ACMST_DESC
                """, new { like = $"%{text}%" }, commandTimeout: 30);
            return Results.Ok(rows.Select(r => new { code = r.Code, name = r.Name, priceType = r.PriceType }));
        });

        // Link a platform to its FACTS customer (null unlinks it: back to the outlet's prices); its prices are read straight away.
        api.MapPut("/platforms/{id:guid}/facts-customer", async (Guid id, FactsCustomerBody body, HttpContext http, Db db, Erp.FactsSync facts, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("branch.manage");
            var code = string.IsNullOrWhiteSpace(body.Customer) ? null : body.Customer.Trim().ToUpperInvariant();
            string? name = null;
            if (code is not null)
            {
                await using var f = await facts.OpenAsync(scope.CompanyId);
                name = await f.QuerySingleOrDefaultAsync<string?>("select top 1 ltrim(rtrim(ACMST_DESC)) from ACMST_POPULATED where ACMST_ACCODE = @code", new { code })
                       ?? throw new DomainException($"FACTS has no customer {code}.");
            }
            await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var old = await c.QuerySingleOrDefaultAsync<Row>("select * from delivery_platform where id = @id for update", new { id }, tx) ?? throw new NotFoundException("Platform not found.");
                await c.ExecuteAsync("""
                    update delivery_platform set facts_customer = @code, facts_customer_name = @name,
                      facts_price_type = case when @code is distinct from facts_customer then null else facts_price_type end,
                      facts_price_at = case when @code is distinct from facts_customer then null else facts_price_at end where id = @id
                    """, new { id, code, name }, tx);
                if (code != old.FactsCustomer) await c.ExecuteAsync("delete from platform_item_price where platform_id = @id", new { id }, tx);
                await Audit.RecordAsync(c, tx, scope.CompanyId, null, scope.UserId, "platform", id.ToString(), "changed", $"{old.Name}: FACTS customer {(code is null ? "removed" : code)}",
                    [new("FACTS customer", old.FactsCustomer, code)]);
                return 0;
            });
            object? sync = null;
            if (code is not null) sync = await facts.SyncPricesAsync(scope.CompanyId, scope.UserId);
            await live.ToCompany(scope.CompanyId, "platforms.changed");
            await live.ToCompany(scope.CompanyId, "menu.changed");
            return Results.Ok(new { ok = true, sync });
        });

        api.MapPost("/platforms", async (PlatformBody body, HttpContext http, Db db, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("branch.manage");
            var b = Clean(body);
            var row = await db.Company(scope.CompanyId, async (c, tx) =>
            {
                if (await c.ExecuteScalarAsync<bool>("select exists (select 1 from delivery_platform where lower(name) = lower(@Name))", new { b.Name }, tx))
                    throw new ConflictException($"{b.Name} is already on the list.");
                var sort = b.Sort ?? await c.ExecuteScalarAsync<int>("select coalesce(max(sort), 0) + 1 from delivery_platform", transaction: tx);
                var id = await c.ExecuteScalarAsync<Guid>("insert into delivery_platform (company_id, name, commission_pct, bank_fee_pct, sort) values (@co, @Name, @CommissionPct, @fee, @sort) returning id",
                    new { co = scope.CompanyId, b.Name, b.CommissionPct, fee = b.BankFeePct ?? 0, sort }, tx);
                await Audit.RecordAsync(c, tx, scope.CompanyId, null, scope.UserId, "platform", id.ToString(), "created", $"Delivery platform {b.Name} added ({b.CommissionPct:0.##} %)");
                return await c.QuerySingleAsync<Row>("select * from delivery_platform where id = @id", new { id }, tx);
            });
            await live.ToCompany(scope.CompanyId, "platforms.changed");
            return Results.Ok(row);
        });

        api.MapPut("/platforms/{id:guid}", async (Guid id, PlatformBody body, HttpContext http, Db db, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("branch.manage");
            var b = Clean(body);
            var row = await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var old = await c.QuerySingleOrDefaultAsync<Row>("select * from delivery_platform where id = @id for update", new { id }, tx) ?? throw new NotFoundException("Platform not found.");
                if (await c.ExecuteScalarAsync<bool>("select exists (select 1 from delivery_platform where lower(name) = lower(@Name) and id <> @id)", new { b.Name, id }, tx))
                    throw new ConflictException($"{b.Name} is already on the list.");
                await c.ExecuteAsync("update delivery_platform set name = @Name, commission_pct = @CommissionPct, bank_fee_pct = coalesce(@BankFeePct, bank_fee_pct), is_active = coalesce(@IsActive, is_active), sort = coalesce(@Sort, sort) where id = @id",
                    new { id, b.Name, b.CommissionPct, b.BankFeePct, b.IsActive, b.Sort }, tx);
                await Audit.RecordAsync(c, tx, scope.CompanyId, null, scope.UserId, "platform", id.ToString(), "changed", $"Delivery platform {old.Name} changed",
                    [new("Name", old.Name, b.Name), new("Commission %", old.CommissionPct, b.CommissionPct), new("Bank fee %", old.BankFeePct, b.BankFeePct ?? old.BankFeePct), new("Active", old.IsActive, b.IsActive ?? old.IsActive)]);
                return await c.QuerySingleAsync<Row>("select * from delivery_platform where id = @id", new { id }, tx);
            });
            await live.ToCompany(scope.CompanyId, "platforms.changed");
            return Results.Ok(row);
        });

        // Per platform over business days (this branch, or all): orders, sales, refunds, commission at each order's rate, and what it owes.
        api.MapGet("/platforms/summary", async (HttpContext http, Db db, DateOnly from, DateOnly to, bool? all) =>
        {
            var scope = await http.ScopeAsync(db);
            if (!scope.Can("reports.view")) scope.Require("branch.manage");
            if (to < from || to.DayNumber - from.DayNumber > 366) throw new DomainException("Choose up to a year, from before to.");
            return await db.Company(scope.CompanyId, async (c, tx) =>
            {
                Guid[] ids = all == true ? (await c.QueryAsync<Guid>("select id from branch", transaction: tx)).ToArray() : [scope.Branch];
                var rows = (await c.QueryAsync<SummaryRow>("""
                    select p.id, p.name, p.commission_pct, p.bank_fee_pct, count(o.id)::int as orders, coalesce(sum(o.total), 0) as sales, coalesce(sum(o.refunded), 0) as refunded,
                           coalesce(sum((o.total - o.refunded) * coalesce(o.platform_commission, 0) / 100), 0) as commission,
                           coalesce(sum((o.total - o.refunded) * coalesce(o.platform_bank_fee, 0) / 100), 0) as bank_fee,
                           coalesce((select sum(case when pay.kind = 'payment' then pay.amount else -pay.amount end) from payment pay join pos_order po on po.id = pay.order_id
                                     where po.platform_id = p.id and pay.method = 'platform' and po.branch_id = any(@ids) and po.business_date between @from and @to), 0) as owed
                    from delivery_platform p
                    left join pos_order o on o.platform_id = p.id and o.branch_id = any(@ids) and o.business_date between @from and @to and o.status in ('paid','refunded')
                    group by p.id, p.name, p.commission_pct, p.bank_fee_pct, p.sort order by p.sort, p.name
                    """, new { ids, from, to }, tx)).ToList();
                var payouts = await PayoutsOnAsync(c, tx, scope.CompanyId);
                // Payouts are company-wide: received in these days, and what each platform still owes to date (all branches).
                var settle = payouts ? (await c.QueryAsync<(Guid Id, decimal Received, decimal Balance)>("""
                    select p.id,
                           coalesce((select sum(x.amount) from platform_payout x where x.platform_id = p.id and x.voided_at is null and x.received_on between @from and @to), 0),
                           coalesce((select sum(case when pay.kind = 'payment' then pay.amount else -pay.amount end) from payment pay join pos_order po on po.id = pay.order_id
                                     where po.platform_id = p.id and pay.method = 'platform'), 0)
                           - coalesce((select sum(x.amount + x.commission + x.bank_fee) from platform_payout x where x.platform_id = p.id and x.voided_at is null), 0)
                    from delivery_platform p
                    """, new { from, to }, tx)).ToDictionary(x => x.Id) : [];
                var items = rows.Select(r => new
                {
                    r.Id, r.Name, rate = r.CommissionPct, feeRate = r.BankFeePct, r.Orders, r.Sales, r.Refunded, net = r.Sales - r.Refunded,
                    commission = Money.Round(r.Commission), bankFee = Money.Round(r.BankFee), r.Owed, payout = Money.Round(r.Owed - r.Commission - r.BankFee),
                    received = settle.TryGetValue(r.Id, out var st) ? st.Received : (decimal?)null,
                    stillOwed = settle.TryGetValue(r.Id, out var sb) ? sb.Balance : (decimal?)null,
                }).ToList();
                return new
                {
                    from, to, payoutsEnabled = payouts, items,
                    totals = new
                    {
                        orders = items.Sum(i => i.Orders), net = items.Sum(i => i.net), commission = items.Sum(i => i.commission), bankFee = items.Sum(i => i.bankFee), owed = items.Sum(i => i.Owed), payout = items.Sum(i => i.payout),
                        received = payouts ? items.Sum(i => i.received ?? 0) : (decimal?)null, stillOwed = payouts ? items.Sum(i => i.stillOwed ?? 0) : (decimal?)null,
                    },
                };
            });
        });

        // The setting: payouts tracked in One POS, or managed elsewhere (off).
        api.MapGet("/platforms/settings", async (HttpContext http, Db db) =>
        {
            var scope = await http.ScopeAsync(db);
            if (!scope.Can("reports.view")) scope.Require("branch.manage");
            return await db.Company(scope.CompanyId, async (c, tx) => new { payoutsEnabled = await PayoutsOnAsync(c, tx, scope.CompanyId) });
        });

        api.MapPut("/platforms/settings", async (SettingsBody body, HttpContext http, Db db, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("branch.manage");
            await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var old = await PayoutsOnAsync(c, tx, scope.CompanyId);
                await c.ExecuteAsync("update company set platform_payouts = @PayoutsEnabled where id = @id", new { body.PayoutsEnabled, id = scope.CompanyId }, tx);
                await Audit.RecordAsync(c, tx, scope.CompanyId, null, scope.UserId, "company", scope.CompanyId.ToString(), "platform-payouts",
                    "Delivery platform payouts setting changed", [new("Track payouts in One POS", old, body.PayoutsEnabled)]);
                return 0;
            });
            await live.ToCompany(scope.CompanyId, "platforms.changed");
            return Results.Ok(new { body.PayoutsEnabled });
        });

        api.MapGet("/platforms/payouts", async (HttpContext http, Db db, DateOnly from, DateOnly to) =>
        {
            var scope = await http.ScopeAsync(db);
            if (!scope.Can("reports.view")) scope.Require("branch.manage");
            return await db.Company(scope.CompanyId, (c, tx) => c.QueryAsync<PayoutRow>($"""
                {PayoutSql} where x.voided_at is null and x.received_on between @from and @to order by x.received_on desc, x.recorded_at desc
                """, new { from, to }, tx));
        });

        api.MapPost("/platforms/payouts", async (PayoutBody body, HttpContext http, Db db, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            if (!scope.Can("branch.manage")) scope.Require("day.manage");
            if (body.Amount <= 0) throw new DomainException("Enter the amount received.");
            if (body.Commission is < 0) throw new DomainException("Commission can't be negative.");
            if (body.BankFee is < 0) throw new DomainException("Bank fee can't be negative.");
            if (body.PeriodFrom is { } pf && body.PeriodTo is { } pt && pf > pt) throw new DomainException("The period ends before it starts.");
            var row = await db.Company(scope.CompanyId, async (c, tx) =>
            {
                if (!await PayoutsOnAsync(c, tx, scope.CompanyId)) throw new DomainException("Platform payouts aren't tracked in One POS for this company (Administration → Delivery platforms).");
                var name = await c.ExecuteScalarAsync<string?>("select name from delivery_platform where id = @PlatformId", new { body.PlatformId }, tx) ?? throw new DomainException("Choose the platform.");
                var id = await c.ExecuteScalarAsync<Guid>("""
                    insert into platform_payout (company_id, platform_id, received_on, period_from, period_to, amount, commission, bank_fee, reference, note, recorded_by)
                    values (@co, @PlatformId, @ReceivedOn, @PeriodFrom, @PeriodTo, @amount, @commission, @bankFee, @reference, @note, @u) returning id
                    """, new
                    {
                        co = scope.CompanyId, body.PlatformId, body.ReceivedOn, body.PeriodFrom, body.PeriodTo, amount = Money.Round(body.Amount), commission = Money.Round(body.Commission ?? 0), bankFee = Money.Round(body.BankFee ?? 0),
                        reference = string.IsNullOrWhiteSpace(body.Reference) ? null : body.Reference.Trim(), note = string.IsNullOrWhiteSpace(body.Note) ? null : body.Note.Trim(), u = scope.UserId,
                    }, tx);
                await Audit.RecordAsync(c, tx, scope.CompanyId, null, scope.UserId, "platform_payout", id.ToString(), "recorded",
                    $"{name} payout of {body.Amount:N2} received {body.ReceivedOn:dd MMM yyyy} (commission {body.Commission ?? 0:N2})", note: body.Reference);
                return await c.QuerySingleAsync<PayoutRow>($"{PayoutSql} where x.id = @id", new { id }, tx);
            });
            await live.ToCompany(scope.CompanyId, "platforms.changed");
            return Results.Ok(row);
        });

        api.MapPost("/platforms/payouts/{id:guid}/void", async (Guid id, HttpContext http, Db db, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            if (!scope.Can("branch.manage")) scope.Require("day.manage");
            await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var n = await c.ExecuteAsync("update platform_payout set voided_at = now(), voided_by = @u where id = @id and voided_at is null", new { id, u = scope.UserId }, tx);
                if (n == 0) throw new NotFoundException("Payout not found (or already taken off).");
                await Audit.RecordAsync(c, tx, scope.CompanyId, null, scope.UserId, "platform_payout", id.ToString(), "voided", "Platform payout taken off");
                return 0;
            });
            await live.ToCompany(scope.CompanyId, "platforms.changed");
            return Results.Ok(new { id });
        });
    }
}
