using System.Drawing.Printing;
using System.Runtime.InteropServices;

namespace OnePos.DeviceService;

/// <summary>
/// Sends bytes straight to a printer through its normal Windows driver in RAW mode (REQ HW-03): any receipt printer with a Windows
/// driver works — USB, network or Bluetooth-paired — with no driver swapping.
/// </summary>
public static partial class RawPrinter
{
    public static IReadOnlyList<string> Installed() => PrinterSettings.InstalledPrinters.Cast<string>().OrderBy(x => x).ToList();

    public static void Send(string printer, byte[] bytes, string jobName)
    {
        if (printer.StartsWith("file:", StringComparison.OrdinalIgnoreCase))
        {
            var file = printer[5..];
            Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(file))!);
            File.WriteAllBytes(file, bytes);
            return;
        }
        if (!OpenPrinter(printer, out var h, IntPtr.Zero)) throw new IOException($"Printer \"{printer}\" isn't available (error {Marshal.GetLastWin32Error()}).");
        try
        {
            var doc = new DocInfo { DocName = jobName, DataType = "RAW" };
            if (StartDocPrinter(h, 1, doc) == 0) throw new IOException($"Printer \"{printer}\" refused the job (error {Marshal.GetLastWin32Error()}).");
            try
            {
                StartPagePrinter(h);
                var p = Marshal.AllocCoTaskMem(bytes.Length);
                try
                {
                    Marshal.Copy(bytes, 0, p, bytes.Length);
                    if (!WritePrinter(h, p, bytes.Length, out var written) || written != bytes.Length)
                        throw new IOException($"Printer \"{printer}\" took only part of the job (error {Marshal.GetLastWin32Error()}).");
                }
                finally { Marshal.FreeCoTaskMem(p); }
                EndPagePrinter(h);
            }
            finally { EndDocPrinter(h); }
        }
        finally { ClosePrinter(h); }
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private sealed class DocInfo
    {
        [MarshalAs(UnmanagedType.LPWStr)] public string DocName = "";
        [MarshalAs(UnmanagedType.LPWStr)] public string? OutputFile;
        [MarshalAs(UnmanagedType.LPWStr)] public string DataType = "RAW";
    }

    /// <summary>
    /// What Windows' spooler says about the printer (REQ HW-08): ready, paper out, offline, error, paused, or not found. Many
    /// USB receipt printers on generic drivers always report ready; a failed print then shows as the service's last error.
    /// </summary>
    public static string State(string printer)
    {
        if (printer.StartsWith("file:", StringComparison.OrdinalIgnoreCase)) return "ready";
        if (!OpenPrinter(printer, out var h, IntPtr.Zero)) return "not found";
        try
        {
            GetPrinter(h, 6, IntPtr.Zero, 0, out var needed);
            if (needed <= 0) return "unknown";
            var buf = Marshal.AllocHGlobal(needed);
            try
            {
                if (!GetPrinter(h, 6, buf, needed, out _)) return "unknown";
                var status = (uint)Marshal.ReadInt32(buf);   // PRINTER_INFO_6.dwStatus
                if ((status & 0x10) != 0) return "paper out";
                if ((status & 0x8) != 0) return "paper jam";
                if ((status & 0x400000) != 0) return "cover open";
                if ((status & (0x80 | 0x1000)) != 0) return "offline";
                if ((status & (0x2 | 0x100000)) != 0) return "error";
                if ((status & 0x1) != 0) return "paused";
                return "ready";
            }
            finally { Marshal.FreeHGlobal(buf); }
        }
        finally { ClosePrinter(h); }
    }

    [DllImport("winspool.drv", EntryPoint = "GetPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool GetPrinter(IntPtr handle, int level, IntPtr buffer, int size, out int needed);
    [DllImport("winspool.drv", EntryPoint = "OpenPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool OpenPrinter(string name, out IntPtr handle, IntPtr defaults);
    [DllImport("winspool.drv", SetLastError = true)]
    private static extern bool ClosePrinter(IntPtr handle);
    [DllImport("winspool.drv", EntryPoint = "StartDocPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern int StartDocPrinter(IntPtr handle, int level, [In] DocInfo doc);
    [DllImport("winspool.drv", SetLastError = true)]
    private static extern bool EndDocPrinter(IntPtr handle);
    [DllImport("winspool.drv", SetLastError = true)]
    private static extern bool StartPagePrinter(IntPtr handle);
    [DllImport("winspool.drv", SetLastError = true)]
    private static extern bool EndPagePrinter(IntPtr handle);
    [DllImport("winspool.drv", SetLastError = true)]
    private static extern bool WritePrinter(IntPtr handle, IntPtr bytes, int count, out int written);
}
