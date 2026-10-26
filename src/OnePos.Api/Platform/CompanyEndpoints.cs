using System.Text.Json;
using Dapper;
using OnePos.Api.Data;

namespace OnePos.Api.Platform;

/// <summary>Companies (admin) and their branches (admin or branch.manage) — REQ ORG-01 … ORG-05.</summary>
public static class CompanyEndpoints
{
    public sealed record CompanyBody(string Code, string Name, string LegalName, string? Trn, string? BaseCurrency, decimal? VatRate,
        bool? PricesIncludeVat, string? ErpConnector, bool? IsActive, string? LegalNameAr = null);

    public sealed record BranchBody(string Code, string Name, string? Address, string? Phone, string? TimeZone, bool? TableService, bool? AskGuests,
        decimal? ServiceChargePct, string? ReceiptHeader, string? ReceiptFooter, string? DayControl, bool? IsActive, int? ReturnDays = null,
        bool? KitchenEnabled = null, string? AutoOpenTime = null, string? AutoCloseTime = null, decimal? VarianceTolerance = null, decimal? DefaultFloat = null,
        string? OpenOrdersAtClose = null, string? ErpLocationCode = null, string? ErpLocationName = null,
        string? NameAr = null, string? AddressAr = null, string? ReceiptLanguage = null, string? ShortStock = null,
        string? PickupMode = null, int? PickupMinutes = null, int? CloseDelayMinutes = null, int? CloseDelayMaxMinutes = null, string? FactsDocPrefix = null, string? ErpWasteLocation = null,
        string? FactsPriceType = null, bool? FactsPricesIncludeVat = null, bool? ReturnsEnabled = null);

    public sealed class CompanyRow
    {
        public Guid Id { get; set; }
        public string Code { get; set; } = "";
        public string Name { get; set; } = "";
        public string LegalName { get; set; } = "";
        public string? LegalNameAr { get; set; }
        public string? Trn { get; set; }
        public string BaseCurrency { get; set; } = "";
        public decimal VatRate { get; set; }
        public bool PricesIncludeVat { get; set; }
        public string ErpConnector { get; set; } = "";
        public bool IsActive { get; set; }
        public bool VouchersEnabled { get; set; }
        public bool LoyaltyEnabled { get; set; }
        public decimal LoyaltyPointsPerUnit { get; set; }
        public decimal LoyaltyPointValue { get; set; }
        public int LoyaltyMinRedeem { get; set; }
        public int Branches { get; set; }
        public int Users { get; set; }
    }

    public sealed class BranchRow
    {
        public Guid Id { get; set; }
        public Guid CompanyId { get; set; }
        public string Code { get; set; } = "";
        public string Name { get; set; } = "";
        public string? Address { get; set; }
        public string? Phone { get; set; }
        public string TimeZone { get; set; } = "";
        public bool TableService { get; set; }
        public bool AskGuests { get; set; }
        public decimal ServiceChargePct { get; set; }
        public string? ReceiptHeader { get; set; }
        public string? ReceiptFooter { get; set; }
        public string DayControl { get; set; } = "";
        public bool IsActive { get; set; }
        public int ReturnDays { get; set; }
        public bool ReturnsEnabled { get; set; }
        public bool KitchenEnabled { get; set; }
        public TimeOnly AutoOpenTime { get; set; }
        public TimeOnly AutoCloseTime { get; set; }
        public decimal VarianceTolerance { get; set; }
        public decimal DefaultFloat { get; set; }
        public string OpenOrdersAtClose { get; set; } = "";
        public string? ErpLocationCode { get; set; }
        public string? ErpLocationName { get; set; }
        public string? NameAr { get; set; }
        public string? AddressAr { get; set; }
        public string ReceiptLanguage { get; set; } = "bilingual";
        public string ShortStock { get; set; } = "allow";
        public string PickupMode { get; set; } = "off";
        public int PickupMinutes { get; set; } = 10;
        public int CloseDelayMinutes { get; set; } = 15;
        public string? FactsDocPrefix { get; set; }
        public string? ErpWasteLocation { get; set; }
        public string? FactsPriceType { get; set; }
        public bool FactsPricesIncludeVat { get; set; } = true;
        public int CloseDelayMaxMinutes { get; set; } = 120;
        /// <summary>Wastage approval: the One POS user who approves, where requests are emailed, the FACTS username it is posted as.</summary>
        public Guid? WastageApproverId { get; set; }
        public string? WastageApprovalEmail { get; set; }
        public string? WastageFactsUser { get; set; }
        /// <summary>Marketing give-aways: who approves, where requests are emailed, the FACTS username the MCV50 is posted as, its expense account.</summary>
        public Guid? MarketingApproverId { get; set; }
        public string? MarketingApprovalEmail { get; set; }
        public string? MarketingFactsUser { get; set; }
        public string? MarketingAccount { get; set; }
        /// <summary>Stock requests (STR50): who approves, where requests are emailed, the FACTS username the STR50 is posted as.</summary>
        public Guid? RequestApproverId { get; set; }
        public string? RequestApprovalEmail { get; set; }
        public string? RequestFactsUser { get; set; }
        /// <summary>Where discount requests sent to a manager are emailed (null: no email).</summary>
        public string[]? DiscountApprovalEmails { get; set; }
    }

