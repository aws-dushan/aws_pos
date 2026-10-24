using System.Diagnostics;
using System.Net.Http.Json;
using System.Security.Cryptography;

namespace OnePos.DeviceService;

/// <summary>
/// Self-update (REQ HW-01). The One POS web app tells the service its server's address; every 6 hours (and when asked from the
/// Devices screen) the service asks that server for the latest Device Service. A newer one is downloaded, its SHA-256 checked
/// against the server's, and installed quietly with msiexec (the installer stops this service, replaces it and starts it again).
/// Off per PC from the Devices screen; nothing is downloaded from anywhere but the server the web app came from.
/// </summary>
public sealed class Updater(SettingsStore store, ILogger<Updater> logger) : BackgroundService
{
    public sealed record Latest(string Version, string File, string Sha256);

    public static readonly string Version = typeof(Updater).Assembly.GetName().Version?.ToString(3) ?? "1.0.0";
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromMinutes(5) };
    private readonly SemaphoreSlim busy = new(1, 1);

    public string? LatestVersion { get; private set; }
    public DateTime? LastCheck { get; private set; }
    public string? LastResult { get; private set; }

    protected override async Task ExecuteAsync(CancellationToken stop)
    {
        try { await Task.Delay(TimeSpan.FromMinutes(2), stop); } catch (OperationCanceledException) { return; }
        while (!stop.IsCancellationRequested)
        {
            if (store.Get().AutoUpdate) await CheckAsync(install: true, stop);
            try { await Task.Delay(TimeSpan.FromHours(6), stop); } catch (OperationCanceledException) { return; }
        }
    }

    private static bool Newer(string candidate, string current) =>
        System.Version.TryParse(candidate, out var a) && System.Version.TryParse(current, out var b) && a > b;

    /// <summary>Asks the server; with install, a newer version is downloaded, checked and installed. Returns what happened.</summary>
    public async Task<string> CheckAsync(bool install, CancellationToken stop = default)
    {
        if (!await busy.WaitAsync(0, stop)) return LastResult ?? "Already checking.";
        try
        {
            var api = store.Get().ServerApi;
            LastCheck = DateTime.UtcNow;
            if (api is null) return LastResult = "Not paired with a One POS server yet (open One POS on this PC).";
            var latest = await Http.GetFromJsonAsync<Latest>($"{api.TrimEnd('/')}/public/device-service/latest", stop);
            if (latest is null || string.IsNullOrWhiteSpace(latest.Version)) return LastResult = "The server has no Device Service release.";
            LatestVersion = latest.Version;
            if (!Newer(latest.Version, Version)) return LastResult = $"Up to date ({Version}).";
            if (!install) return LastResult = $"Version {latest.Version} is available.";
            if (latest.File.Contains('/') || latest.File.Contains('\\') || !latest.File.EndsWith(".msi", StringComparison.OrdinalIgnoreCase))
                return LastResult = "The server's release file name isn't valid.";

            var dir = Path.Combine(Path.GetTempPath(), "OnePosUpdate");
            Directory.CreateDirectory(dir);
            var msi = Path.Combine(dir, latest.File);
            await using (var src = await Http.GetStreamAsync($"{api.TrimEnd('/')}/public/device-service/files/{Uri.EscapeDataString(latest.File)}", stop))
            await using (var dst = File.Create(msi))
                await src.CopyToAsync(dst, stop);
            string hash;
            await using (var f = File.OpenRead(msi))
                hash = Convert.ToHexString(await SHA256.HashDataAsync(f, stop));
            if (!hash.Equals(latest.Sha256, StringComparison.OrdinalIgnoreCase))
            {
                File.Delete(msi);
                return LastResult = "The download didn't match the server's checksum; not installed.";
            }
            logger.LogInformation("Installing Device Service {Version}", latest.Version);
            // msiexec outlives this service: the installer stops the service, replaces it and starts the new one.
            Process.Start(new ProcessStartInfo("msiexec.exe", $"/i \"{msi}\" /qn /norestart /l*v \"{Path.Combine(dir, "install.log")}\"") { UseShellExecute = false, CreateNoWindow = true });
            return LastResult = $"Installing {latest.Version}…";
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException or IOException or System.Text.Json.JsonException or System.ComponentModel.Win32Exception or UnauthorizedAccessException)
        {
            logger.LogWarning("Update check failed: {Error}", e.Message);
            return LastResult = $"Couldn't check: {e.Message}";
        }
        finally { busy.Release(); }
    }
}
