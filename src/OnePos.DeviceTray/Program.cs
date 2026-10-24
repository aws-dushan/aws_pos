using System.Diagnostics;
using System.Net.Http.Json;
using System.Text.Json;

namespace OnePos.DeviceTray;

/// <summary>
/// The icon by the clock (REQ HW-01): every 15 seconds it asks the Device Service on this PC how it is, shows that in the tooltip,
/// and pops up a note when something changes (the service stopped, the printer ran out of paper…). Its menu opens One POS,
/// prints a test page and checks for updates.
/// </summary>
internal static class Program
{
    [STAThread]
    private static void Main()
    {
        using var single = new Mutex(true, @"Local\OnePosDeviceTray", out var first);
        if (!first) return;
        ApplicationConfiguration.Initialize();
        Application.Run(new TrayContext());
    }
}

internal sealed class TrayContext : ApplicationContext
{
    private static readonly HttpClient Http = new() { BaseAddress = new Uri("http://127.0.0.1:5199"), Timeout = TimeSpan.FromSeconds(4) };
    private readonly NotifyIcon icon;
    private readonly ToolStripMenuItem statusItem = new("Checking…") { Enabled = false };
    private readonly ToolStripMenuItem updateItem = new("Check for updates");
    private readonly System.Windows.Forms.Timer timer = new() { Interval = 15_000 };
    private string? lastState;
    private string? server;

    public TrayContext()
    {
        using var stream = typeof(TrayContext).Assembly.GetManifestResourceStream("OnePos.DeviceTray.app.ico");
        var menu = new ContextMenuStrip();
        menu.Items.Add(statusItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Open One POS", null, (_, _) => { if (server is not null) Process.Start(new ProcessStartInfo(server) { UseShellExecute = true }); });
        menu.Items.Add("Print a test page", null, async (_, _) => await PostAsync("/print/test", new { }, "Test page sent to the printer."));
        updateItem.Click += async (_, _) => await PostAsync("/update/check", new { install = true }, null);
        menu.Items.Add(updateItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Hide this icon", null, (_, _) => { icon!.Visible = false; ExitThread(); });
        icon = new NotifyIcon { Icon = stream is null ? SystemIcons.Application : new Icon(stream), Text = "One POS", ContextMenuStrip = menu, Visible = true };
        timer.Tick += async (_, _) => await RefreshAsync();
        timer.Start();
        _ = RefreshAsync();
    }

    private async Task PostAsync(string path, object body, string? ok)
    {
        try
        {
            var res = await Http.PostAsJsonAsync(path, body);
            var json = await res.Content.ReadFromJsonAsync<JsonElement>();
            var text = res.IsSuccessStatusCode
                ? ok ?? (json.TryGetProperty("result", out var r) ? r.GetString() : "Done.")
                : json.TryGetProperty("error", out var e) ? e.GetString() : $"The service answered {(int)res.StatusCode}.";
            icon.ShowBalloonTip(4000, "One POS", text ?? "Done.", res.IsSuccessStatusCode ? ToolTipIcon.Info : ToolTipIcon.Warning);
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException or JsonException)
        {
            icon.ShowBalloonTip(4000, "One POS", "The One POS Device Service isn't running on this PC.", ToolTipIcon.Warning);
        }
    }

    private async Task RefreshAsync()
    {
        string state, text;
        try
        {
            var s = await Http.GetFromJsonAsync<JsonElement>("/status");
            var version = s.GetProperty("version").GetString();
            var printer = s.TryGetProperty("receiptPrinter", out var p) ? p.GetString() : null;
            var printerState = s.TryGetProperty("printerState", out var ps) ? ps.GetString() : null;
            if (s.TryGetProperty("update", out var u))
            {
                var latest = u.TryGetProperty("latest", out var l) ? l.GetString() : null;
                updateItem.Text = latest is not null && latest != version ? $"Update to {latest}" : "Check for updates";
            }
            if (s.TryGetProperty("server", out var sv) && sv.GetString() is { } srv) server = srv;
            state = printer is null ? "no printer" : printerState ?? "unknown";
            text = $"One POS Device Service {version}\nPrinter: {(printer is null ? "none chosen" : printerState ?? "?")}";
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException or JsonException or KeyNotFoundException or InvalidOperationException)
        {
            state = "stopped";
            text = "One POS Device Service isn't running";
        }
        // A tooltip holds 127 characters at most.
        icon.Text = text.Length > 127 ? text[..127] : text;
        statusItem.Text = text.Replace("\n", " · ");
        if (lastState is not null && state != lastState && state is "stopped" or "paper out" or "offline" or "error" or "cover open" or "paper jam")
            icon.ShowBalloonTip(5000, "One POS", state == "stopped" ? "The Device Service stopped: receipts won't print on this till." : $"Receipt printer: {state}.", ToolTipIcon.Warning);
        lastState = state;
    }
}