    public sealed record WastageApprovalBody(Guid? ApproverId, string? Email, string? FactsUser);
    public sealed record MarketingBody(Guid? ApproverId, string? Email, string? FactsUser, string? Account);
    public sealed record DiscountApprovalBody(string[]? Emails);

    private static readonly string[] Connectors = ["none", "awsone", "facts"];
    private static readonly string[] DayControls = ["manual", "automatic", "cashier"];

    public static void Map(RouteGroupBuilder api)
    {
        api.MapGet("/companies", async (HttpContext http, Db db) =>
        {
            var me = http.CurrentUser();
            return await db.Platform(async (c, tx) => (await c.QueryAsync<CompanyRow>("""
                select co.*, (select count(*) from branch b where b.company_id = co.id)::int as branches,
                       (select count(*) from user_company uc where uc.company_id = co.id)::int as users
                from company co
                where @isAdmin or exists (select 1 from user_company uc where uc.company_id = co.id and uc.user_id = @id)
                order by co.name
                """, new { me.Id, me.IsAdmin }, tx)).ToList());
        });

        api.MapPost("/companies", async (CompanyBody body, HttpContext http, Db db) =>
        {
            http.RequireAdmin();
            var me = http.CurrentUser();
            var b = Clean(body);
            var id = await db.Platform(async (c, tx) =>
            {
                b = b with { Code = await CompanyCodeAsync(c, tx, b.Name) };
                var id = await c.ExecuteScalarAsync<Guid>("""
                    insert into company (code, name, legal_name, legal_name_ar, trn, base_currency, vat_rate, prices_include_vat, erp_connector)
                    values (@Code, @Name, @LegalName, @LegalNameAr, @Trn, @BaseCurrency, @VatRate, @PricesIncludeVat, @ErpConnector) returning id
                    """, b, tx);
                await Audit.RecordAsync(c, tx, id, null, me.Id, "company", id.ToString(), "created", $"Company {b.Code} created",
                    Audit.Created(("Code", b.Code), ("Name", b.Name), ("ERP", b.ErpConnector)));
                return id;
            });
            // The starting roles, inside the company (RLS).
            await db.Company(id, async (c, tx) =>
            {
                foreach (var (name, perms, limits) in Permissions.Presets)
                    await c.ExecuteAsync("insert into role (company_id, name, permissions, limits) values (@id, @name, @perms, cast(@limits as jsonb))",
                        new { id, name, perms, limits = JsonSerializer.Serialize(limits) }, tx);
                return 0;
            });
            return Results.Ok(new { id });
        });

        api.MapPut("/companies/{id:guid}", async (Guid id, CompanyBody body, HttpContext http, Db db) =>
        {
            http.RequireAdmin();
            var me = http.CurrentUser();
            var b = Clean(body);
            await db.Platform(async (c, tx) =>
            {
                var old = await c.QuerySingleOrDefaultAsync<CompanyRow>("select * from company where id = @id for update", new { id }, tx)
                          ?? throw new NotFoundException("Company not found.");
                await c.ExecuteAsync("""
                    update company set name = @Name, legal_name = @LegalName, legal_name_ar = @LegalNameAr, trn = @Trn, base_currency = @BaseCurrency, vat_rate = @VatRate,
                      prices_include_vat = @PricesIncludeVat, erp_connector = @ErpConnector, is_active = @IsActive where id = @id
                    """, new { b.Name, b.LegalName, b.LegalNameAr, b.Trn, b.BaseCurrency, b.VatRate, b.PricesIncludeVat, b.ErpConnector, IsActive = body.IsActive ?? old.IsActive, id }, tx);
                await Audit.RecordAsync(c, tx, id, null, me.Id, "company", id.ToString(), "changed", $"Company {old.Code} changed",
                [
                    new("Name", old.Name, b.Name), new("Legal name", old.LegalName, b.LegalName), new("TRN", old.Trn, b.Trn),
                    new("Currency", old.BaseCurrency, b.BaseCurrency), new("VAT %", old.VatRate, b.VatRate),
                    new("Prices include VAT", old.PricesIncludeVat, b.PricesIncludeVat), new("ERP", old.ErpConnector, b.ErpConnector),
                    new("Active", old.IsActive, body.IsActive ?? old.IsActive),
                ]);
                return 0;
            });
            return Results.Ok(new { id });
        });

        api.MapGet("/companies/{companyId:guid}/branches", async (Guid companyId, HttpContext http, Db db) =>
        {
            var scope = await http.ScopeAsync(db, companyId);
            return await db.Company(companyId, async (c, tx) => (await c.QueryAsync<BranchRow>("""
                select * from branch b
                where @all or exists (select 1 from user_branch ub where ub.branch_id = b.id and ub.user_id = @userId)
                order by b.name
                """, new { all = scope.IsAdmin || scope.Can("branch.manage"), scope.UserId }, tx)).ToList());
        });

        api.MapPost("/companies/{companyId:guid}/branches", async (Guid companyId, BranchBody body, HttpContext http, Db db, Live live, Erp.FactsSync facts, ILoggerFactory logs) =>
        {
            var scope = await http.ScopeAsync(db, companyId);
            if (!scope.IsAdmin) throw new ForbiddenException("Only administrators can add branches.");
            var b = Clean(body);
            var id = await db.Company(companyId, async (c, tx) =>
            {
                b = b with { Code = await BranchCodeAsync(c, tx, companyId) };
                var id = await c.ExecuteScalarAsync<Guid>("""
                    insert into branch (company_id, code, name, address, phone, time_zone, table_service, ask_guests, service_charge_pct,
                                        receipt_header, receipt_footer, day_control)
                    values (@companyId, @Code, @Name, @Address, @Phone, @TimeZone, @TableService, @AskGuests, @ServiceChargePct,
                            @ReceiptHeader, @ReceiptFooter, @DayControl) returning id
                    """, new { companyId, b.Code, b.Name, b.Address, b.Phone, b.TimeZone, b.TableService, b.AskGuests, b.ServiceChargePct,
                               b.ReceiptHeader, b.ReceiptFooter, b.DayControl }, tx);
                var d = await c.QuerySingleAsync<BranchRow>("select * from branch where id = @id", new { id }, tx);
                await c.ExecuteAsync("""
                    update branch set return_days = @days, kitchen_enabled = @kitchen, auto_open_time = @autoOpen, auto_close_time = @autoClose,
                      variance_tolerance = @tolerance, default_float = @float, open_orders_at_close = @atClose,
                      erp_location_code = @locCode, erp_location_name = @locName,
                      name_ar = @nameAr, address_ar = @addressAr, receipt_language = @receiptLang, short_stock = @shortStock,
                      pickup_mode = @pickupMode, pickup_minutes = @pickupMinutes,
                      close_delay_minutes = @delayStep, close_delay_max_minutes = @delayMax, facts_doc_prefix = @docPrefix, erp_waste_location = @wasteLoc,
                      facts_price_type = @priceType, facts_prices_include_vat = @priceInclVat, returns_enabled = @returnsOn where id = @id
                    """, new { priceType = Opt(body.FactsPriceType), priceInclVat = body.FactsPricesIncludeVat ?? true, returnsOn = body.ReturnsEnabled ?? false, wasteLoc = Opt(body.ErpWasteLocation)?.ToUpperInvariant(), docPrefix = string.IsNullOrWhiteSpace(body.FactsDocPrefix) ? await AutoPrefixAsync(c, tx, companyId, id, b.Code) : await DocPrefixAsync(c, tx, companyId, id, body.FactsDocPrefix), delayStep = Math.Clamp(body.CloseDelayMinutes ?? 15, 5, 60), delayMax = Math.Clamp(body.CloseDelayMaxMinutes ?? 120, 0, 480), pickupMode = Pickup(body.PickupMode, "off"), pickupMinutes = Minutes(body.PickupMinutes, 10), nameAr = Opt(body.NameAr), addressAr = Opt(body.AddressAr), receiptLang = Lang(body.ReceiptLanguage, "bilingual"), shortStock = Short(body.ShortStock, "allow"), id, locCode = Opt(body.ErpLocationCode), locName = Opt(body.ErpLocationCode) is null ? null : Opt(body.ErpLocationName), days = Math.Clamp(body.ReturnDays ?? 0, 0, 365), kitchen = body.KitchenEnabled ?? true, autoOpen = Time(body.AutoOpenTime, d.AutoOpenTime),
                               autoClose = Time(body.AutoCloseTime, d.AutoCloseTime), tolerance = NonNegative(body.VarianceTolerance, d.VarianceTolerance, "variance tolerance"),
                               @float = NonNegative(body.DefaultFloat, d.DefaultFloat, "float"), atClose = AtClose(body.OpenOrdersAtClose, d.OpenOrdersAtClose) }, tx);
                await Audit.RecordAsync(c, tx, companyId, id, scope.UserId, "branch", id.ToString(), "created", $"Branch {b.Code} created",
                    Audit.Created(("Code", b.Code), ("Name", b.Name), ("Table service", b.TableService)));
                return id;
            });
            if (Opt(body.ErpLocationCode) is not null) ReadPaymentModesSoon(facts, logs, companyId);
            if (Opt(body.FactsPriceType) is not null) ReadPricesSoon(facts, logs, companyId);
            await live.ToCompany(companyId, "branches.changed");
            return Results.Ok(new { id });
        });

        // Who approves this branch's wastage (null: no approval, wastage as before), the email requests go to, and the FACTS
        // username approved wastage is posted as (one allowed to post STV50 in FACTS).
        api.MapPut("/branches/{id:guid}/wastage-approval", async (Guid id, WastageApprovalBody body, HttpContext http, Db db, Live live) =>
        {
            var companyId = await db.Platform((c, tx) => c.ExecuteScalarAsync<Guid?>("select company_id from branch where id = @id", new { id }, tx))
                            ?? throw new NotFoundException("Branch not found.");
            var scope = await http.ScopeAsync(db, companyId);
            scope.Require("branch.manage");
            var (approver, email, factsUser) = Pos.WastageApproval.Clean(body.ApproverId, body.Email, body.FactsUser);
            await db.Company(companyId, async (c, tx) =>
            {
                var old = await c.QuerySingleAsync<BranchRow>("select * from branch where id = @id for update", new { id }, tx);
                string? name = null;
                if (approver is { } a)
                {
                    name = await c.ExecuteScalarAsync<string?>(
                        "select u.display_name from app_user u where u.id = @a and u.is_active and (u.is_admin or exists (select 1 from user_company uc where uc.user_id = u.id and uc.company_id = @companyId))",
                        new { a, companyId }, tx) ?? throw new DomainException("Choose an active user of this company as the approver.");
                    if (email is null) throw new DomainException($"Enter the email {name}'s wastage requests go to.");
                }
                await c.ExecuteAsync("update branch set wastage_approver_id = @approver, wastage_approval_email = @email, wastage_facts_user = @factsUser where id = @id",
                    new { approver, email = approver is null ? null : email, factsUser = approver is null ? null : factsUser, id }, tx);
                var oldName = old.WastageApproverId is { } o ? await c.ExecuteScalarAsync<string?>("select display_name from app_user where id = @o", new { o }, tx) : null;
                await Audit.RecordAsync(c, tx, companyId, id, scope.UserId, "branch", id.ToString(), "changed", $"Branch {old.Code}: wastage approval {(approver is null ? "off" : "set")}",
                [
                    new("Wastage approver", oldName, name), new("Approval email", old.WastageApprovalEmail, approver is null ? null : email),
                    new("FACTS username", old.WastageFactsUser, approver is null ? null : factsUser),
                ]);
                return 0;
            });
            await live.ToCompany(companyId, "branches.changed");
            return Results.Ok(new { ok = true });
        });

        // Marketing give-aways at this branch (null approver: off, no Marketing tab): who approves them, the email requests go to, the
        // FACTS username the approved MCV50 is posted as (one allowed MCV50 "Transaction Posting") and the expense account it debits.
        api.MapPut("/branches/{id:guid}/marketing", async (Guid id, MarketingBody body, HttpContext http, Db db, Live live) =>
        {
            var companyId = await db.Platform((c, tx) => c.ExecuteScalarAsync<Guid?>("select company_id from branch where id = @id", new { id }, tx))
                            ?? throw new NotFoundException("Branch not found.");
            var scope = await http.ScopeAsync(db, companyId);
            scope.Require("branch.manage");
            var (approver, email, factsUser) = Pos.WastageApproval.Clean(body.ApproverId, body.Email, body.FactsUser);
            var account = string.IsNullOrWhiteSpace(body.Account) ? null : body.Account.Trim();
            if (account is not null && !System.Text.RegularExpressions.Regex.IsMatch(account, "^[A-Za-z0-9._-]{1,20}$"))
                throw new DomainException("The expense account is a FACTS account code (e.g. 8003).");
            await db.Company(companyId, async (c, tx) =>
            {
                var old = await c.QuerySingleAsync<BranchRow>("select * from branch where id = @id for update", new { id }, tx);
                string? name = null;
                if (approver is { } a)
                {
                    name = await c.ExecuteScalarAsync<string?>(
                        "select u.display_name from app_user u where u.id = @a and u.is_active and (u.is_admin or exists (select 1 from user_company uc where uc.user_id = u.id and uc.company_id = @companyId))",
                        new { a, companyId }, tx) ?? throw new DomainException("Choose an active user of this company as the approver.");
                    if (email is null) throw new DomainException($"Enter the email {name}'s marketing requests go to.");
                    if (account is null) throw new DomainException("Enter the FACTS expense account marketing is posted to (e.g. 8003).");
                }
                var on = approver is not null;
                await c.ExecuteAsync("""
                    update branch set marketing_approver_id = @approver, marketing_approval_email = @email, marketing_facts_user = @factsUser, marketing_account = @account
                    where id = @id
                    """, new { approver, email = on ? email : null, factsUser = on ? factsUser : null, account = on ? account : null, id }, tx);
                var oldName = old.MarketingApproverId is { } o ? await c.ExecuteScalarAsync<string?>("select display_name from app_user where id = @o", new { o }, tx) : null;
                await Audit.RecordAsync(c, tx, companyId, id, scope.UserId, "branch", id.ToString(), "changed", $"Branch {old.Code}: marketing {(on ? "set" : "off")}",
                [
                    new("Marketing approver", oldName, name), new("Approval email", old.MarketingApprovalEmail, on ? email : null),
                    new("FACTS username", old.MarketingFactsUser, on ? factsUser : null), new("Expense account", old.MarketingAccount, on ? account : null),
                ]);
                return 0;
            });
            await live.ToCompany(companyId, "branches.changed");
            return Results.Ok(new { ok = true });
        });

        // Where this branch's discount requests are emailed when the cashier sends them to a manager (empty: no email).
        api.MapPut("/branches/{id:guid}/discount-approval", async (Guid id, DiscountApprovalBody body, HttpContext http, Db db, Live live) =>
        {
            var companyId = await db.Platform((c, tx) => c.ExecuteScalarAsync<Guid?>("select company_id from branch where id = @id", new { id }, tx))
                            ?? throw new NotFoundException("Branch not found.");
            var scope = await http.ScopeAsync(db, companyId);
            scope.Require("branch.manage");
            var emails = Pos.Approvals.CleanEmails(body.Emails);
            await db.Company(companyId, async (c, tx) =>
            {
                var old = await c.QuerySingleAsync<BranchRow>("select * from branch where id = @id for update", new { id }, tx);
                await c.ExecuteAsync("update branch set discount_approval_emails = @emails where id = @id", new { emails, id }, tx);
                await Audit.RecordAsync(c, tx, companyId, id, scope.UserId, "branch", id.ToString(), "changed", $"Branch {old.Code}: discount approval email {(emails is null ? "off" : "set")}",
                    [new("Discount approval email", old.DiscountApprovalEmails is null ? null : string.Join(", ", old.DiscountApprovalEmails), emails is null ? null : string.Join(", ", emails))]);
                return 0;
            });
            await live.ToCompany(companyId, "branches.changed");
            return Results.Ok(new { ok = true });
        });

        api.MapPut("/branches/{id:guid}", async (Guid id, BranchBody body, HttpContext http, Db db, Live live, Erp.FactsSync facts, ILoggerFactory logs) =>
        {
            var companyId = await db.Platform((c, tx) => c.ExecuteScalarAsync<Guid?>("select company_id from branch where id = @id", new { id }, tx))
                            ?? throw new NotFoundException("Branch not found.");
            var scope = await http.ScopeAsync(db, companyId);
            scope.Require("branch.manage");
            var b = Clean(body);
            var locationChanged = await db.Company(companyId, async (c, tx) =>
            {
                var old = await c.QuerySingleAsync<BranchRow>("select * from branch where id = @id for update", new { id }, tx);
                if (!scope.IsAdmin && body.IsActive is false && old.IsActive) throw new ForbiddenException("Only administrators can close a branch.");
                // MOD-01: table service can't go off while dine-in orders are open.
                if (old.TableService && !b.TableService.GetValueOrDefault(true))
                {
                    var open = await c.ExecuteScalarAsync<int>("select count(*) from pos_order where branch_id = @id and status = 'open' and order_type = 'dine_in'", new { id }, tx);
                    if (open > 0) throw new DomainException($"Close the {open} open dine-in order{(open == 1 ? "" : "s")} before turning table service off.");
                }
                await c.ExecuteAsync("""
                    update branch set name = @Name, address = @Address, phone = @Phone, time_zone = @TimeZone, table_service = @TableService,
                      ask_guests = @AskGuests, service_charge_pct = @ServiceChargePct, receipt_header = @ReceiptHeader, receipt_footer = @ReceiptFooter,
                      day_control = @DayControl, is_active = @IsActive, return_days = @ReturnDays, kitchen_enabled = @kitchen, auto_open_time = @autoOpen,
                      auto_close_time = @autoClose, variance_tolerance = @tolerance, default_float = @float, open_orders_at_close = @atClose,
                      erp_location_code = @locCode, erp_location_name = @locName,
                      name_ar = @nameAr, address_ar = @addressAr, receipt_language = @receiptLang, short_stock = @shortStock,
                      pickup_mode = @pickupMode, pickup_minutes = @pickupMinutes,
                      close_delay_minutes = @delayStep, close_delay_max_minutes = @delayMax, facts_doc_prefix = @docPrefix, erp_waste_location = @wasteLoc,
                      facts_price_type = @priceType, facts_prices_include_vat = @priceInclVat, returns_enabled = @returnsOn where id = @id
                    """, new { priceType = body.FactsPriceType is null ? old.FactsPriceType : Opt(body.FactsPriceType),
                               priceInclVat = body.FactsPricesIncludeVat ?? old.FactsPricesIncludeVat, returnsOn = body.ReturnsEnabled ?? old.ReturnsEnabled,
                               wasteLoc = body.ErpWasteLocation is null ? old.ErpWasteLocation : Opt(body.ErpWasteLocation)?.ToUpperInvariant(),
                               docPrefix = !string.IsNullOrWhiteSpace(body.FactsDocPrefix) ? await DocPrefixAsync(c, tx, companyId, id, body.FactsDocPrefix)
                                   : old.FactsDocPrefix ?? await AutoPrefixAsync(c, tx, companyId, id, old.Code),
                               delayStep = Math.Clamp(body.CloseDelayMinutes ?? old.CloseDelayMinutes, 5, 60), delayMax = Math.Clamp(body.CloseDelayMaxMinutes ?? old.CloseDelayMaxMinutes, 0, 480),
                               pickupMode = Pickup(body.PickupMode, old.PickupMode), pickupMinutes = Minutes(body.PickupMinutes, old.PickupMinutes), shortStock = Short(body.ShortStock, old.ShortStock), nameAr = body.NameAr is null ? old.NameAr : Opt(body.NameAr), addressAr = body.AddressAr is null ? old.AddressAr : Opt(body.AddressAr), receiptLang = Lang(body.ReceiptLanguage, old.ReceiptLanguage), b.Name, b.Address, b.Phone, b.TimeZone, b.TableService, b.AskGuests, b.ServiceChargePct, b.ReceiptHeader, b.ReceiptFooter,
                               b.DayControl, IsActive = body.IsActive ?? old.IsActive, ReturnDays = Math.Clamp(body.ReturnDays ?? old.ReturnDays, 0, 365), id,
                               kitchen = body.KitchenEnabled ?? old.KitchenEnabled, autoOpen = Time(body.AutoOpenTime, old.AutoOpenTime), autoClose = Time(body.AutoCloseTime, old.AutoCloseTime),
                               tolerance = NonNegative(body.VarianceTolerance, old.VarianceTolerance, "variance tolerance"), @float = NonNegative(body.DefaultFloat, old.DefaultFloat, "float"),
                               atClose = AtClose(body.OpenOrdersAtClose, old.OpenOrdersAtClose),
                               locCode = body.ErpLocationCode is null ? old.ErpLocationCode : Opt(body.ErpLocationCode),
                               locName = body.ErpLocationCode is null ? old.ErpLocationName : Opt(body.ErpLocationCode) is null ? null : Opt(body.ErpLocationName) }, tx);
                await Audit.RecordAsync(c, tx, companyId, id, scope.UserId, "branch", id.ToString(), "changed", $"Branch {old.Code} changed",
                [
                    new("Name", old.Name, b.Name), new("Address", old.Address, b.Address), new("Phone", old.Phone, b.Phone),
                    new("Time zone", old.TimeZone, b.TimeZone), new("Table service", old.TableService, b.TableService),
                    new("Ask guests", old.AskGuests, b.AskGuests), new("Service charge %", old.ServiceChargePct, b.ServiceChargePct),
                    new("Receipt header", old.ReceiptHeader, b.ReceiptHeader), new("Receipt footer", old.ReceiptFooter, b.ReceiptFooter),
                    new("Day control", old.DayControl, b.DayControl), new("Active", old.IsActive, body.IsActive ?? old.IsActive),
                    new("Kitchen", old.KitchenEnabled, body.KitchenEnabled ?? old.KitchenEnabled),
                    new("Float", old.DefaultFloat, body.DefaultFloat ?? old.DefaultFloat), new("Variance tolerance", old.VarianceTolerance, body.VarianceTolerance ?? old.VarianceTolerance),
                    new("Auto open", old.AutoOpenTime.ToString("HH:mm"), body.AutoOpenTime ?? old.AutoOpenTime.ToString("HH:mm")),
                    new("Auto close", old.AutoCloseTime.ToString("HH:mm"), body.AutoCloseTime ?? old.AutoCloseTime.ToString("HH:mm")),
                    new("Open orders at close", old.OpenOrdersAtClose, body.OpenOrdersAtClose ?? old.OpenOrdersAtClose),
                    new("Order-ready screen", old.PickupMode, body.PickupMode ?? old.PickupMode),
                    new("Ready numbers stay (minutes)", old.PickupMinutes, body.PickupMinutes ?? old.PickupMinutes),
                    new("Closing delay step (minutes)", old.CloseDelayMinutes, body.CloseDelayMinutes ?? old.CloseDelayMinutes),
                    new("Closing delay limit (minutes)", old.CloseDelayMaxMinutes, body.CloseDelayMaxMinutes ?? old.CloseDelayMaxMinutes),
                    new("When ingredients run short", old.ShortStock, body.ShortStock ?? old.ShortStock),
                    new("FACTS wastage location", old.ErpWasteLocation, body.ErpWasteLocation is null ? old.ErpWasteLocation : Opt(body.ErpWasteLocation)?.ToUpperInvariant()),
                    new("FACTS number prefix", old.FactsDocPrefix, body.FactsDocPrefix is null ? old.FactsDocPrefix : body.FactsDocPrefix.Trim().ToUpperInvariant()),
                    new("ERP stock location", old.ErpLocationCode, body.ErpLocationCode is null ? old.ErpLocationCode : Opt(body.ErpLocationCode)),
                    new("FACTS price type", old.FactsPriceType, body.FactsPriceType is null ? old.FactsPriceType : Opt(body.FactsPriceType)),
                    new("FACTS prices include VAT", old.FactsPricesIncludeVat, body.FactsPricesIncludeVat ?? old.FactsPricesIncludeVat),
                    new("Returns", old.ReturnsEnabled, body.ReturnsEnabled ?? old.ReturnsEnabled),
                ]);
                var prices = (body.FactsPriceType is not null && Opt(body.FactsPriceType) != old.FactsPriceType)
                             || (body.FactsPricesIncludeVat is { } v && v != old.FactsPricesIncludeVat);
                return (Location: body.ErpLocationCode is not null && Opt(body.ErpLocationCode) is not null && Opt(body.ErpLocationCode) != old.ErpLocationCode, Prices: prices);
            });
            // A new FACTS location: its card types and payment methods are read from FACTS straight away (and every hour after).
            if (locationChanged.Location) ReadPaymentModesSoon(facts, logs, companyId);
            // A new price type (or VAT treatment): the outlet's prices are read straight away (and every 5 minutes after).
            if (locationChanged.Prices) ReadPricesSoon(facts, logs, companyId);
            await live.ToBranch(id, "branch.changed", new { id });
            await live.ToCompany(companyId, "branches.changed");
            return Results.Ok(new { id });
        });
    }

