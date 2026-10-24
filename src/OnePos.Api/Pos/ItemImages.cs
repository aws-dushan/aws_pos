using Dapper;
using OnePos.Api.Data;
using OnePos.Api.Platform;

namespace OnePos.Api.Pos;

/// <summary>
/// Menu item photos. Upload (menu.manage): JPEG, PNG or WebP up to 2 MB, checked by content, not by name; the web shrinks photos
/// to ~600 px before sending. Served at /api/menu/images/{company}/{item}?v=… so an &lt;img&gt; can load it (it can't send headers);
/// the version in the address changes with each upload, so the photo is cached hard and still never stale.
/// </summary>
public static class ItemImages
{
    private const long MaxBytes = 2 * 1024 * 1024;

    public static void Map(RouteGroupBuilder api, IConfiguration config, IWebHostEnvironment env)
    {
        var root = config["Images:Root"] ?? Path.GetFullPath(Path.Combine(env.ContentRootPath, "..", "..", "data", "images"));

        api.MapPost("/menu/items/{id:guid}/image", async (Guid id, IFormFile file, HttpContext http, Db db, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("menu.manage");
            if (file.Length == 0) throw new DomainException("The file is empty.");
            if (file.Length > MaxBytes) throw new DomainException("A photo can be at most 2 MB.");
            await using var ms = new MemoryStream();
            await file.CopyToAsync(ms);
            var bytes = ms.ToArray();
            var ext = Kind(bytes) ?? throw new DomainException("Use a JPEG, PNG or WebP photo.");
            var dir = Path.Combine(root, scope.CompanyId.ToString("N"));
            Directory.CreateDirectory(dir);
            var name = $"{id:N}-{DateTime.UtcNow:yyyyMMddHHmmssfff}.{ext}";
            var old = await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var prev = await c.QuerySingleOrDefaultAsync<(Guid Id, string Name, string? ImageFile)>("select id, name, image_file from menu_item where id = @id for update", new { id }, tx);
                if (prev.Id == Guid.Empty) throw new NotFoundException("Item not found.");
                await File.WriteAllBytesAsync(Path.Combine(dir, name), bytes);
                await c.ExecuteAsync("update menu_item set image_file = @name, image_at = now() where id = @id", new { id, name }, tx);
                await Audit.RecordAsync(c, tx, scope.CompanyId, null, scope.UserId, "menu_item", id.ToString(), "image", $"Photo of {prev.Name} {(prev.ImageFile is null ? "added" : "replaced")}");
                return prev.ImageFile;
            });
            if (old is not null) TryDelete(Path.Combine(dir, old));
            await live.ToCompany(scope.CompanyId, "menu.changed");
            return Results.Ok(new { id });
        }).DisableAntiforgery();

        api.MapDelete("/menu/items/{id:guid}/image", async (Guid id, HttpContext http, Db db, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("menu.manage");
            var old = await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var prev = await c.QuerySingleOrDefaultAsync<(Guid Id, string Name, string? ImageFile)>("select id, name, image_file from menu_item where id = @id for update", new { id }, tx);
                if (prev.Id == Guid.Empty) throw new NotFoundException("Item not found.");
                await c.ExecuteAsync("update menu_item set image_file = null, image_at = now() where id = @id", new { id }, tx);
                await Audit.RecordAsync(c, tx, scope.CompanyId, null, scope.UserId, "menu_item", id.ToString(), "image", $"Photo of {prev.Name} removed");
                return prev.ImageFile;
            });
            if (old is not null) TryDelete(Path.Combine(root, scope.CompanyId.ToString("N"), old));
            await live.ToCompany(scope.CompanyId, "menu.changed");
            return Results.Ok(new { id });
        });

        api.MapGet("/menu/images/{companyId:guid}/{id:guid}", async (Guid companyId, Guid id, HttpContext http, Db db) =>
        {
            await http.ScopeAsync(db, companyId);
            var file = await db.Company(companyId, (c, tx) => c.ExecuteScalarAsync<string?>("select image_file from menu_item where id = @id", new { id }, tx));
            var path = file is null ? null : Path.Combine(root, companyId.ToString("N"), file);
            if (path is null || !File.Exists(path)) return Results.NotFound();
            // The address carries the version (?v=), so the photo never changes under it: cache it for a year.
            http.Response.Headers.CacheControl = "private, max-age=31536000, immutable";
            var type = Path.GetExtension(path) switch { ".png" => "image/png", ".webp" => "image/webp", _ => "image/jpeg" };
            return Results.File(path, type);
        });
    }

    /// <summary>The image type from the first bytes (never trust the file name).</summary>
    internal static string? Kind(byte[] b)
    {
        if (b.Length > 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF) return "jpg";
        if (b.Length > 8 && b[0] == 0x89 && b[1] == 0x50 && b[2] == 0x4E && b[3] == 0x47) return "png";
        if (b.Length > 12 && b[0] == 'R' && b[1] == 'I' && b[2] == 'F' && b[3] == 'F' && b[8] == 'W' && b[9] == 'E' && b[10] == 'B' && b[11] == 'P') return "webp";
        return null;
    }

    internal static void TryDelete(string path)
    {
        try { File.Delete(path); } catch (IOException) { /* in use: left behind, harmless */ }
    }
}
