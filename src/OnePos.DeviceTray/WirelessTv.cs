using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using UIA = System.Windows.Automation;

namespace OnePos.DeviceTray;

/// <summary>
/// Wireless (Miracast) TVs, best effort. The tray remembers the name of a TV that was connected wirelessly
/// (%LOCALAPPDATA%\OnePos\tray.json). Connecting a TV (one a manager picked in One POS, or the remembered one from "Connect
/// wireless TV" and one try about 20 seconds after the tray starts) opens Windows' Cast panel (Win+K), picks that TV in it, waits
/// up to 20 seconds for it to connect, closes the panel and extends the desktop onto it, so it becomes a screen of its own.
/// One attempt each time; never in a loop.
/// </summary>
internal static class WirelessTv
{
    private static readonly string File = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "OnePos", "tray.json");
    private static int busy;

    private sealed class State
    {
        public string? WirelessTv { get; set; }
    }

    public static string? Remembered
    {
        get
        {
            try { return System.IO.File.Exists(File) ? JsonSerializer.Deserialize<State>(System.IO.File.ReadAllText(File))?.WirelessTv : null; }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException or JsonException) { return null; }
        }
    }

    /// <summary>Remembers the wireless TV connected now (if any and if new).</summary>
    public static void RememberConnected()
    {
        var name = Displays.WirelessNames().FirstOrDefault();
        if (name is not null) Remember(name);
    }

    /// <summary>Remembers this TV as the one to bring back after a restart.</summary>
    public static void Remember(string name)
    {
        if (string.Equals(name, Remembered, StringComparison.Ordinal)) return;
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(File)!);
            System.IO.File.WriteAllText(File, JsonSerializer.Serialize(new State { WirelessTv = name }));
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { }
    }

    public static bool Connected(string name) => Displays.WirelessNames().Any(n => string.Equals(n, name, StringComparison.OrdinalIgnoreCase));

    /// <summary>How a connect attempt ended: <see cref="Message"/> is a plain sentence for a manager (without the TV's name).</summary>
    public sealed record Result(bool Ok, string Message);

    /// <summary>
    /// Connects this TV (by its name, as the Cast panel shows it) and extends the desktop onto it, then remembers it. With no name,
    /// opens the Cast panel for the user to pick one and extends onto it once it connects. Runs off the screen's thread.
    /// </summary>
    public static async Task<Result> ConnectAsync(string? name)
    {
        if (Interlocked.Exchange(ref busy, 1) == 1) return new(false, "This till is already connecting a wireless TV. Try again in a minute.");
        try
        {
            if (name is not null && Connected(name)) { Extend(); Remember(name); return new(true, "Connected and playing."); }
            var before = GetForegroundWindow();
            OpenCastPanel();
            if (name is null)
            {
                // Nothing named: the user picks the TV in the panel.
                if (!await WaitForWirelessAsync(null, TimeSpan.FromSeconds(60))) return new(false, "No wireless TV was connected.");
                RememberConnected();
                Extend();
                return new(true, "Wireless TV connected.");
            }
            var picked = await Task.Run(() => Pick(name, before, TimeSpan.FromSeconds(15)));
            var connected = picked && await WaitForWirelessAsync(name, TimeSpan.FromSeconds(20));
            if (GetForegroundWindow() != before) Key(VkEscape);   // close the Cast panel if it's still open
            if (!connected)
                return new(false, picked
                    ? "The TV didn't answer. Check it is on with Screen Mirroring open."
                    : "The TV wasn't found. Check it is on with Screen Mirroring open, near this till.");
            await Task.Delay(1000);
            Extend();
            Remember(name);
            return new(true, "Connected and playing.");
        }
        catch (Exception e) when (e is not OutOfMemoryException)
        {
            return new(false, $"Couldn't connect the TV: {e.Message}");
        }
        finally { Interlocked.Exchange(ref busy, 0); }
    }

    private static async Task<bool> WaitForWirelessAsync(string? name, TimeSpan within)
    {
        var until = DateTime.UtcNow + within;
        while (DateTime.UtcNow < until)
        {
            if (name is null ? Displays.WirelessNames().Count > 0 : Connected(name)) return true;
            await Task.Delay(1000);
        }
        return false;
    }

    /// <summary>The wireless TV as a screen of its own (not a copy of the till's screen).</summary>
    private static void Extend()
    {
        try
        {
            using var p = Process.Start(new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "DisplaySwitch.exe"), "/extend") { UseShellExecute = false, CreateNoWindow = true });
        }
        catch (Exception e) when (e is System.ComponentModel.Win32Exception or InvalidOperationException) { }
    }

    /// <summary>Finds the TV in the Cast panel (it can take a few seconds to show up) and picks it.</summary>
    private static bool Pick(string name, IntPtr notThis, TimeSpan within)
    {
        var until = DateTime.UtcNow + within;
        while (DateTime.UtcNow < until)
        {
            foreach (var root in Roots(notThis))
            {
                try
                {
                    foreach (UIA.AutomationElement el in root.FindAll(UIA.TreeScope.Descendants, UIA.Condition.TrueCondition))
                    {
                        string elName;
                        try { elName = el.Current.Name; } catch (UIA.ElementNotAvailableException) { continue; }
                        if (string.IsNullOrEmpty(elName) || !elName.Contains(name, StringComparison.OrdinalIgnoreCase)) continue;
                        if (el.TryGetCurrentPattern(UIA.InvokePattern.Pattern, out var inv)) { ((UIA.InvokePattern)inv).Invoke(); return true; }
                        if (el.TryGetCurrentPattern(UIA.SelectionItemPattern.Pattern, out var sel)) { ((UIA.SelectionItemPattern)sel).Select(); return true; }
                    }
                }
                catch (Exception e) when (e is UIA.ElementNotAvailableException or InvalidOperationException or COMException) { }
            }
            Thread.Sleep(1000);
        }
        return false;
    }

    /// <summary>
    /// Where the Cast panel lives: the window in front (the panel just opened; never the window that was in front before, e.g. One POS
    /// itself, which may show the TV's name too), else the Windows shell's own windows.
    /// </summary>
    private static List<UIA.AutomationElement> Roots(IntPtr notThis)
    {
        var list = new List<UIA.AutomationElement>();
        try { var fg = GetForegroundWindow(); if (fg != IntPtr.Zero && fg != notThis) list.Add(UIA.AutomationElement.FromHandle(fg)); }
        catch (Exception e) when (e is UIA.ElementNotAvailableException or ArgumentException or COMException) { }
        try
        {
            var shell = Process.GetProcesses()
                .Where(p => p.ProcessName is "ShellExperienceHost" or "ShellHost" or "StartMenuExperienceHost")
                .Select(p => { using (p) return p.Id; }).ToHashSet();
            foreach (UIA.AutomationElement w in UIA.AutomationElement.RootElement.FindAll(UIA.TreeScope.Children, UIA.Condition.TrueCondition))
                try { if (shell.Contains(w.Current.ProcessId)) list.Add(w); } catch (UIA.ElementNotAvailableException) { }
        }
        catch (Exception e) when (e is UIA.ElementNotAvailableException or InvalidOperationException or COMException) { }
        return list;
    }

    private static void OpenCastPanel()
    {
        SendInput(4, [Down(VkLWin), Down(VkK), Up(VkK), Up(VkLWin)], Marshal.SizeOf<Input>());
        Thread.Sleep(1500);
    }

    private static void Key(ushort vk) => SendInput(2, [Down(vk), Up(vk)], Marshal.SizeOf<Input>());

    private static Input Down(ushort vk) => new() { type = 1, u = new InputUnion { ki = new KeybdInput { wVk = vk } } };
    private static Input Up(ushort vk) => new() { type = 1, u = new InputUnion { ki = new KeybdInput { wVk = vk, dwFlags = KeyEventFKeyUp } } };

    private const ushort VkLWin = 0x5B;
    private const ushort VkK = 0x4B;
    private const ushort VkEscape = 0x1B;
    private const uint KeyEventFKeyUp = 0x0002;

    [StructLayout(LayoutKind.Sequential)]
    private struct Input { public uint type; public InputUnion u; }

    [StructLayout(LayoutKind.Explicit)]
    private struct InputUnion
    {
        [FieldOffset(0)] public MouseInput mi;
        [FieldOffset(0)] public KeybdInput ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MouseInput { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    private struct KeybdInput { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint count, Input[] inputs, int size);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();
}