    private static string? Opt(string? s) => string.IsNullOrWhiteSpace(s) ? null : s.Trim();

    private static string Lang(string? s, string old) =>
        s is null ? old : s.Trim().ToLowerInvariant() is "en" or "bilingual" ? s.Trim().ToLowerInvariant() : throw new DomainException("Receipts are in English, or in English and Arabic.");

    /// <summary>Reads the company's FACTS card types and payment methods in the background (a FACTS company with a saved connection).</summary>
    private static void ReadPricesSoon(Erp.FactsSync facts, ILoggerFactory logs, Guid companyId) =>
        _ = Task.Run(async () =>
        {
            try { await facts.SyncPricesAsync(companyId, null); }
            catch (Exception e) { logs.CreateLogger("OnePos.Erp").LogWarning("Reading FACTS prices for {Company} failed: {Message}", companyId, e.Message); }
        });

    private static void ReadPaymentModesSoon(Erp.FactsSync facts, ILoggerFactory logs, Guid companyId) =>
        _ = Task.Run(async () =>
        {
            try { await facts.SyncPaymentModesAsync(companyId, null); }
            catch (Exception e) { logs.CreateLogger("OnePos.Erp").LogWarning("Reading FACTS payment methods for {Company} failed: {Message}", companyId, e.Message); }
        });

