using System.Text.Json;

namespace OnePos.Api.Platform;

/// <summary>
/// Device Service releases (REQ HW-01): the installer files and latest.json ({ version, file, sha256 }) in the releases folder
/// (tools/release-device-service.ps1 puts them there). Each till's Device Service asks for the latest and downloads it from here.
/// No sign-in: the service has none; the files are the public installer.
/// </summary>
public static class DeviceReleases
{
    public static void Map(WebApplication app, IConfiguration config, IWebHostEnvironment env)
    {
        var root = config["Releases:Root"] ?? Path.GetFullPath(Path.Combine(env.ContentRootPath, "..", "..", "data", "releases", "device-service"));

        app.MapGet("/api/public/device-service/latest", () =>
        {
            var path = Path.Combine(root, "latest.json");
            if (!File.Exists(path)) return Results.NotFound(new { error = "No Device Service release yet." });
            using var doc = JsonDocument.Parse(File.ReadAllText(path));
            var r = doc.RootElement;
            return Results.Ok(new { version = r.GetProperty("version").GetString(), file = r.GetProperty("file").GetString(), sha256 = r.GetProperty("sha256").GetString() });
        }).AllowAnonymous();

        // Installers by name only (no folders): OnePos.DeviceService-1.2.0.msi
        app.MapGet("/api/public/device-service/files/{file}", (string file) =>
        {
            if (file.Length > 80 || file.Contains('/') || file.Contains('\\') || file.Contains("..") || !file.EndsWith(".msi", StringComparison.OrdinalIgnoreCase))
                return Results.NotFound();
            var path = Path.Combine(root, file);
            return File.Exists(path) ? Results.File(path, "application/x-msi", file) : Results.NotFound();
        }).AllowAnonymous();
    }
}
