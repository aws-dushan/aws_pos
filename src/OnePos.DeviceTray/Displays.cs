using System.Runtime.InteropServices;

namespace OnePos.DeviceTray;

/// <summary>A screen besides the till's own: a stable key per physical TV, its name and the area it covers on the desktop.</summary>
internal sealed record TvMonitor(string Key, string Name, Rectangle Bounds, bool Wireless);

/// <summary>
/// Finds the TVs connected to this PC. Windows' display configuration (QueryDisplayConfig) gives, per screen, the monitor's
/// device path (the same for the same TV on the same connector, across restarts and resolution changes) and its own name
/// ("Hisense VIDAA TV"), also for wireless (Miracast) TVs. A wireless TV's path can change on every connection, so its key is its name.
/// </summary>
internal static class Displays
{
    private const int MaxKey = 200;   // the server keeps 200 characters of a key

    public static List<TvMonitor> Tvs()
    {
        var targets = Targets();
        var list = new List<TvMonitor>();
        foreach (var screen in Screen.AllScreens)
        {
            if (screen.Primary) continue;
            var t = targets.FirstOrDefault(x => string.Equals(x.Source, screen.DeviceName, StringComparison.OrdinalIgnoreCase));
            string key, name;
            var wireless = t.Technology == Miracast;
            if (wireless && !string.IsNullOrWhiteSpace(t.FriendlyName)) key = "miracast:" + t.FriendlyName.Trim();
            else if (!string.IsNullOrWhiteSpace(t.DevicePath)) key = t.DevicePath;
            else key = InterfaceName(screen.DeviceName) ?? screen.DeviceName;
            name = !string.IsNullOrWhiteSpace(t.FriendlyName) ? t.FriendlyName.Trim() : AdapterName(screen.DeviceName) ?? screen.DeviceName;
            if (key.Length > MaxKey) key = key[..MaxKey];
            if (list.Any(m => m.Key == key)) continue;
            list.Add(new TvMonitor(key, name, screen.Bounds, wireless));
        }
        return list;
    }

    /// <summary>Wireless (Miracast) TVs connected now, also when shown as a copy of the till's screen (not a screen of their own).</summary>
    public static List<string> WirelessNames() =>
        [.. Targets().Where(t => t.Technology == Miracast && !string.IsNullOrWhiteSpace(t.FriendlyName)).Select(t => t.FriendlyName.Trim()).Distinct()];

    private record struct Target(string Source, string FriendlyName, string DevicePath, uint Technology);

    private static List<Target> Targets()
    {
        var result = new List<Target>();
        try
        {
            for (var attempt = 0; attempt < 3; attempt++)
            {
                if (GetDisplayConfigBufferSizes(QdcOnlyActivePaths, out var nPaths, out var nModes) != 0) return result;
                var paths = new PathInfo[nPaths];
                var modes = new ModeInfo[nModes];
                var rc = QueryDisplayConfig(QdcOnlyActivePaths, ref nPaths, paths, ref nModes, modes, IntPtr.Zero);
                if (rc == ErrorInsufficientBuffer) continue;   // the screens changed in between
                if (rc != 0) return result;
                for (var i = 0; i < nPaths; i++)
                {
                    var p = paths[i];
                    var src = new SourceName { header = new InfoHeader { type = GetSourceName, size = (uint)Marshal.SizeOf<SourceName>(), adapterId = p.sourceInfo.adapterId, id = p.sourceInfo.id } };
                    var tgt = new TargetName { header = new InfoHeader { type = GetTargetName, size = (uint)Marshal.SizeOf<TargetName>(), adapterId = p.targetInfo.adapterId, id = p.targetInfo.id } };
                    if (DisplayConfigGetDeviceInfo(ref src) != 0) continue;
                    var ok = DisplayConfigGetDeviceInfo(ref tgt) == 0;
                    result.Add(new Target(src.viewGdiDeviceName ?? "", ok ? tgt.monitorFriendlyDeviceName ?? "" : "", ok ? tgt.monitorDevicePath ?? "" : "",
                        ok ? tgt.outputTechnology : p.targetInfo.outputTechnology));
                }
                return result;
            }
        }
        catch (Exception e) when (e is DllNotFoundException or EntryPointNotFoundException) { }
        return result;
    }

    private static string? InterfaceName(string deviceName)
    {
        var d = new DisplayDevice { cb = Marshal.SizeOf<DisplayDevice>() };
        return EnumDisplayDevices(deviceName, 0, ref d, EddGetDeviceInterfaceName) && !string.IsNullOrWhiteSpace(d.DeviceID) ? d.DeviceID : null;
    }

    private static string? AdapterName(string deviceName)
    {
        var d = new DisplayDevice { cb = Marshal.SizeOf<DisplayDevice>() };
        return EnumDisplayDevices(deviceName, 0, ref d, 0) && !string.IsNullOrWhiteSpace(d.DeviceString) ? d.DeviceString : null;
    }

    private const uint QdcOnlyActivePaths = 2;
    private const int ErrorInsufficientBuffer = 122;
    private const uint GetSourceName = 1;
    private const uint GetTargetName = 2;
    private const uint Miracast = 15;
    private const uint EddGetDeviceInterfaceName = 1;

    [StructLayout(LayoutKind.Sequential)]
    private struct Luid { public uint LowPart; public int HighPart; }

    [StructLayout(LayoutKind.Sequential)]
    private struct PathSourceInfo { public Luid adapterId; public uint id; public uint modeInfoIdx; public uint statusFlags; }

    [StructLayout(LayoutKind.Sequential)]
    private struct PathTargetInfo
    {
        public Luid adapterId;
        public uint id, modeInfoIdx, outputTechnology, rotation, scaling, refreshNumerator, refreshDenominator, scanLineOrdering;
        public int targetAvailable;
        public uint statusFlags;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PathInfo { public PathSourceInfo sourceInfo; public PathTargetInfo targetInfo; public uint flags; }

    /// <summary>DISPLAYCONFIG_MODE_INFO: 64 bytes, not read here.</summary>
    [StructLayout(LayoutKind.Sequential, Size = 64)]
    private struct ModeInfo { public uint infoType; }

    [StructLayout(LayoutKind.Sequential)]
    private struct InfoHeader { public uint type; public uint size; public Luid adapterId; public uint id; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct SourceName
    {
        public InfoHeader header;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string viewGdiDeviceName;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct TargetName
    {
        public InfoHeader header;
        public uint flags, outputTechnology;
        public ushort edidManufactureId, edidProductCodeId;
        public uint connectorInstance;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string monitorFriendlyDeviceName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string monitorDevicePath;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct DisplayDevice
    {
        public int cb;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceString;
        public int StateFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceID;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceKey;
    }

    [DllImport("user32.dll")]
    private static extern int GetDisplayConfigBufferSizes(uint flags, out int numPathArrayElements, out int numModeInfoArrayElements);

    [DllImport("user32.dll")]
    private static extern int QueryDisplayConfig(uint flags, ref int numPathArrayElements, [Out] PathInfo[] pathArray,
        ref int numModeInfoArrayElements, [Out] ModeInfo[] modeInfoArray, IntPtr currentTopologyId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int DisplayConfigGetDeviceInfo(ref SourceName request);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int DisplayConfigGetDeviceInfo(ref TargetName request);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern bool EnumDisplayDevices(string? device, uint devNum, ref DisplayDevice displayDevice, uint flags);
}