    private static string Pickup(string? s, string old) =>
        s is null ? old : s.Trim().ToLowerInvariant() is "off" or "auto" or "cashier" ? s.Trim().ToLowerInvariant() : throw new DomainException("The order-ready screen is off, automatic, or marked by the cashier.");

    private static int Minutes(int? n, int old) =>
        n is null ? old : n is >= 1 and <= 120 ? n.Value : throw new DomainException("Ready numbers stay 1 to 120 minutes.");

    private static string Short(string? s, string old) =>
        s is null ? old : s.Trim().ToLowerInvariant() is "allow" or "warn" or "block" ? s.Trim().ToLowerInvariant() : throw new DomainException("When ingredients run short: allow, warn or block.");

    private static TimeOnly Time(string? s, TimeOnly old) =>
        string.IsNullOrWhiteSpace(s) ? old : TimeOnly.TryParse(s.Trim(), System.Globalization.CultureInfo.InvariantCulture, out var t) ? t : throw new DomainException($"Enter a time like 10:00, not \"{s}\".");

    private static decimal NonNegative(decimal? v, decimal old, string what) =>
        v is null ? old : v < 0 ? throw new DomainException($"The {what} can't be negative.") : Money.Round(v.Value);

    private static string AtClose(string? s, string old) =>
        s is null ? old : s.Trim().ToLowerInvariant() is "carry" or "void_unsent" ? s.Trim().ToLowerInvariant() : throw new DomainException("Open orders at day close are carried over, or the unsent ones voided.");

