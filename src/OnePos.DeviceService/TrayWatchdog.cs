using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Extensions.Hosting.WindowsServices;

namespace OnePos.DeviceService;

/// <summary>
/// Keeps the tray app running for whoever is signed in at the till's own screen: the tray shows the TV screens, so it must not
/// stay closed. Every 10 seconds (only when running as the Windows service) it looks for OnePos.DeviceTray.exe in the active
/// console session and, if missing, starts it in that user's session. Never throws; a tray that keeps dying is retried less often.
/// </summary>
public sealed class TrayWatchdog(ILogger<TrayWatchdog> logger) : BackgroundService
{
    private const string TrayName = "OnePos.DeviceTray";
    private string? lastProblem;
    private readonly Queue<DateTime> launches = new();

    protected override async Task ExecuteAsync(CancellationToken stop)
    {
        if (!OperatingSystem.IsWindows() || !WindowsServiceHelpers.IsWindowsService()) return;
        try { await Task.Delay(TimeSpan.FromSeconds(20), stop); } catch (OperationCanceledException) { return; }
        while (!stop.IsCancellationRequested)
        {
            var wait = TimeSpan.FromSeconds(10);
            try
            {
                if (Check()) wait = Backoff();
            }
            catch (Exception e)
            {
                Problem($"Tray watchdog: {e.Message}");
            }
            try { await Task.Delay(wait, stop); } catch (OperationCanceledException) { return; }
        }
    }

    /// <summary>After a launch: wait 10 s, or 5 minutes when the tray was started 5 times in the last 5 minutes (it keeps closing).</summary>
    private TimeSpan Backoff()
    {
        var now = DateTime.UtcNow;
        launches.Enqueue(now);
        while (launches.Count > 0 && now - launches.Peek() > TimeSpan.FromMinutes(5)) launches.Dequeue();
        return launches.Count >= 5 ? TimeSpan.FromMinutes(5) : TimeSpan.FromSeconds(10);
    }

    private void Problem(string text)
    {
        if (text == lastProblem) return;   // the same failure every 10 s is logged once
        lastProblem = text;
        logger.LogWarning("{Problem}", text);
    }

    /// <summary>The tray's file: the installer puts it in ...\One POS\Tray next to ...\One POS\DeviceService.</summary>
    private static string? TrayPath()
    {
        var dir = AppContext.BaseDirectory;
        foreach (var p in new[] { Path.Combine(dir, "..", "Tray", TrayName + ".exe"), Path.Combine(dir, TrayName + ".exe") })
        {
            var full = Path.GetFullPath(p);
            if (File.Exists(full)) return full;
        }
        return null;
    }

    /// <summary>True when the tray was started.</summary>
    private bool Check()
    {
        var session = WTSGetActiveConsoleSessionId();
        if (session is 0xFFFFFFFF or 0) return false;
        if (Running(TrayName, session)) return false;
        // Wait until the user's desktop is up (Explorer runs), so the icon has a taskbar to go to.
        if (!Running("explorer", session)) return false;
        var exe = TrayPath();
        if (exe is null) { Problem("Tray watchdog: OnePos.DeviceTray.exe isn't installed next to the service."); return false; }
        if (!WTSQueryUserToken(session, out var userToken)) return false;   // nobody signed in at the screen
        var primary = IntPtr.Zero;
        var env = IntPtr.Zero;
        try
        {
            if (!DuplicateTokenEx(userToken, MaximumAllowed, IntPtr.Zero, SecurityImpersonation, TokenPrimary, out primary))
            { Problem($"Tray watchdog: couldn't copy the user's token ({Marshal.GetLastWin32Error()})."); return false; }
            if (!CreateEnvironmentBlock(out env, primary, false)) env = IntPtr.Zero;
            var si = new StartupInfo { cb = Marshal.SizeOf<StartupInfo>(), lpDesktop = @"winsta0\default" };
            var flags = CreateUnicodeEnvironment | CreateNewProcessGroup;
            if (!CreateProcessAsUser(primary, exe, new System.Text.StringBuilder($"\"{exe}\""), IntPtr.Zero, IntPtr.Zero, false, flags, env, Path.GetDirectoryName(exe), ref si, out var pi))
            { Problem($"Tray watchdog: couldn't start the tray ({Marshal.GetLastWin32Error()})."); return true; }
            CloseHandle(pi.hThread);
            CloseHandle(pi.hProcess);
            lastProblem = null;
            logger.LogInformation("Started the tray app in session {Session}", session);
            return true;
        }
        finally
        {
            if (env != IntPtr.Zero) DestroyEnvironmentBlock(env);
            if (primary != IntPtr.Zero) CloseHandle(primary);
            CloseHandle(userToken);
        }
    }

    private static bool Running(string name, uint session)
    {
        var found = false;
        foreach (var p in Process.GetProcessesByName(name))
        {
            try { found |= p.SessionId == session; }
            catch (InvalidOperationException) { }   // it just exited
            finally { p.Dispose(); }
        }
        return found;
    }

    private const uint MaximumAllowed = 0x02000000;
    private const int SecurityImpersonation = 2;
    private const int TokenPrimary = 1;
    private const uint CreateUnicodeEnvironment = 0x00000400;
    private const uint CreateNewProcessGroup = 0x00000200;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
        public int cb;
        public string? lpReserved;
        public string? lpDesktop;
        public string? lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        public IntPtr hProcess, hThread;
        public int dwProcessId, dwThreadId;
    }

    [DllImport("kernel32.dll")]
    private static extern uint WTSGetActiveConsoleSessionId();

    [DllImport("wtsapi32.dll", SetLastError = true)]
    private static extern bool WTSQueryUserToken(uint sessionId, out IntPtr token);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool DuplicateTokenEx(IntPtr existing, uint access, IntPtr attributes, int impersonationLevel, int tokenType, out IntPtr newToken);

    [DllImport("userenv.dll", SetLastError = true)]
    private static extern bool CreateEnvironmentBlock(out IntPtr environment, IntPtr token, bool inherit);

    [DllImport("userenv.dll", SetLastError = true)]
    private static extern bool DestroyEnvironmentBlock(IntPtr environment);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcessAsUser(IntPtr token, string applicationName, System.Text.StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes,
        bool inheritHandles, uint creationFlags, IntPtr environment, string? currentDirectory, ref StartupInfo startupInfo, out ProcessInformation processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);
}
