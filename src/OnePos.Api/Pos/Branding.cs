using System.Text.Json;
using Dapper;
using OnePos.Api.Data;
using OnePos.Api.Platform;

namespace OnePos.Api.Pos;

/// <summary>
/// Branding: the company logo (top of receipts and credit notes, on screen and the customer display), what each branch's receipt
/// header shows, and the pictures the customer display shows between orders. Images are checked by content (JPEG, PNG, WebP),
/// at most 2 MB, stored next to the menu photos and served with their version in the address (cached hard, never stale).
/// </summary>
public static class Branding
{
    private const long MaxBytes = 2 * 1024 * 1024;

    public sealed record ReceiptBody(string? Language, string? Header, string? Footer, string? Email, string? Website, JsonElement? Settings);
    public sealed record ImageChange(string? Caption, int? Seconds, int? Sort, bool? IsActive, DateOnly? StartsOn, DateOnly? EndsOn, bool? AllBranches);

    public sealed class ImageRow
    {
        public Guid Id { get; set; }
        public Guid CompanyId { get; set; }
        public Guid? BranchId { get; set; }
        public string? BranchCode { get; set; }
        public string File { get; set; } = "";
        public string? Caption { get; set; }
        public int Seconds { get; set; }
        public int Sort { get; set; }
        public bool IsActive { get; set; }
        public DateOnly? StartsOn { get; set; }
        public DateOnly? EndsOn { get; set; }
        public DateTime CreatedAt { get; set; }
    }

    /// <summary>
    /// What a branch's receipt header shows, in what order. `Order`: the header lines top to bottom; `Show`: each header line and
    /// the order details (table, customer, cashier) on or off; `NameSource`: which name prints — the legal name, the trading name,
    /// custom text (English and Arabic), or none (e.g. when the logo already shows it).
    /// </summary>
    public sealed record HeaderSettings(string[] Order, Dictionary<string, bool> Show, string NameSource, string? CustomName, string? CustomNameAr);

    public static readonly string[] HeaderKeys = ["logo", "name", "nameAr", "branch", "branchAr", "address", "phone", "email", "website", "trn"];
    private static readonly string[] NameSources = ["legal", "trading", "custom", "none"];
    private static readonly JsonSerializerOptions Web = new(JsonSerializerDefaults.Web);

    /// <summary>The settings with defaults filled in; also reads the first (flat "showLogo": true …) form.</summary>
    public static HeaderSettings Settings(string? json)
    {
        var show = new Dictionary<string, bool>
        {
            ["logo"] = true, ["name"] = true, ["nameAr"] = true, ["branch"] = true, ["branchAr"] = true, ["address"] = true, ["phone"] = true,
            ["email"] = false, ["website"] = false, ["trn"] = true, ["table"] = true, ["customer"] = true, ["cashier"] = true,
            ["qr"] = false,   // a QR code to the digital receipt (REQ PAY-05), off unless the branch prints it
        };
        var order = HeaderKeys.ToList();
        string source = "legal";
        string? customName = null, customNameAr = null;
        if (!string.IsNullOrWhiteSpace(json))
        {
            using var doc = JsonDocument.Parse(json);
            var r = doc.RootElement;
            if (r.ValueKind != JsonValueKind.Object) return new HeaderSettings([.. order], show, source, null, null);
            // The first form: flat switches.
            var old = new Dictionary<string, string[]>
            {
                ["showLogo"] = ["logo"], ["showLegalName"] = ["name", "nameAr"], ["showAddress"] = ["address"], ["showPhone"] = ["phone"], ["showTrn"] = ["trn"],
                ["showEmail"] = ["email"], ["showWebsite"] = ["website"], ["showCashier"] = ["cashier"], ["showCustomer"] = ["customer"], ["showTable"] = ["table"],
            };
            foreach (var p in r.EnumerateObject())
                if (old.TryGetValue(p.Name, out var keys) && p.Value.ValueKind is JsonValueKind.True or JsonValueKind.False)
                    foreach (var k in keys) show[k] = p.Value.GetBoolean();
            if (r.TryGetProperty("show", out var sh) && sh.ValueKind == JsonValueKind.Object)
                foreach (var p in sh.EnumerateObject())
                    if (show.ContainsKey(p.Name) && p.Value.ValueKind is JsonValueKind.True or JsonValueKind.False) show[p.Name] = p.Value.GetBoolean();
            if (r.TryGetProperty("order", out var ord) && ord.ValueKind == JsonValueKind.Array)
            {
                var given = ord.EnumerateArray().Where(x => x.ValueKind == JsonValueKind.String).Select(x => x.GetString()!).Where(HeaderKeys.Contains).Distinct().ToList();
                order = [.. given, .. HeaderKeys.Where(k => !given.Contains(k))];
            }
            if (r.TryGetProperty("nameSource", out var ns) && ns.ValueKind == JsonValueKind.String && NameSources.Contains(ns.GetString())) source = ns.GetString()!;
            static string? Text(JsonElement e, string n) => e.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(v.GetString()) ? v.GetString()!.Trim() : null;
            customName = Text(r, "customName");
            customNameAr = Text(r, "customNameAr");
        }
        if (source == "custom" && customName is null) source = "legal";
        return new HeaderSettings([.. order], show, source, customName, customNameAr);
    }