    private static CompanyBody Clean(CompanyBody b)
    {
        var connector = (b.ErpConnector ?? "none").Trim().ToLowerInvariant();
        if (!Connectors.Contains(connector)) throw new DomainException("The ERP connection must be None, AWS One or FACTS.");
        var vat = b.VatRate ?? 5;
        if (vat is < 0 or > 100) throw new DomainException("The VAT rate must be between 0 and 100 %.");
        if (string.IsNullOrWhiteSpace(b.Name)) throw new DomainException("Enter the company's name.");
        return new CompanyBody((b.Code ?? "").Trim().ToUpperInvariant(), b.Name.Trim(), Opt(b.LegalName) ?? b.Name.Trim(), Opt(b.Trn),
            (Opt(b.BaseCurrency) ?? "AED").ToUpperInvariant(), vat, b.PricesIncludeVat ?? true, connector, b.IsActive, Opt(b.LegalNameAr));
    }

    private static BranchBody Clean(BranchBody b)
    {
        var day = (b.DayControl ?? "manual").Trim().ToLowerInvariant();
        if (!DayControls.Contains(day)) throw new DomainException("Day control must be Manual, Automatic or Cashier-run.");
        var sc = b.ServiceChargePct ?? 0;
        if (sc is < 0 or > 100) throw new DomainException("The service charge must be between 0 and 100 %.");
        if (string.IsNullOrWhiteSpace(b.Name)) throw new DomainException("Enter the branch's name.");
        var tz = Opt(b.TimeZone) ?? "Asia/Dubai";
        if (!TimeZoneInfo.TryFindSystemTimeZoneById(tz, out _)) throw new DomainException($"Unknown time zone: {tz}.");
        return new BranchBody((b.Code ?? "").Trim().ToUpperInvariant(), b.Name.Trim(), Opt(b.Address), Opt(b.Phone), tz, b.TableService ?? true,
            b.AskGuests ?? true, sc, Opt(b.ReceiptHeader), Opt(b.ReceiptFooter), day, b.IsActive);
    }

