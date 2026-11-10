using System.Security.Cryptography;
using System.Text.Json;
using Dapper;
using Npgsql;
using OnePos.Api.Data;
using OnePos.Api.Platform;

namespace OnePos.Api.Pos;

/// <summary>
/// TV screens (digital signage). A branch switches it on; managers build designs (a theme and slides: bestseller, offer with
/// countdown, menu grid, menu list, fresh-now, picture/video), each slide with its layout, animation, time on screen and schedule.
/// Any smart TV opens the TV page (/tv) in its own browser on any Wi-Fi with internet: it gets a long random key and a 6-digit
/// pairing code from the server and shows the code; a manager enters the code on TV screens, which links that TV to the branch.
/// The TV then asks every few seconds what to show; a manager names each TV, switches it on or off and chooses its design.
/// The TV uses only its key (its SHA-256 is kept), never a user's session.
/// </summary>
public static class Signage
{
    private const long MaxImage = 5 * 1024 * 1024;
    private const long MaxVideo = 25 * 1024 * 1024;
    private const int MaxContent = 400_000;
    public const string TokenHeader = "X-Signage-Token";

    public sealed record EnabledBody(bool On);
    public sealed record DesignBody(string? Name, JsonElement Content, bool? AllBranches);
    public sealed record ScreenBody(string? Name, bool? IsOn, Guid? DesignId, bool ClearDesign = false);
    public sealed record PairBody(string? Detected, int? Width, int? Height);
    public sealed record ClaimBody(string? Code, string? Name);

    public sealed class ScreenRow
    {
        public Guid Id { get; set; }
        public string? Detected { get; set; }
        public string Name { get; set; } = "";
        public bool IsOn { get; set; }
        public Guid? DesignId { get; set; }
        public string? DesignName { get; set; }
        public int? Width { get; set; }
        public int? Height { get; set; }
        public DateTime? LastSeen { get; set; }
        public bool Online { get; set; }
    }

    public sealed class DesignRow
    {
        public Guid Id { get; set; }
        public Guid? BranchId { get; set; }
        public string Name { get; set; } = "";
        public DateTime UpdatedAt { get; set; }
        public int Screens { get; set; }
    }

    public sealed class MediaRow
    {
        public Guid Id { get; set; }
        public string Kind { get; set; } = "";
        public string? Name { get; set; }
        public long Bytes { get; set; }
        public DateTime CreatedAt { get; set; }
    }

    private sealed record Tv(Guid Id, Guid CompanyId, Guid BranchId);
    private static readonly TimeSpan PairingLife = TimeSpan.FromMinutes(30);