    public static string Serialize(HeaderSettings s) => JsonSerializer.Serialize(s, Web);

    private static async Task<(byte[] Bytes, string Ext)> ReadAsync(IFormFile file)
    {
        if (file.Length == 0) throw new DomainException("The file is empty.");
        if (file.Length > MaxBytes) throw new DomainException("An image can be at most 2 MB.");
        await using var ms = new MemoryStream();
        await file.CopyToAsync(ms);
        var bytes = ms.ToArray();
        return (bytes, ItemImages.Kind(bytes) ?? throw new DomainException("Use a JPEG, PNG or WebP image."));
    }

    private static string TypeOf(string path) => Path.GetExtension(path) switch { ".png" => "image/png", ".webp" => "image/webp", _ => "image/jpeg" };

    public static void Map(WebApplication app, RouteGroupBuilder api, IConfiguration config, IWebHostEnvironment env)
    {
        var root = config["Images:Root"] ?? Path.GetFullPath(Path.Combine(env.ContentRootPath, "..", "..", "data", "images"));

        // ---- The company logo ------------------------------------------------------------------------------------------
        api.MapPost("/companies/{companyId:guid}/logo", async (Guid companyId, IFormFile file, HttpContext http, Db db, Live live) =>
        {
            var scope = await http.ScopeAsync(db, companyId);
            scope.Require("branch.manage");
            var (bytes, ext) = await ReadAsync(file);
            var dir = Path.Combine(root, companyId.ToString("N"));
            Directory.CreateDirectory(dir);
            var name = $"logo-{DateTime.UtcNow:yyyyMMddHHmmssfff}.{ext}";
            var old = await db.Company(companyId, async (c, tx) =>
            {
                var prev = await c.ExecuteScalarAsync<string?>("select logo_file from company where id = @companyId for update", new { companyId }, tx);
                await File.WriteAllBytesAsync(Path.Combine(dir, name), bytes);
                await c.ExecuteAsync("update company set logo_file = @name, logo_at = now() where id = @companyId", new { companyId, name }, tx);
                await Audit.RecordAsync(c, tx, companyId, null, scope.UserId, "company", companyId.ToString(), "logo", prev is null ? "Logo added" : "Logo replaced");
                return prev;
            });
            if (old is not null) ItemImages.TryDelete(Path.Combine(dir, old));
            await live.ToCompany(companyId, "branding.changed");
            return Results.Ok(new { ok = true });
        }).DisableAntiforgery();

        api.MapDelete("/companies/{companyId:guid}/logo", async (Guid companyId, HttpContext http, Db db, Live live) =>
        {
            var scope = await http.ScopeAsync(db, companyId);
            scope.Require("branch.manage");
            var old = await db.Company(companyId, async (c, tx) =>
            {
                var prev = await c.ExecuteScalarAsync<string?>("select logo_file from company where id = @companyId for update", new { companyId }, tx);
                await c.ExecuteAsync("update company set logo_file = null, logo_at = now() where id = @companyId", new { companyId }, tx);
                await Audit.RecordAsync(c, tx, companyId, null, scope.UserId, "company", companyId.ToString(), "logo", "Logo removed");
                return prev;
            });
            if (old is not null) ItemImages.TryDelete(Path.Combine(root, companyId.ToString("N"), old));
            await live.ToCompany(companyId, "branding.changed");
            return Results.Ok(new { ok = true });
        });

        api.MapGet("/companies/{companyId:guid}/logo", async (Guid companyId, HttpContext http, Db db) =>
        {
            await http.ScopeAsync(db, companyId);
            var file = await db.Company(companyId, (c, tx) => c.ExecuteScalarAsync<string?>("select logo_file from company where id = @companyId", new { companyId }, tx));
            var path = file is null ? null : Path.Combine(root, companyId.ToString("N"), file);
            if (path is null || !File.Exists(path)) return Results.NotFound();
            http.Response.Headers.CacheControl = "private, max-age=31536000, immutable";
            return Results.File(path, TypeOf(path));
        });

        // The digital receipt page (no sign-in) shows the logo of the receipt's company, found by the receipt's link.
        app.MapGet("/api/public/receipts/{token}/logo", async (string token, Db db) =>
        {
            var companyId = await db.Platform((c, tx) => c.ExecuteScalarAsync<Guid?>("select company_id from receipt_link where token = @token", new { token }, tx));
            if (companyId is not { } co) return Results.NotFound();
            var file = await db.Company(co, (c, tx) => c.ExecuteScalarAsync<string?>("select logo_file from company where id = @co", new { co }, tx));
            var path = file is null ? null : Path.Combine(root, co.ToString("N"), file);
            return path is null || !File.Exists(path) ? Results.NotFound() : Results.File(path, TypeOf(path));
        }).AllowAnonymous();

        // ---- What the branch's receipt shows ------------------------------------------------------------------------------
        api.MapGet("/branches/{id:guid}/receipt", async (Guid id, HttpContext http, Db db) =>
        {
            var companyId = await db.Platform((c, tx) => c.ExecuteScalarAsync<Guid?>("select company_id from branch where id = @id", new { id }, tx)) ?? throw new NotFoundException("Branch not found.");
            var scope = await http.ScopeAsync(db, companyId);
            scope.Require("branch.manage");
            return await db.Company(companyId, async (c, tx) =>
            {
                var b = await c.QuerySingleAsync<(string Language, string? Header, string? Footer, string Settings, string? Email, string? Website, DateTime? LogoAt, bool HasLogo, string TradingName)>("""
                    select b.receipt_language, b.receipt_header, b.receipt_footer, b.receipt_settings::text, co.email, co.website, co.logo_at, co.logo_file is not null, co.name
                    from branch b join company co on co.id = b.company_id where b.id = @id
                    """, new { id }, tx);
                return new { language = b.Language, header = b.Header, footer = b.Footer, email = b.Email, website = b.Website, settings = Settings(b.Settings), logoAt = b.HasLogo ? b.LogoAt : null, tradingName = b.TradingName };
            });
        });

        api.MapPut("/branches/{id:guid}/receipt", async (Guid id, ReceiptBody body, HttpContext http, Db db, Live live) =>
        {
            var companyId = await db.Platform((c, tx) => c.ExecuteScalarAsync<Guid?>("select company_id from branch where id = @id", new { id }, tx)) ?? throw new NotFoundException("Branch not found.");
            var scope = await http.ScopeAsync(db, companyId);
            scope.Require("branch.manage");
            var lang = (body.Language ?? "bilingual").Trim().ToLowerInvariant();
            if (lang is not ("en" or "bilingual")) throw new DomainException("Receipts are in English, or in English and Arabic.");
            static string? Opt(string? s) => string.IsNullOrWhiteSpace(s) ? null : s.Trim();
            var settings = Serialize(Settings(body.Settings?.GetRawText()));
            if (Settings(settings) is { NameSource: "custom", CustomName: { Length: > 100 } }) throw new DomainException("The name on the receipt is at most 100 characters.");
            if ((Opt(body.Header)?.Length ?? 0) > 500 || (Opt(body.Footer)?.Length ?? 0) > 500) throw new DomainException("Header and footer are at most 500 characters each.");
            await db.Company(companyId, async (c, tx) =>
            {
                await c.ExecuteAsync("""
                    update branch set receipt_language = @lang, receipt_header = @header, receipt_footer = @footer, receipt_settings = cast(@settings as jsonb) where id = @id
                    """, new { id, lang, header = Opt(body.Header), footer = Opt(body.Footer), settings }, tx);
                await c.ExecuteAsync("update company set email = @email, website = @website where id = @companyId", new { companyId, email = Opt(body.Email), website = Opt(body.Website) }, tx);
                await Audit.RecordAsync(c, tx, companyId, id, scope.UserId, "branch", id.ToString(), "receipt", "Receipt layout changed");
                return 0;
            });
            await live.ToBranch(id, "branding.changed");
            return Results.Ok(new { ok = true });
        });

        // ---- Customer display pictures --------------------------------------------------------------------------------------
        // For the display itself: what shows at this branch today (company-wide and this branch's), in order.
        api.MapGet("/display/images", async (HttpContext http, Db db, bool? all) =>
        {
            var scope = await http.ScopeAsync(db);
            if (all == true) scope.Require("branch.manage");
            return await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var today = await Days.DateAsync(c, tx, scope.Branch);
                return await c.QueryAsync<ImageRow>("""
                    select d.*, b.code as branch_code from display_image d left join branch b on b.id = d.branch_id
                    where (@all or (d.is_active and (d.branch_id is null or d.branch_id = @branch)
                                    and (d.starts_on is null or d.starts_on <= @today) and (d.ends_on is null or d.ends_on >= @today)))
                    order by d.sort, d.created_at
                    """, new { all = all == true, branch = scope.Branch, today }, tx);
            });
        });

        api.MapPost("/display/images", async (IFormFile file, HttpContext http, Db db, Live live, bool? allBranches) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("branch.manage");
            var (bytes, ext) = await ReadAsync(file);
            var dir = Path.Combine(root, scope.CompanyId.ToString("N"));
            Directory.CreateDirectory(dir);
            var name = $"display-{Guid.NewGuid():N}.{ext}";
            await File.WriteAllBytesAsync(Path.Combine(dir, name), bytes);
            var row = await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var id = await c.ExecuteScalarAsync<Guid>("""
                    insert into display_image (company_id, branch_id, file, sort) values (@co, @b, @name, (select coalesce(max(sort), 0) + 1 from display_image)) returning id
                    """, new { co = scope.CompanyId, b = allBranches == false ? scope.BranchId : null, name }, tx);
                await Audit.RecordAsync(c, tx, scope.CompanyId, scope.BranchId, scope.UserId, "display_image", id.ToString(), "created", "Customer display picture added");
                return await c.QuerySingleAsync<ImageRow>("select d.*, b.code as branch_code from display_image d left join branch b on b.id = d.branch_id where d.id = @id", new { id }, tx);
            });
            await live.ToCompany(scope.CompanyId, "branding.changed");
            return Results.Ok(row);
        }).DisableAntiforgery();

        api.MapPut("/display/images/{id:guid}", async (Guid id, ImageChange body, HttpContext http, Db db, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("branch.manage");
            if (body.Seconds is < 3 or > 120) throw new DomainException("A picture shows for 3 to 120 seconds.");
            if (body.StartsOn is { } s && body.EndsOn is { } e && e < s) throw new DomainException("The last day is before the first.");
            await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var n = await c.ExecuteAsync("""
                    update display_image set caption = @caption, seconds = coalesce(@Seconds, seconds), sort = coalesce(@Sort, sort), is_active = coalesce(@IsActive, is_active),
                      starts_on = @StartsOn, ends_on = @EndsOn, branch_id = case when @all is null then branch_id when @all then null else @branch end
                    where id = @id
                    """, new { id, caption = string.IsNullOrWhiteSpace(body.Caption) ? null : body.Caption.Trim(), body.Seconds, body.Sort, body.IsActive, body.StartsOn, body.EndsOn,
                               all = body.AllBranches, branch = scope.BranchId }, tx);
                if (n == 0) throw new NotFoundException("Picture not found.");
                return 0;
            });
            await live.ToCompany(scope.CompanyId, "branding.changed");
            return Results.Ok(new { id });
        });

        api.MapDelete("/display/images/{id:guid}", async (Guid id, HttpContext http, Db db, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("branch.manage");
            var file = await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var f = await c.ExecuteScalarAsync<string?>("delete from display_image where id = @id returning file", new { id }, tx) ?? throw new NotFoundException("Picture not found.");
                await Audit.RecordAsync(c, tx, scope.CompanyId, scope.BranchId, scope.UserId, "display_image", id.ToString(), "deleted", "Customer display picture removed");
                return f;
            });
            ItemImages.TryDelete(Path.Combine(root, scope.CompanyId.ToString("N"), file));
            await live.ToCompany(scope.CompanyId, "branding.changed");
            return Results.Ok(new { id });
        });

        // The company is in the address (an <img> can't send the company header), like menu photos.
        api.MapGet("/display/images/{companyId:guid}/{id:guid}", async (Guid companyId, Guid id, HttpContext http, Db db) =>
        {
            await http.ScopeAsync(db, companyId);
            var file = await db.Company(companyId, (c, tx) => c.ExecuteScalarAsync<string?>("select file from display_image where id = @id", new { id }, tx));
            var path = file is null ? null : Path.Combine(root, companyId.ToString("N"), file);
            if (path is null || !File.Exists(path)) return Results.NotFound();
            http.Response.Headers.CacheControl = "private, max-age=31536000, immutable";
            return Results.File(path, TypeOf(path));
        });
    }
}
