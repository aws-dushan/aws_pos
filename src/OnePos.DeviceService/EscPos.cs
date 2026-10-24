using System.Drawing;

namespace OnePos.DeviceService;

/// <summary>ESC/POS commands understood by Epson, Star (ESC/POS mode), Xprinter and most thermal receipt printers.</summary>
public static class EscPos
{
    public static readonly byte[] Init = [0x1B, 0x40];
    /// <summary>
    /// Darker and steady for receipts (Epson GS ( K): print density +6 (about 130 %) so black prints solid black, at print speed
    /// level 3 (level 1 was too slow at the counter; full speed prints lighter). Printers without these functions ignore them.
    /// </summary>
    public static readonly byte[] Quality = [0x1D, 0x28, 0x4B, 0x02, 0x00, 0x31, 0x06, 0x1D, 0x28, 0x4B, 0x02, 0x00, 0x32, 0x03];
    /// <summary>Feed a few lines and cut (partial cut).</summary>
    public static readonly byte[] FeedAndCut = [0x1B, 0x64, 0x04, 0x1D, 0x56, 0x42, 0x00];
    /// <summary>Kick the cash drawer on pin 2 (ESC p 0 25 250): the drawer plugged into the printer opens.</summary>
    public static readonly byte[] OpenDrawer = [0x1B, 0x70, 0x00, 0x19, 0xFA];

    /// <summary>A 1-bit picture as GS v 0 raster data (dark pixels print). Width is rounded up to whole bytes.</summary>
    public static byte[] Raster(Bitmap bmp, bool emphasize = false)
    {
        var widthBytes = (bmp.Width + 7) / 8;
        var data = new byte[widthBytes * bmp.Height];
        for (var y = 0; y < bmp.Height; y++)
        {
            var before = false;
            for (var x = 0; x < bmp.Width; x++)
            {
                var c = bmp.GetPixel(x, y);
                var lum = (c.R * 299 + c.G * 587 + c.B * 114) / 1000;
                var dark = c.A > 128 && lum < 175;
                // Emphasized, as thermal printers do it: each dot printed again one dot to the right, so strokes are two dots
                // wide and print solid, while the insides of letters stay open.
                if (dark || (emphasize && before)) data[y * widthBytes + x / 8] |= (byte)(0x80 >> (x % 8));
                before = dark;
            }
        }
        var head = new byte[] { 0x1D, 0x76, 0x30, 0x00, (byte)(widthBytes & 0xFF), (byte)(widthBytes >> 8), (byte)(bmp.Height & 0xFF), (byte)(bmp.Height >> 8) };
        return [.. head, .. data];
    }
}