    /// <summary>
    /// A new company's code, made from its name: the first letters of its first three words, filled up from the last word to 3 letters
    /// ("European Bakery" -> EBA, "Al Baraka Foods Trading" -> ABF). Taken already: EB1 … EB9, then E01 … E99.
    /// </summary>
    private static async Task<string> CompanyCodeAsync(Npgsql.NpgsqlConnection c, Npgsql.NpgsqlTransaction tx, string name)
    {
        var words = name.ToUpperInvariant().Split(' ', StringSplitOptions.RemoveEmptyEntries)
            .Select(w => new string(w.Where(char.IsAsciiLetterOrDigit).ToArray())).Where(w => w.Length > 0).ToList();
        if (words.Count == 0) words.Add("CO");
        var p = string.Concat(words.Take(3).Select(w => w[0]));
        var last = words[Math.Min(words.Count, 3) - 1];
        for (var i = 1; p.Length < 3 && i < last.Length; i++) p += last[i];
        while (p.Length < 3) p += "X";
        if (!char.IsAsciiLetter(p[0])) p = "C" + p[..2];
        var used = (await c.QueryAsync<string>("select code from company", transaction: tx)).ToHashSet();
        var tries = new List<string> { p };
        tries.AddRange(Enumerable.Range(1, 9).Select(i => $"{p[..2]}{i}"));
        tries.AddRange(Enumerable.Range(1, 99).Select(i => $"{p[..1]}{i:00}"));
        return tries.FirstOrDefault(t => !used.Contains(t)) ?? throw new DomainException("No free company code left for that name; choose another name.");
    }

