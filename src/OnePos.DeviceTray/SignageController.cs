using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Win32;

namespace OnePos.DeviceTray;

/// <summary>
/// TV screens. Every 5 seconds (and at once when screens are plugged in or out) it asks the Device Service for this PC's TV token,
/// finds the screens besides the till's own, reports them to the One POS server and keeps one TV window on each screen the server
/// answers for, showing that TV's page (the page itself follows the server: the design when the TV is on, black when off).
/// No token, TV screens switched off for the branch, or a token the server doesn't know: no TV windows. Never throws.
/// Each report also lists the wireless TVs this PC can see ("nearby", each with whether it is connected now); when the server
/// answers with "connect": a TV's name (a manager picked it in One POS), the tray connects that TV once and reports how it went
/// ("connectDone") until the server stops asking.
/// </summary>
internal sealed class SignageController : IDisposable
{
    private static readonly HttpClient Local = new() { BaseAddress = new Uri("http://127.0.0.1:5199"), Timeout = TimeSpan.FromSeconds(4) };
    private static readonly HttpClient Server = new() { Timeout = TimeSpan.FromSeconds(10) };
    private static readonly string UserData = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "OnePos", "TvWebView");

    private readonly Dictionary<string, (TvWindow Window, bool IsOn)> windows = [];
    private readonly System.Windows.Forms.Timer timer = new() { Interval = 5000 };
    private readonly System.Windows.Forms.Timer wirelessOnce = new() { Interval = 20_000 };
    private readonly Control invoker = new();
    private readonly Action<string, ToolTipIcon> notify;
    private Task<CoreWebView2Environment>? environment;
    private bool running, again, runtimeWarned, configured;

    // Wireless TVs in reach: looked up at most every 20 seconds (and right after a connect attempt), off the screen's thread.
    private static readonly TimeSpan NearbyEvery = TimeSpan.FromSeconds(20);
    private List<string>? nearby;
    private DateTime nearbyAt = DateTime.MinValue;
    private bool nearbyLooking;

    // A manager's "connect this TV": the attempt running now, the request already answered (until the server stops asking), and
    // how the last attempt ended (sent on every report until the server stops asking for that TV).
    private string? connecting, answered;
    private (string Name, bool Ok, string Message)? connectDone;

    public string Status { get; private set; } = "TV screens: off";
    public event Action? StatusChanged;

    public SignageController(Action<string, ToolTipIcon> notify)
    {
        this.notify = notify;
        invoker.CreateControl();
        timer.Tick += (_, _) => _ = RunAsync();
        SystemEvents.DisplaySettingsChanged += OnDisplaysChanged;
        // One try to bring back the wireless TV this PC used before (e.g. after a restart).
        wirelessOnce.Tick += async (_, _) =>
        {
            wirelessOnce.Stop();
            if (!configured || connecting is not null || WirelessTv.Remembered is not { } tv || WirelessTv.Connected(tv)) return;
            var result = await Task.Run(() => WirelessTv.ConnectAsync(tv));
            notify($"{tv}: {result.Message}", ToolTipIcon.Info);
        };
        timer.Start();
        wirelessOnce.Start();
        _ = RunAsync();
    }

    /// <summary>"Connect wireless TV" in the tray menu.</summary>
    public async Task ConnectWirelessAsync()
    {
        var tv = WirelessTv.Remembered;
        var result = await Task.Run(() => WirelessTv.ConnectAsync(tv));
        notify(tv is null ? result.Message : $"{tv}: {result.Message}", ToolTipIcon.Info);
        nearbyAt = DateTime.MinValue;
        _ = RunAsync();
    }

    private void OnDisplaysChanged(object? sender, EventArgs e)
    {
        try { if (invoker.IsHandleCreated) invoker.BeginInvoke(() => _ = RunAsync()); }
        catch (InvalidOperationException) { }
    }

    private async Task RunAsync()
    {
        if (running) { again = true; return; }
        running = true;
        try
        {
            do { again = false; await TickAsync(); } while (again);
        }
        catch (Exception e) when (e is not OutOfMemoryException) { }
        finally { running = false; }
    }

    private async Task TickAsync()
    {
        JsonElement info;
        try { info = await Local.GetFromJsonAsync<JsonElement>("/signage"); }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException or JsonException or NotSupportedException)
        {
            Place(Displays.Tvs());   // the service is down for a moment: the TVs keep playing
            return;
        }
        var api = Text(info, "api");
        var token = Text(info, "token");
        configured = api is not null && token is not null;
        if (!configured) { CloseAll("TV screens: off"); return; }

        if (!RuntimeAvailable())
        {
            CloseAll("TV screens: need the WebView2 Runtime");
            if (!runtimeWarned) { runtimeWarned = true; notify("TV screens need the Microsoft Edge WebView2 Runtime.", ToolTipIcon.Warning); }
            return;
        }

        WirelessTv.RememberConnected();
        var monitors = Displays.Tvs();
        _ = LookForNearbyAsync();
        var done = connectDone;
        JsonElement answer;
        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Post, $"{api!.TrimEnd('/')}/public/signage/screens")
            {
                Content = JsonContent.Create(new
                {
                    machine = Environment.MachineName,
                    monitors = monitors.Select(m => new { key = m.Key, name = m.Name, width = m.Bounds.Width, height = m.Bounds.Height }),
                    nearby = Nearby(),
                    connectDone = done is { } d ? new { name = d.Name, ok = d.Ok, message = d.Message } : null,
                }, options: SkipNulls),
            };
            req.Headers.Add("X-Signage-Token", token);
            using var res = await Server.SendAsync(req);
            if (res.StatusCode == HttpStatusCode.Unauthorized) { CloseAll("TV screens: off (this PC isn't set up)"); return; }
            if (!res.IsSuccessStatusCode) { Place(monitors); return; }
            answer = await res.Content.ReadFromJsonAsync<JsonElement>();
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException or JsonException or NotSupportedException or InvalidOperationException)
        {
            Place(monitors);   // the server can't be reached: the TV pages keep showing what they have
            return;
        }

        if (!answer.TryGetProperty("enabled", out var en) || en.ValueKind != JsonValueKind.True) { CloseAll("TV screens: off"); return; }
        Connect(Text(answer, "connect"));

        // A browser that ended takes all TV windows with it: start them again with a new one.
        if (windows.Values.Any(w => w.Window.Broken)) { CloseAll(null); environment = null; }

        var web = api.EndsWith("/api", StringComparison.OrdinalIgnoreCase) ? api[..^4] : api;
        var wanted = new Dictionary<string, (TvMonitor Monitor, string Url, bool IsOn)>();
        if (answer.TryGetProperty("screens", out var screens) && screens.ValueKind == JsonValueKind.Array)
            foreach (var s in screens.EnumerateArray())
            {
                var key = Text(s, "monitorKey");
                var id = Text(s, "id");
                var monitor = monitors.FirstOrDefault(m => m.Key == key);
                if (key is null || id is null || monitor is null) continue;
                wanted[key] = (monitor, $"{web}/tv?screen={Uri.EscapeDataString(id)}&t={Uri.EscapeDataString(token!)}", s.TryGetProperty("isOn", out var on) && on.ValueKind == JsonValueKind.True);
            }

        foreach (var key in windows.Keys.Where(k => !wanted.ContainsKey(k)).ToList())
        {
            windows[key].Window.CloseTv();
            windows.Remove(key);
        }
        foreach (var (key, w) in wanted)
        {
            if (!windows.TryGetValue(key, out var have))
            {
                var tv = new TvWindow(w.Monitor.Bounds, Browser());
                tv.Navigate(w.Url);
                tv.Show();
                have = (tv, w.IsOn);
            }
            have.Window.Place(w.Monitor.Bounds);
            if (have.Window.Url != w.Url) have.Window.Navigate(w.Url);   // a new TV id or token only
            windows[key] = (have.Window, w.IsOn);
        }
        var playing = windows.Values.Count(w => w.IsOn);
        var off = windows.Count - playing;
        SetStatus(windows.Count == 0 ? "TV screens: off"
            : playing == 0 ? $"TV screens: {off} switched off"
            : off == 0 ? $"TV screens: {playing} playing" : $"TV screens: {playing} playing, {off} switched off");
    }

    /// <summary>The wireless TVs in reach, each with whether it is a screen of this PC now; null when Windows can't list them.</summary>
    private List<object>? Nearby()
    {
        if (nearby is null) return null;
        var connected = Displays.WirelessNames();
        var names = nearby.ToList();
        foreach (var c in connected) if (!names.Contains(c, StringComparer.OrdinalIgnoreCase)) names.Add(c);   // connected, so in reach
        return [.. names.Select(n => new { name = n, connected = connected.Contains(n, StringComparer.OrdinalIgnoreCase) })];
    }

    /// <summary>Looks the wireless TVs up again in the background when the last look is 20 seconds old (or was asked to).</summary>
    private async Task LookForNearbyAsync()
    {
        if (nearbyLooking || DateTime.UtcNow - nearbyAt < NearbyEvery) return;
        nearbyLooking = true;
        try
        {
            var found = await Task.Run(NearbyTvs.FindAsync);
            if (found is not null || nearbyAt == DateTime.MinValue) nearby = found;
        }
        finally { nearbyAt = DateTime.UtcNow; nearbyLooking = false; }
    }

    /// <summary>
    /// The server's "connect" (a manager asked this PC to connect that wireless TV): one attempt per request, in the background.
    /// Once the server no longer asks for that TV, its result is dropped and a new request for it counts as new.
    /// </summary>
    private void Connect(string? name)
    {
        if (connectDone is { } d && !string.Equals(d.Name, name, StringComparison.OrdinalIgnoreCase)) connectDone = null;
        if (!string.Equals(answered, name, StringComparison.OrdinalIgnoreCase)) answered = null;
        if (name is null || connecting is not null || answered is not null) return;
        connecting = answered = name;
        _ = AttemptAsync(name);
    }

    private async Task AttemptAsync(string name)
    {
        WirelessTv.Result result;
        try { result = await Task.Run(() => WirelessTv.ConnectAsync(name)); }
        catch (Exception e) when (e is not OutOfMemoryException) { result = new(false, $"Couldn't connect the TV: {e.Message}"); }
        connectDone = (name, result.Ok, result.Message);
        connecting = null;
        nearbyAt = DateTime.MinValue;   // look again at once: the list now shows it connected (or not)
        notify($"{name}: {result.Message}", result.Ok ? ToolTipIcon.Info : ToolTipIcon.Warning);
        _ = RunAsync();
    }

    /// <summary>Keeps each TV window on its screen; a window whose screen went away closes.</summary>
    private void Place(List<TvMonitor> monitors)
    {
        foreach (var key in windows.Keys.ToList())
        {
            var m = monitors.FirstOrDefault(x => x.Key == key);
            if (m is null) { windows[key].Window.CloseTv(); windows.Remove(key); }
            else windows[key].Window.Place(m.Bounds);
        }
    }

    private void CloseAll(string? status)
    {
        foreach (var w in windows.Values) w.Window.CloseTv();
        windows.Clear();
        if (status is not null) SetStatus(status);
    }

    private void SetStatus(string status)
    {
        if (status == Status) return;
        Status = status;
        StatusChanged?.Invoke();
    }

    /// <summary>One browser for all TV windows, its data under %LOCALAPPDATA%\OnePos\TvWebView; videos may play by themselves.</summary>
    private Task<CoreWebView2Environment> Browser()
    {
        if (environment is null || environment.IsFaulted || environment.IsCanceled)
            environment = CoreWebView2Environment.CreateAsync(null, UserData, new CoreWebView2EnvironmentOptions("--autoplay-policy=no-user-gesture-required"));
        return environment;
    }

    private static bool RuntimeAvailable()
    {
        try { return !string.IsNullOrEmpty(CoreWebView2Environment.GetAvailableBrowserVersionString()); }
        catch (Exception e) when (e is not OutOfMemoryException) { return false; }
    }

    private static readonly JsonSerializerOptions SkipNulls = new(JsonSerializerDefaults.Web) { DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull };

    private static string? Text(JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(v.GetString()) ? v.GetString() : null;

    public void Dispose()
    {
        SystemEvents.DisplaySettingsChanged -= OnDisplaysChanged;
        timer.Dispose();
        wirelessOnce.Dispose();
        CloseAll(null);
        invoker.Dispose();
    }
}
