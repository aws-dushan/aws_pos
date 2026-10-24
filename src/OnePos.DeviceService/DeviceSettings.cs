using System.Text.Json;

namespace OnePos.DeviceService;

/// <summary>
/// This till's device settings, kept on the PC (%ProgramData%\OnePos\device.json) and changed from One POS (Devices screen).
/// A printer name "file:C:\path\out.bin" writes the printer's bytes to a file instead (testing without a printer).
/// </summary>
public sealed class DeviceSettings
{
    public string? ReceiptPrinter { get; set; }
    /// <summary>Paper width in mm: 80 (576 dots) or 58 (384 dots).</summary>
    public int PaperWidth { get; set; } = 80;
    /// <summary>Open the drawer (through the receipt printer) when a cash payment's receipt prints.</summary>
    public bool DrawerOnCash { get; set; } = true;
    /// <summary>A 2-line pole display on a serial port (e.g. COM3); null = none.</summary>
    public string? PoleDisplayPort { get; set; }
    /// <summary>Web addresses allowed to use this service (the One POS web app).</summary>
    public List<string> AllowedOrigins { get; set; } = ["http://localhost:3100"];
    /// <summary>Install newer Device Service releases from the One POS server by itself (REQ HW-01).</summary>
    public bool AutoUpdate { get; set; } = true;
    /// <summary>The One POS server's API address (e.g. https://pos.example.com/api), told by the web app; updates come only from there.</summary>
    public string? ServerApi { get; set; }

    public int Dots => PaperWidth <= 58 ? 384 : 576;
}

public sealed class SettingsStore
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };
    private readonly string path;
    private readonly Lock gate = new();
    private DeviceSettings current;

    public SettingsStore(IConfiguration config)
    {
        path = config["SettingsFile"] ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "OnePos", "device.json");
        current = File.Exists(path) ? JsonSerializer.Deserialize<DeviceSettings>(File.ReadAllText(path), Json) ?? new() : new();
        foreach (var o in config.GetSection("AllowedOrigins").Get<string[]>() ?? [])
            if (!current.AllowedOrigins.Contains(o)) current.AllowedOrigins.Add(o);
        // The installer's WEBORIGIN (HKLM\SOFTWARE\OnePos\DeviceService\WebOrigin): the One POS web address allowed to use this service.
        if (OperatingSystem.IsWindows()
            && Microsoft.Win32.Registry.GetValue(@"HKEY_LOCAL_MACHINE\SOFTWARE\OnePos\DeviceService", "WebOrigin", null) is string web
            && Uri.TryCreate(web.Trim().TrimEnd('/'), UriKind.Absolute, out var u))
        {
            var origin = u.GetLeftPart(UriPartial.Authority);
            if (!current.AllowedOrigins.Contains(origin, StringComparer.OrdinalIgnoreCase)) current.AllowedOrigins.Add(origin);
        }
    }

    public DeviceSettings Get() { lock (gate) return current; }

    public void Save(DeviceSettings s)
    {
        lock (gate)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            File.WriteAllText(path, JsonSerializer.Serialize(s, Json));
            current = s;
        }
    }
}