    /// <summary>A new branch's code: the company's code and the next number (EBK-01, EBK-02, …).</summary>
    private static async Task<string> BranchCodeAsync(Npgsql.NpgsqlConnection c, Npgsql.NpgsqlTransaction tx, Guid companyId)
    {
        var co = await c.ExecuteScalarAsync<string>("select code from company where id = @companyId", new { companyId }, tx) ?? "BR";
        co = co.Length > 8 ? co[..8] : co;
        var used = (await c.QueryAsync<string>("select code from branch where company_id = @companyId", new { companyId }, tx)).ToHashSet();
        var n = used.Count + 1;
        while (used.Contains($"{co}-{n:00}")) n++;
        return $"{co}-{n:00}";
    }

    /// <summary>
    /// A branch's FACTS number prefix, made up for it: its code's first 4 letters and digits (EB-QS -> EBQS; a code starting with a
    /// digit gets a B in front), and where another branch of the company has that, a numbered one (DXB1 … DXB9, then DX01 … DX99).
    /// </summary>
    private static async Task<string> AutoPrefixAsync(Npgsql.NpgsqlConnection c, Npgsql.NpgsqlTransaction tx, Guid companyId, Guid branchId, string code)
    {
        var p = new string(code.Where(char.IsAsciiLetterOrDigit).ToArray()).ToUpperInvariant();
        // A made-up branch code (EBK-01): the company's letters and the branch number, EBK1 … EBK9, EB10 … EB99.
        if (System.Text.RegularExpressions.Regex.Match(code.ToUpperInvariant(), "^([A-Z][A-Z0-9]*)-(\\d+)$") is { Success: true } m && int.TryParse(m.Groups[2].Value, out var num) && num is > 0 and < 100)
        {
            var letters = m.Groups[1].Value;
            p = num < 10 ? $"{letters[..Math.Min(3, letters.Length)]}{num}" : $"{letters[..Math.Min(2, letters.Length)]}{num}";
        }
        if (p.Length == 0 || !char.IsAsciiLetter(p[0])) p = "B" + p;
        if (p.Length < 2) p += "0";
        var used = (await c.QueryAsync<string>("select facts_doc_prefix from branch where company_id = @companyId and id <> @branchId and facts_doc_prefix is not null",
            new { companyId, branchId }, tx)).ToHashSet();
        var tries = new List<string> { p.Length > 4 ? p[..4] : p };
        tries.AddRange(Enumerable.Range(1, 9).Select(i => $"{p[..Math.Min(3, p.Length)]}{i}"));
        tries.AddRange(Enumerable.Range(1, 99).Select(i => $"{p[..Math.Min(2, p.Length)]}{i:00}"));
        return tries.First(t => !used.Contains(t));
    }

    /// <summary>
    /// A FACTS number prefix as typed (empty = none), checked: 2 to 4 letters or digits starting with a letter, and no other branch of
    /// the company using it (FACTS keeps one number range for all outlets).
    /// </summary>
    private static async Task<string?> DocPrefixAsync(Npgsql.NpgsqlConnection c, Npgsql.NpgsqlTransaction tx, Guid companyId, Guid branchId, string? typed)
    {
        var p = typed?.Trim().ToUpperInvariant();
        if (string.IsNullOrEmpty(p)) return null;
        if (!System.Text.RegularExpressions.Regex.IsMatch(p, "^[A-Z][A-Z0-9]{1,3}$"))
            throw new DomainException("The FACTS number prefix is 2 to 4 letters or digits, starting with a letter (e.g. EBQS).");
        var other = await c.ExecuteScalarAsync<string?>("select code from branch where company_id = @companyId and facts_doc_prefix = @p and id <> @branchId",
            new { companyId, p, branchId }, tx);
        if (other is not null) throw new DomainException($"Branch {other} already uses the FACTS number prefix {p}.");
        return p;
    }
}
