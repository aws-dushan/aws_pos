using System.IO.Ports;
using System.Text;

namespace OnePos.DeviceService;

/// <summary>A 2 × 20 customer pole display on a serial port (ESC/POS display commands; most VFD/LCD pole displays). REQ HW-05.</summary>
public static class PoleDisplay
{
    public static void Show(string port, string line1, string line2)
    {
        using var sp = new SerialPort(port, 9600, Parity.None, 8, StopBits.One) { WriteTimeout = 1500 };
        sp.Open();
        static string Fit(string s) => (s.Length > 20 ? s[..20] : s).PadRight(20);
        var bytes = new List<byte> { 0x0C };   // clear
        bytes.AddRange(Encoding.ASCII.GetBytes(Fit(line1) + Fit(line2)));
        sp.Write([.. bytes], 0, bytes.Count);
    }
}