    private static byte[] Hash(string token) => SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(token));
    private static string? Cut(string? s, int n) => string.IsNullOrWhiteSpace(s) ? null : s.Trim().Length > n ? s.Trim()[..n] : s.Trim();

    /// <summary>The TV's key (header, or ?t= for pictures an &lt;img&gt; loads) as stored; null when there is none.</summary>
    private static byte[]? TokenHash(HttpContext http)
    {
        var token = http.Request.Headers[TokenHeader].ToString();
        if (token.Length == 0) token = http.Request.Query["t"].ToString();
        return token.Length is < 32 or > 100 ? null : Hash(token);
    }

    /// <summary>The linked TV behind a key. Null: unknown, not linked yet, or removed.</summary>
    private static async Task<Tv?> TvAsync(HttpContext http, Db db)
    {
        var hash = TokenHash(http);
        if (hash is null) return null;
        return await db.Platform((c, tx) => c.QuerySingleOrDefaultAsync<Tv?>(
            "select id, company_id, branch_id from signage_screen where token_hash = @hash", new { hash }, tx));
    }

    private static string Root(IConfiguration config, IWebHostEnvironment env) =>
        config["Images:Root"] ?? Path.GetFullPath(Path.Combine(env.ContentRootPath, "..", "..", "data", "images"));

    private static void CheckContent(JsonElement content)
    {
        if (content.ValueKind != JsonValueKind.Object) throw new DomainException("The design is empty.");
        if (content.GetRawText().Length > MaxContent) throw new DomainException("This design is too large. Remove some slides.");
        if (!content.TryGetProperty("slides", out var slides) || slides.ValueKind != JsonValueKind.Array) throw new DomainException("The design has no slides.");
        if (slides.GetArrayLength() > 40) throw new DomainException("A design can have at most 40 slides.");
    }

    public static void Map(WebApplication app, RouteGroupBuilder api, IConfiguration config, IWebHostEnvironment env)
    {
        var root = Root(config, env);

        // ---- Managers (signed in) ------------------------------------------------------------------------------------------

        // Everything the TV screens page shows for the header branch.
        api.MapGet("/signage", async (HttpContext http, Db db) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("branch.manage");
            return await db.Company(scope.CompanyId, async (c, tx) => new
            {
                enabled = await c.ExecuteScalarAsync<bool>("select signage_enabled from branch where id = @b", new { b = scope.Branch }, tx),
                screens = await c.QueryAsync<ScreenRow>("""
                    select s.id, s.detected, s.name, s.is_on, s.design_id, g.name as design_name, s.width, s.height,
                           s.last_seen, coalesce(s.last_seen > now() - interval '45 seconds', false) as online
                    from signage_screen s left join signage_design g on g.id = s.design_id
                    where s.branch_id = @b order by s.created_at
                    """, new { b = scope.Branch }, tx),
                designs = await c.QueryAsync<DesignRow>("""
                    select g.id, g.branch_id, g.name, g.updated_at, (select count(*)::int from signage_screen s where s.design_id = g.id) as screens
                    from signage_design g where g.branch_id is null or g.branch_id = @b order by g.name
                    """, new { b = scope.Branch }, tx),
                media = await c.QueryAsync<MediaRow>("select id, kind, name, bytes, created_at from signage_media order by created_at desc", transaction: tx),
            });
        });

        api.MapPut("/signage/enabled", async (EnabledBody body, HttpContext http, Db db, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("branch.manage");
            await db.Company(scope.CompanyId, async (c, tx) =>
            {
                await c.ExecuteAsync("update branch set signage_enabled = @on where id = @b", new { on = body.On, b = scope.Branch }, tx);
                await Audit.RecordAsync(c, tx, scope.CompanyId, scope.Branch, scope.UserId, "branch", scope.Branch.ToString(), "signage", body.On ? "TV screens switched on" : "TV screens switched off");
                return 0;
            });
            await live.ToBranch(scope.Branch, "signage.changed");
            return Results.Ok(new { on = body.On });
        });

        api.MapGet("/signage/designs/{id:guid}", async (Guid id, HttpContext http, Db db) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("branch.manage");
            var row = await db.Company(scope.CompanyId, (c, tx) => c.QuerySingleOrDefaultAsync<(Guid Id, Guid? BranchId, string Name, string Content, DateTime UpdatedAt)>(
                "select id, branch_id, name, content::text as content, updated_at from signage_design where id = @id", new { id }, tx));
            if (row.Id == Guid.Empty) throw new NotFoundException("Design not found.");
            return Results.Ok(new { row.Id, row.BranchId, row.Name, content = JsonDocument.Parse(row.Content).RootElement, row.UpdatedAt });
        });

        api.MapPost("/signage/designs", async (DesignBody body, HttpContext http, Db db) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("branch.manage");
            var name = Cut(body.Name, 80) ?? throw new DomainException("Give the design a name.");
            CheckContent(body.Content);
            var id = await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var id = await c.ExecuteScalarAsync<Guid>("""
                    insert into signage_design (company_id, branch_id, name, content) values (@co, @b, @name, cast(@content as jsonb)) returning id
                    """, new { co = scope.CompanyId, b = body.AllBranches == true ? null : scope.BranchId, name, content = body.Content.GetRawText() }, tx);
                await Audit.RecordAsync(c, tx, scope.CompanyId, scope.BranchId, scope.UserId, "signage_design", id.ToString(), "created", $"TV design {name} created");
                return id;
            });
            return Results.Ok(new { id });
        });

        api.MapPut("/signage/designs/{id:guid}", async (Guid id, DesignBody body, HttpContext http, Db db, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("branch.manage");
            var name = Cut(body.Name, 80) ?? throw new DomainException("Give the design a name.");
            CheckContent(body.Content);
            await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var n = await c.ExecuteAsync("""
                    update signage_design set name = @name, content = cast(@content as jsonb), updated_at = now(),
                      branch_id = case when @all is null then branch_id when @all then null else @b end
                    where id = @id
                    """, new { id, name, content = body.Content.GetRawText(), all = body.AllBranches, b = scope.BranchId }, tx);
                if (n == 0) throw new NotFoundException("Design not found.");
                await Audit.RecordAsync(c, tx, scope.CompanyId, scope.BranchId, scope.UserId, "signage_design", id.ToString(), "changed", $"TV design {name} changed");
                return 0;
            });
            await live.ToCompany(scope.CompanyId, "signage.changed");
            return Results.Ok(new { id });
        });

        api.MapDelete("/signage/designs/{id:guid}", async (Guid id, HttpContext http, Db db, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("branch.manage");
            await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var name = await c.ExecuteScalarAsync<string?>("delete from signage_design where id = @id returning name", new { id }, tx) ?? throw new NotFoundException("Design not found.");
                await Audit.RecordAsync(c, tx, scope.CompanyId, scope.BranchId, scope.UserId, "signage_design", id.ToString(), "deleted", $"TV design {name} deleted");
                return 0;
            });
            await live.ToCompany(scope.CompanyId, "signage.changed");
            return Results.Ok(new { id });
        });

        api.MapPut("/signage/screens/{id:guid}", async (Guid id, ScreenBody body, HttpContext http, Db db, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("branch.manage");
            await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var old = await c.QuerySingleOrDefaultAsync<(Guid Id, string Name, bool IsOn)>("select id, name, is_on from signage_screen where id = @id and branch_id = @b for update", new { id, b = scope.Branch }, tx);
                if (old.Id == Guid.Empty) throw new NotFoundException("TV not found.");
                if (body.DesignId is { } d && !await c.ExecuteScalarAsync<bool>("select exists (select 1 from signage_design where id = @d and (branch_id is null or branch_id = @b))", new { d, b = scope.Branch }, tx))
                    throw new NotFoundException("Design not found.");
                await c.ExecuteAsync("""
                    update signage_screen set name = coalesce(@name, name), is_on = coalesce(@IsOn, is_on),
                      design_id = case when @ClearDesign then null else coalesce(@DesignId, design_id) end
                    where id = @id
                    """, new { id, name = Cut(body.Name, 60), body.IsOn, body.DesignId, body.ClearDesign }, tx);
                var what = body.IsOn is { } on && on != old.IsOn ? (on ? "switched on" : "switched off") : "changed";
                await Audit.RecordAsync(c, tx, scope.CompanyId, scope.Branch, scope.UserId, "signage_screen", id.ToString(), "changed", $"TV {old.Name} {what}");
                return 0;
            });
            await live.ToBranch(scope.Branch, "signage.changed", new { id });
            return Results.Ok(new { id });
        });

        api.MapDelete("/signage/screens/{id:guid}", async (Guid id, HttpContext http, Db db) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("branch.manage");
            await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var name = await c.ExecuteScalarAsync<string?>("delete from signage_screen where id = @id and branch_id = @b returning name", new { id, b = scope.Branch }, tx)
                    ?? throw new NotFoundException("TV not found.");
                await Audit.RecordAsync(c, tx, scope.CompanyId, scope.Branch, scope.UserId, "signage_screen", id.ToString(), "deleted", $"TV {name} removed");
                return 0;
            });
            return Results.Ok(new { id });
        });

        // Pictures (JPEG, PNG, WebP up to 5 MB) and videos (MP4 or WebM up to 25 MB) for designs.
        api.MapPost("/signage/media", async (IFormFile file, HttpContext http, Db db) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("branch.manage");
            if (file.Length == 0) throw new DomainException("The file is empty.");
            if (file.Length > MaxVideo) throw new DomainException("A video can be at most 25 MB, a picture 5 MB.");
            await using var ms = new MemoryStream();
            await file.CopyToAsync(ms);
            var bytes = ms.ToArray();
            var ext = ItemImages.Kind(bytes) ?? VideoKind(bytes) ?? throw new DomainException("Use a JPEG, PNG or WebP picture, or an MP4 or WebM video.");
            var kind = ext is "mp4" or "webm" ? "video" : "image";
            if (kind == "image" && bytes.Length > MaxImage) throw new DomainException("A picture can be at most 5 MB.");
            var dir = Path.Combine(root, scope.CompanyId.ToString("N"));
            Directory.CreateDirectory(dir);
            var name = $"signage-{Guid.NewGuid():N}.{ext}";
            await File.WriteAllBytesAsync(Path.Combine(dir, name), bytes);
            return await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var row = await c.QuerySingleAsync<MediaRow>("""
                    insert into signage_media (company_id, file, kind, name, bytes) values (@co, @name, @kind, @label, @len) returning id, kind, name, bytes, created_at
                    """, new { co = scope.CompanyId, name, kind, label = Cut(Path.GetFileNameWithoutExtension(file.FileName), 80), len = (long)bytes.Length }, tx);
                await Audit.RecordAsync(c, tx, scope.CompanyId, scope.BranchId, scope.UserId, "signage_media", row.Id.ToString(), "created", kind == "video" ? "TV video added" : "TV picture added");
                return row;
            });
        }).DisableAntiforgery();

        api.MapDelete("/signage/media/{id:guid}", async (Guid id, HttpContext http, Db db) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("branch.manage");
            var file = await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var f = await c.ExecuteScalarAsync<string?>("delete from signage_media where id = @id returning file", new { id }, tx) ?? throw new NotFoundException("Picture not found.");
                await Audit.RecordAsync(c, tx, scope.CompanyId, scope.BranchId, scope.UserId, "signage_media", id.ToString(), "deleted", "TV picture or video removed");
                return f;
            });
            ItemImages.TryDelete(Path.Combine(root, scope.CompanyId.ToString("N"), file));
            return Results.Ok(new { id });
        });

        // For the designer's preview (signed in): the same data a TV gets.
        api.MapGet("/signage/preview-data", async (HttpContext http, Db db) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("branch.manage");
            return await db.Company(scope.CompanyId, (c, tx) => PlayDataAsync(c, tx, scope.CompanyId, scope.Branch));
        });

        // Link a TV: the manager types the code the TV shows. The TV becomes this branch's, switched on, playing the branch's first design.
        api.MapPost("/signage/screens", async (ClaimBody body, HttpContext http, Db db, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("branch.manage");
            var code = new string((body.Code ?? "").Where(char.IsDigit).ToArray());
            if (code.Length != 6) throw new DomainException("Type the 6-digit code shown on the TV.");
            var id = await db.Company(scope.CompanyId, async (c, tx) =>
            {
                if (!await c.ExecuteScalarAsync<bool>("select signage_enabled from branch where id = @b", new { b = scope.Branch }, tx))
                    throw new DomainException("Switch TV screens on for this branch first.");
                var p = await c.QuerySingleOrDefaultAsync<(Guid Id, byte[] TokenHash, string? Detected, int? Width, int? Height)>("""
                    delete from signage_pairing where id = (select id from signage_pairing where code = @code and expires_at > now() order by created_at desc limit 1)
                    returning id, token_hash, detected, width, height
                    """, new { code }, tx);
                if (p.Id == Guid.Empty) throw new DomainException("No TV is showing this code. Check the number, or open the TV page again for a new code.");
                var count = await c.ExecuteScalarAsync<int>("select count(*)::int from signage_screen where branch_id = @b", new { b = scope.Branch }, tx);
                var design = await c.ExecuteScalarAsync<Guid?>(
                    "select id from signage_design where branch_id is null or branch_id = @b order by branch_id is null, created_at limit 1", new { b = scope.Branch }, tx);
                var id = await c.ExecuteScalarAsync<Guid>("""
                    insert into signage_screen (company_id, branch_id, token_hash, name, detected, design_id, width, height, last_seen)
                    values (@co, @b, @hash, @name, @detected, @design, @w, @h, now()) returning id
                    """, new { co = scope.CompanyId, b = scope.Branch, hash = p.TokenHash, name = Cut(body.Name, 60) ?? $"TV {count + 1}", detected = p.Detected, design, w = p.Width, h = p.Height }, tx);
                await Audit.RecordAsync(c, tx, scope.CompanyId, scope.Branch, scope.UserId, "signage_screen", id.ToString(), "created", "TV linked");
                return id;
            });
            await live.ToBranch(scope.Branch, "signage.changed", new { id });
            return Results.Ok(new { id });
        });

        // ---- The TV (its key) -----------------------------------------------------------------------------------------------

        // A TV not linked yet asks for a key and a code to show. Expired codes are cleared as new ones are made.
        app.MapPost("/api/public/signage/pair", async (PairBody body, Db db) =>
        {
            var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
            var hash = Hash(token);
            var (code, expires) = await db.Platform(async (c, tx) =>
            {
                await c.ExecuteAsync("delete from signage_pairing where expires_at < now()", transaction: tx);
                if (await c.ExecuteScalarAsync<int>("select count(*)::int from signage_pairing", transaction: tx) >= 1000)
                    throw new DomainException("Too many TVs are waiting to be linked. Try again in a few minutes.");
                var code = "";
                for (var tries = 0; tries < 20; tries++)
                {
                    code = RandomNumberGenerator.GetInt32(100000, 1000000).ToString();
                    if (!await c.ExecuteScalarAsync<bool>("select exists (select 1 from signage_pairing where code = @code)", new { code }, tx)) break;
                }
                var expires = DateTime.UtcNow + PairingLife;
                await c.ExecuteAsync("""
                    insert into signage_pairing (code, token_hash, detected, width, height, expires_at) values (@code, @hash, @detected, @w, @h, @expires)
                    """, new { code, hash, detected = Cut(body.Detected, 120), w = Size(body.Width), h = Size(body.Height), expires }, tx);
                return (code, expires);
            });
            return Results.Ok(new { token, code, expiresAt = expires });
        });

        // The TV page every few seconds: what this TV shows now (its design and the branch's menu, prices, sold-out and sold-today
        // counts); while it is not linked yet, its code. 401: the key is unknown (the TV was removed or its code expired): get a new one.
        app.MapGet("/api/public/signage/play", async (HttpContext http, Db db, int? w, int? h) =>
        {
            http.Response.Headers.CacheControl = "no-store";
            var hash = TokenHash(http);
            if (hash is null) return Results.Json(new { error = "This TV isn't linked." }, statusCode: 401);
            var tv = await TvAsync(http, db);
            if (tv is null)
            {
                var p = await db.Platform((c, tx) => c.QuerySingleOrDefaultAsync<(string? Code, DateTime ExpiresAt)>(
                    "select code, expires_at from signage_pairing where token_hash = @hash and expires_at > now()", new { hash }, tx));
                return p.Code is null ? Results.Json(new { error = "This TV isn't linked." }, statusCode: 401)
                    : Results.Ok(new { linked = false, code = p.Code, expiresAt = p.ExpiresAt });
            }
            return Results.Ok(await db.Company(tv.CompanyId, async (c, tx) =>
            {
                var s = await c.QuerySingleAsync<(Guid Id, string Name, bool IsOn, Guid? DesignId, bool Enabled)>("""
                    update signage_screen s set last_seen = now(), width = coalesce(@w, s.width), height = coalesce(@h, s.height) from branch b
                    where s.id = @id and b.id = s.branch_id returning s.id, s.name, s.is_on, s.design_id, b.signage_enabled as enabled
                    """, new { id = tv.Id, w = Size(w), h = Size(h) }, tx);
                object? design = null;
                if (s.DesignId is { } d)
                {
                    var g = await c.QuerySingleOrDefaultAsync<(Guid Id, string Name, string Content, DateTime UpdatedAt)>(
                        "select id, name, content::text as content, updated_at from signage_design where id = @d", new { d }, tx);
                    if (g.Id != Guid.Empty) design = new { g.Id, g.Name, content = JsonDocument.Parse(g.Content).RootElement, g.UpdatedAt };
                }
                return new { linked = true, screen = new { s.Id, s.Name, isOn = s.IsOn && s.Enabled && design is not null }, design, data = await PlayDataAsync(c, tx, tv.CompanyId, tv.BranchId) };
            }));
        });

        // Pictures and videos for the TV (an <img> or <video> can't send headers: the token is in the address).
        app.MapGet("/api/public/signage/media/{id:guid}", async (Guid id, HttpContext http, Db db) =>
        {
            var companyId = await MediaCompanyAsync(http, db);
            if (companyId is null) return Results.NotFound();
            var file = await db.Company(companyId.Value, (c, tx) => c.ExecuteScalarAsync<string?>("select file from signage_media where id = @id", new { id }, tx));
            return Serve(http, file is null ? null : Path.Combine(root, companyId.Value.ToString("N"), file));
        });
        app.MapGet("/api/public/signage/items/{id:guid}", async (Guid id, HttpContext http, Db db) =>
        {
            var companyId = await MediaCompanyAsync(http, db);
            if (companyId is null) return Results.NotFound();
            var file = await db.Company(companyId.Value, (c, tx) => c.ExecuteScalarAsync<string?>("select image_file from menu_item where id = @id", new { id }, tx));
            return Serve(http, file is null ? null : Path.Combine(root, companyId.Value.ToString("N"), file));
        });
        app.MapGet("/api/public/signage/logo/{branchId:guid}", async (Guid branchId, HttpContext http, Db db) =>
        {
            var companyId = await MediaCompanyAsync(http, db);
            if (companyId is null) return Results.NotFound();
            var file = await db.Company(companyId.Value, (c, tx) => c.ExecuteScalarAsync<string?>("select logo_file from branch where id = @branchId", new { branchId }, tx));
            return Serve(http, file is null ? null : Path.Combine(root, companyId.Value.ToString("N"), file));
        });
    }

    private static int? Size(int? n) => n is > 0 and < 20000 ? n : null;

    /// <summary>Media for a TV (its key) or for a signed-in manager's preview (their session, company in ?co=).</summary>
    private static async Task<Guid?> MediaCompanyAsync(HttpContext http, Db db)
    {
        if (await TvAsync(http, db) is { } tv) return tv.CompanyId;
        if (http.User.Identity?.IsAuthenticated == true && Guid.TryParse(http.Request.Query["co"], out var co))
        {
            try { await http.ScopeAsync(db, co); return co; } catch (DomainException) { return null; }
        }
        return null;
    }

    private static IResult Serve(HttpContext http, string? path)
    {
        if (path is null || !File.Exists(path)) return Results.NotFound();
        http.Response.Headers.CacheControl = "private, max-age=31536000, immutable";
        var type = Path.GetExtension(path).ToLowerInvariant() switch
        {
            ".png" => "image/png", ".webp" => "image/webp", ".svg" => "image/svg+xml", ".mp4" => "video/mp4", ".webm" => "video/webm", _ => "image/jpeg",
        };
        return Results.File(path, type, enableRangeProcessing: true);
    }

    private static string? VideoKind(byte[] b)
    {
        if (b.Length > 12 && b[4] == 'f' && b[5] == 't' && b[6] == 'y' && b[7] == 'p') return "mp4";
        if (b.Length > 4 && b[0] == 0x1A && b[1] == 0x45 && b[2] == 0xDF && b[3] == 0xA3) return "webm";
        return null;
    }

    public sealed class PlayItem
    {
        public Guid Id { get; set; }
        public Guid CategoryId { get; set; }
        public string Name { get; set; } = "";
        public string? NameAr { get; set; }
        public string? Description { get; set; }
        public decimal Price { get; set; }
        public bool SoldOut { get; set; }
        public DateTime? ImageAt { get; set; }
        public decimal SoldToday { get; set; }
    }

    /// <summary>The branch's menu as a TV shows it: what it sells now, at its price, sold out or not, and how many sold today.</summary>
    private static async Task<object> PlayDataAsync(NpgsqlConnection c, NpgsqlTransaction tx, Guid companyId, Guid branchId)
    {
        var today = await Days.DateAsync(c, tx, branchId);
        var branch = await c.QuerySingleAsync<(string Name, string? NameAr, string TimeZone, string? LogoFile, DateTime? LogoAt, string Currency)>("""
            select b.name, b.name_ar, b.time_zone, b.logo_file, b.logo_at, co.base_currency as currency from branch b join company co on co.id = b.company_id where b.id = @branchId
            """, new { branchId }, tx);
        var categories = await c.QueryAsync<(Guid Id, string Name, string? NameAr)>(
            "select id, name, name_ar from menu_category where is_active order by sort, name", transaction: tx);
        var items = await c.QueryAsync<PlayItem>("""
            with sold as (
              select l.item_id, sum(l.qty) as qty from pos_order o join order_line l on l.order_id = o.id
              where o.branch_id = @branchId and o.business_date = @today and o.status in ('paid','refunded') and not l.is_void
              group by l.item_id)
            select i.id, i.category_id, i.name, i.name_ar, i.description, coalesce(bi.price, i.price) as price,
                   coalesce(bi.sold_out_date = @today, false) as sold_out, case when i.image_file is null then null else i.image_at end as image_at,
                   coalesce(s.qty, 0) as sold_today
            from menu_item i join menu_category cat on cat.id = i.category_id and cat.is_active
            left join branch_item bi on bi.item_id = i.id and bi.branch_id = @branchId
            left join sold s on s.item_id = i.id
            where i.is_active and coalesce(bi.is_sold, i.erp_item_code is null) and (i.branch_id is null or i.branch_id = @branchId)
            order by cat.sort, i.sort, i.name
            """, new { branchId, today }, tx);
        return new
        {
            companyId, branchId, branch = branch.Name, branchAr = branch.NameAr, timeZone = branch.TimeZone, currency = branch.Currency,
            logoAt = branch.LogoFile is null ? null : branch.LogoAt,
            categories = categories.Select(x => new { x.Id, x.Name, x.NameAr }),
            items, serverTime = DateTime.UtcNow,
            videos = await c.QueryAsync<Guid>("select id from signage_media where kind = 'video'", transaction: tx),
        };
    }
}
