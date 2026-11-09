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
/// The tray app on each till PC finds the TVs connected to it, reports them here and shows each one's design full screen;
/// a manager names each TV, switches it on or off and chooses its design. The tray app and the TV page use a per-PC token
/// (the PC's browser fetches it while signed in and hands it to the PC's Device Service), never a user's session.
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
    public sealed record TokenBody(string? DeviceKey, string? Machine);
    public sealed record Monitor(string? Key, string? Name, int? Width, int? Height);
    public sealed record NearbyTv(string? Name, bool Connected);
    public sealed record ConnectDone(string? Name, bool Ok, string? Message);
    public sealed record ReportBody(IReadOnlyList<Monitor>? Monitors, string? Machine, IReadOnlyList<NearbyTv>? Nearby = null, ConnectDone? ConnectDone = null);
    public sealed record ConnectBody(string? Name);

    public sealed class DeviceRow
    {
        public Guid Id { get; set; }
        public string? Machine { get; set; }
        public bool Online { get; set; }
        public string? Nearby { get; set; }
        public DateTime? NearbyAt { get; set; }
        public string? ConnectName { get; set; }
        public DateTime? ConnectAt { get; set; }
        public bool? ConnectOk { get; set; }
        public string? ConnectMessage { get; set; }
        public DateTime? ConnectDoneAt { get; set; }
    }

    public sealed class ScreenRow
    {
        public Guid Id { get; set; }
        public Guid DeviceId { get; set; }
        public string? Machine { get; set; }
        public string MonitorKey { get; set; } = "";
        public string? DetectedName { get; set; }
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

    private sealed record Device(Guid Id, Guid CompanyId, Guid BranchId);

    private static byte[] Hash(string token) => SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(token));
    private static string? Cut(string? s, int n) => string.IsNullOrWhiteSpace(s) ? null : s.Trim().Length > n ? s.Trim()[..n] : s.Trim();

    /// <summary>The PC behind a token (header, or ?t= for pictures an &lt;img&gt; loads). Null: unknown or revoked.</summary>
    private static async Task<Device?> DeviceAsync(HttpContext http, Db db)
    {
        var token = http.Request.Headers[TokenHeader].ToString();
        if (token.Length == 0) token = http.Request.Query["t"].ToString();
        if (token.Length is < 32 or > 100) return null;
        var hash = Hash(token);
        return await db.Platform((c, tx) => c.QuerySingleOrDefaultAsync<Device?>(
            "select id, company_id, branch_id from signage_device where token_hash = @hash", new { hash }, tx));
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
                    select s.id, s.device_id, d.machine, s.monitor_key, s.detected_name, s.name, s.is_on, s.design_id, g.name as design_name, s.width, s.height,
                           s.last_seen, coalesce(s.last_seen > now() - interval '30 seconds', false) as online
                    from signage_screen s join signage_device d on d.id = s.device_id left join signage_design g on g.id = s.design_id
                    where s.branch_id = @b order by d.machine nulls last, s.created_at
                    """, new { b = scope.Branch }, tx),
                designs = await c.QueryAsync<DesignRow>("""
                    select g.id, g.branch_id, g.name, g.updated_at, (select count(*)::int from signage_screen s where s.design_id = g.id) as screens
                    from signage_design g where g.branch_id is null or g.branch_id = @b order by g.name
                    """, new { b = scope.Branch }, tx),
                media = await c.QueryAsync<MediaRow>("select id, kind, name, bytes, created_at from signage_media order by created_at desc", transaction: tx),
                // The branch's till PCs with the wireless TVs each can see (signage_device has no row-level security: by branch and company).
                devices = (await c.QueryAsync<DeviceRow>("""
                    select id, machine, coalesce(last_seen > now() - interval '30 seconds', false) as online, nearby::text as nearby, nearby_at,
                           connect_name, connect_at, connect_ok, connect_message, connect_done_at
                    from signage_device where branch_id = @b and company_id = @co and last_seen > now() - interval '30 days'
                    order by machine nulls last
                    """, new { b = scope.Branch, co = scope.CompanyId }, tx)).Select(d => new
                    {
                        d.Id, d.Machine, d.Online, nearby = d.Nearby is null ? null : (object)JsonDocument.Parse(d.Nearby).RootElement, d.NearbyAt,
                        d.ConnectName, d.ConnectAt, d.ConnectOk, d.ConnectMessage, d.ConnectDoneAt,
                    }),
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

        // Ask a till PC to connect one of the wireless TVs it can see (it does so within a few seconds and reports back).
        api.MapPost("/signage/devices/{id:guid}/connect", async (Guid id, ConnectBody body, HttpContext http, Db db, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("branch.manage");
            var name = Cut(body.Name, 120) ?? throw new DomainException("Choose a TV.");
            await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var machine = await c.QuerySingleOrDefaultAsync<string?>("""
                    update signage_device set connect_name = @name, connect_at = now(), connect_ok = null, connect_message = null, connect_done_at = null
                    where id = @id and branch_id = @b and company_id = @co returning coalesce(machine, 'the till')
                    """, new { id, name, b = scope.Branch, co = scope.CompanyId }, tx) ?? throw new NotFoundException("Till not found.");
                await Audit.RecordAsync(c, tx, scope.CompanyId, scope.Branch, scope.UserId, "signage_device", id.ToString(), "connect", $"{machine} asked to connect TV {name}");
                return 0;
            });
            await live.ToBranch(scope.Branch, "signage.changed");
            return Results.Ok(new { id, name });
        });

        api.MapDelete("/signage/devices/{id:guid}/connect", async (Guid id, HttpContext http, Db db) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("branch.manage");
            await db.Company(scope.CompanyId, (c, tx) => c.ExecuteAsync(
                "update signage_device set connect_name = null where id = @id and branch_id = @b and company_id = @co", new { id, b = scope.Branch, co = scope.CompanyId }, tx));
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

        // The till's browser (signed in at the branch) gets this PC's token and gives it to the PC's Device Service.
        // Each call makes a new token, so an old copy stops working.
        api.MapPost("/signage/device-token", async (TokenBody body, HttpContext http, Db db) =>
        {
            var scope = await http.ScopeAsync(db);
            if (!scope.Can("pos.sell")) scope.Require("branch.manage");
            var key = Cut(body.DeviceKey, 64) ?? throw new DomainException("No device key.");
            var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
            var hash = Hash(token);
            var enabled = await db.Company(scope.CompanyId, async (c, tx) =>
            {
                if (!await c.ExecuteScalarAsync<bool>("select signage_enabled from branch where id = @b", new { b = scope.Branch }, tx)) return false;
                await c.ExecuteAsync("""
                    insert into signage_device (company_id, branch_id, device_key, machine, token_hash) values (@co, @b, @key, @machine, @hash)
                    on conflict (branch_id, device_key) do update set token_hash = excluded.token_hash, machine = coalesce(excluded.machine, signage_device.machine)
                    """, new { co = scope.CompanyId, b = scope.Branch, key, machine = Cut(body.Machine, 80), hash }, tx);
                return true;
            });
            return enabled ? Results.Ok(new { enabled, token, branchId = scope.Branch }) : Results.Ok(new { enabled, token = (string?)null, branchId = scope.Branch });
        });

        // ---- The till PC (token) -------------------------------------------------------------------------------------------

        // The tray app says which screens this PC has besides its own (every few seconds); new ones become TVs, switched on,
        // playing the branch's first design. Answers what each TV should do.
        app.MapPost("/api/public/signage/screens", async (ReportBody body, HttpContext http, Db db) =>
        {
            var dev = await DeviceAsync(http, db);
            if (dev is null) return Results.Json(new { error = "This PC isn't set up for TV screens. Open One POS on it once." }, statusCode: 401);
            var monitors = (body.Monitors ?? []).Where(m => !string.IsNullOrWhiteSpace(m.Key)).Take(8).ToList();
            return Results.Ok(await db.Company(dev.CompanyId, async (c, tx) =>
            {
                var enabled = await c.ExecuteScalarAsync<bool>("select signage_enabled from branch where id = @b", new { b = dev.BranchId }, tx);
                await c.ExecuteAsync("update signage_device set last_seen = now(), machine = coalesce(@machine, machine) where id = @id", new { id = dev.Id, machine = Cut(body.Machine, 80) }, tx);
                // The wireless TVs it can see now (left out: it couldn't look), and how a requested connect went.
                if (body.Nearby is { } near)
                {
                    var list = near.Where(n => !string.IsNullOrWhiteSpace(n.Name)).Take(20).Select(n => new { name = Cut(n.Name, 120), connected = n.Connected });
                    await c.ExecuteAsync("update signage_device set nearby = cast(@json as jsonb), nearby_at = now() where id = @id",
                        new { id = dev.Id, json = JsonSerializer.Serialize(list) }, tx);
                }
                if (body.ConnectDone is { Name: { } doneName } done)
                    await c.ExecuteAsync("""
                        update signage_device set connect_name = null, connect_ok = @ok, connect_message = @msg, connect_done_at = now()
                        where id = @id and connect_name = @name
                        """, new { id = dev.Id, name = Cut(doneName, 120), ok = done.Ok, msg = Cut(done.Message, 300) }, tx);
                var connect = await c.ExecuteScalarAsync<string?>("select connect_name from signage_device where id = @id", new { id = dev.Id }, tx);
                if (!enabled) return new { enabled, screens = Array.Empty<object>(), connect = (string?)null };
                var firstDesign = await c.ExecuteScalarAsync<Guid?>(
                    "select id from signage_design where branch_id is null or branch_id = @b order by branch_id is null, created_at limit 1", new { b = dev.BranchId }, tx);
                var screens = new List<object>();
                foreach (var m in monitors)
                {
                    var key = Cut(m.Key, 200)!;
                    var count = await c.ExecuteScalarAsync<int>("select count(*)::int from signage_screen where branch_id = @b", new { b = dev.BranchId }, tx);
                    var s = await c.QuerySingleAsync<(Guid Id, string Name, bool IsOn, Guid? DesignId)>("""
                        insert into signage_screen (company_id, branch_id, device_id, monitor_key, detected_name, name, design_id, width, height, last_seen)
                        values (@co, @b, @dev, @key, @detected, @name, @design, @w, @h, now())
                        on conflict (device_id, monitor_key) do update set last_seen = now(), detected_name = coalesce(excluded.detected_name, signage_screen.detected_name),
                          width = coalesce(excluded.width, signage_screen.width), height = coalesce(excluded.height, signage_screen.height)
                        returning id, name, is_on, design_id
                        """, new
                        {
                            co = dev.CompanyId, b = dev.BranchId, dev = dev.Id, key, detected = Cut(m.Name, 120), name = $"TV {count + 1}",
                            design = firstDesign, w = m.Width, h = m.Height,
                        }, tx);
                    screens.Add(new { monitorKey = key, id = s.Id, name = s.Name, isOn = s.IsOn && s.DesignId is not null });
                }
                return new { enabled, screens = screens.ToArray(), connect };
            }));
        });

        // The TV page: what this TV shows now (its design and the branch's menu, prices, sold-out and sold-today counts).
        app.MapGet("/api/public/signage/play/{screenId:guid}", async (Guid screenId, HttpContext http, Db db) =>
        {
            var dev = await DeviceAsync(http, db);
            if (dev is null) return Results.Json(new { error = "This PC isn't set up for TV screens." }, statusCode: 401);
            http.Response.Headers.CacheControl = "no-store";
            return Results.Ok(await db.Company(dev.CompanyId, async (c, tx) =>
            {
                var s = await c.QuerySingleOrDefaultAsync<(Guid Id, string Name, bool IsOn, Guid? DesignId, bool Enabled)>("""
                    select s.id, s.name, s.is_on, s.design_id, b.signage_enabled as enabled from signage_screen s join branch b on b.id = s.branch_id
                    where s.id = @screenId and s.device_id = @dev
                    """, new { screenId, dev = dev.Id }, tx);
                if (s.Id == Guid.Empty) throw new NotFoundException("This TV was removed. It will be found again in a moment.");
                object? design = null;
                if (s.DesignId is { } d)
                {
                    var g = await c.QuerySingleOrDefaultAsync<(Guid Id, string Name, string Content, DateTime UpdatedAt)>(
                        "select id, name, content::text as content, updated_at from signage_design where id = @d", new { d }, tx);
                    if (g.Id != Guid.Empty) design = new { g.Id, g.Name, content = JsonDocument.Parse(g.Content).RootElement, g.UpdatedAt };
                }
                return new { screen = new { s.Id, s.Name, isOn = s.IsOn && s.Enabled && design is not null }, design, data = await PlayDataAsync(c, tx, dev.CompanyId, dev.BranchId) };
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

    /// <summary>Media for a TV (its token) or for a signed-in manager's preview (their session, company in ?co=).</summary>
    private static async Task<Guid?> MediaCompanyAsync(HttpContext http, Db db)
    {
        if (await DeviceAsync(http, db) is { } dev) return dev.CompanyId;
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
