using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;

namespace OnePos.DeviceService;

/// <summary>
/// One line of a receipt as the web lays it out: text, aligned, optionally bold or large, or a left/right pair. `Ar`: an Arabic
/// label on the same row (bilingual receipts), right-aligned before the amount.
/// `Image`: a picture (the company logo), base64 PNG/JPEG, printed centred, up to `ImageWidth` dots wide (default 60 % of the paper).
/// `Mid`: a middle column (the item table's Qty). `Invert`: a band (title, grand total), printed as a framed box. `Solid`: a solid rule.
/// </summary>
public sealed record ReceiptLine(string? Text, string? Right, string? Align, bool Bold, string? Size, bool Rule, string? Ar = null, string? Image = null, int? ImageWidth = null,
    string? Mid = null, bool Invert = false, bool Solid = false);
/// <summary>A print job; `Printer`: a named printer (a kitchen station's) instead of this till's receipt printer.</summary>
public sealed record ReceiptJob(string JobId, List<ReceiptLine> Lines, bool OpenDrawer, bool Cut = true, string? Printer = null);

/// <summary>
/// Draws a receipt into a black-and-white picture the width of the paper, then sends it as raster data (REQ HW-03). Drawing it,
/// rather than sending text, prints Arabic (right-to-left, joined letters) and any font correctly on every printer.
/// For print quality on thermal paper: text uses the fonts' hinted black-and-white drawing, body text is semibold, and pictures are
/// dithered (shades become fine dot patterns, not blotches).
/// No large black areas: they print streaky and grey on thermal paper and wear the head. Bands are framed boxes, and a mostly dark
/// logo prints reversed (dark lettering on white).
/// </summary>
public static class ReceiptRenderer
{
    private const int Margin = 8;

    /// <summary>The ESC/POS bytes of a receipt for a printer `dots` wide.</summary>
    public static byte[] Render(ReceiptJob job, int dots)
    {
        using var bmp = Draw(job, dots, 1);
        var bytes = new List<byte>(EscPos.Init);
        bytes.AddRange(EscPos.Quality);
        bytes.AddRange(EscPos.Raster(bmp));
        if (job.Cut) bytes.AddRange(EscPos.FeedAndCut);
        if (job.OpenDrawer) bytes.AddRange(EscPos.OpenDrawer);
        return [.. bytes];
    }

    /// <summary>The receipt as a PNG, `scale` times sharper than the paper (a PDF or a screen preview of the same layout).</summary>
    public static byte[] Preview(ReceiptJob job, int dots, int scale)
    {
        using var bmp = Draw(job, dots, Math.Clamp(scale, 1, 4));
        using var ms = new MemoryStream();
        bmp.Save(ms, ImageFormat.Png);
        return ms.ToArray();
    }

    /// <summary>Draws the receipt: `k` = 1 for the printer (pure black and white), more for a sharp preview.</summary>
    private static Bitmap Draw(ReceiptJob job, int dots, int k)
    {
        var width = dots * k;
        using var probe = new Bitmap(1, 1);
        using var gp = Graphics.FromImage(probe);
        // On paper (k = 1): the fonts' own hinted black-and-white drawing, made for exactly this (even strokes, open letters).
        // A sharper preview (k > 1) is drawn smooth.
        var hint = k == 1 ? TextRenderingHint.SingleBitPerPixelGridFit : TextRenderingHint.AntiAliasGridFit;
        gp.TextRenderingHint = hint;
        var height = Margin * k;
        foreach (var l in job.Lines) height += LineHeight(gp, l, dots, k);
        height += Margin * k;

        var bmp = new Bitmap(width, height);
        using (var g = Graphics.FromImage(bmp))
        {
            g.Clear(Color.White);
            g.TextRenderingHint = hint;
            g.SmoothingMode = k == 1 ? SmoothingMode.None : SmoothingMode.AntiAlias;
            var m = Margin * k;
            var y = m;
            foreach (var l in job.Lines)
            {
                var h = LineHeight(g, l, dots, k);
                if (l.Image is not null)
                {
                    using var pic = Picture(l);
                    if (pic is not null)
                    {
                        var (w, ph) = Fit(pic, l, dots);
                        // Scaled to its printed size first, then dithered to dots: what the paper shows (sharper in a preview).
                        using var sized = new Bitmap(w, ph);
                        using (var gs = Graphics.FromImage(sized))
                        {
                            gs.Clear(Color.White);
                            gs.InterpolationMode = InterpolationMode.HighQualityBicubic;
                            gs.DrawImage(pic, 0, 0, w, ph);
                        }
                        Dither(sized);
                        g.InterpolationMode = InterpolationMode.NearestNeighbor;
                        g.PixelOffsetMode = PixelOffsetMode.Half;
                        g.DrawImage(sized, (width - w * k) / 2, y + 4 * k, w * k, ph * k);
                        g.PixelOffsetMode = PixelOffsetMode.Default;
                    }
                }
                else if (l.Rule)
                {
                    using var pen = l.Solid ? new Pen(Color.Black, 2 * k) : new Pen(Color.Black, 1.5f * k) { DashPattern = [3, 2] };
                    g.DrawLine(pen, m, y + h / 2, width - m, y + h / 2);
                }
                else
                {
                    using var font = FontOf(l, k);
                    var ink = Brushes.Black;
                    // A band: a box framed across the paper, the text inside, a little inset.
                    if (l.Invert)
                    {
                        using var frame = new Pen(Color.Black, 3 * k);
                        g.DrawRectangle(frame, m + 1.5f * k, y + 2.5f * k, width - 2 * m - 3 * k, h - 5 * k);
                    }
                    var pad = l.Invert ? 10 * k : 0;
                    var full = new RectangleF(m + pad, y + (l.Invert ? 4 * k : 0), width - 2 * m - 2 * pad, h);
                    // A line with an amount keeps its text clear of the amount column (and of the middle column).
                    var rightWidth = l.Right is null ? 0 : g.MeasureString(l.Right, font).Width + 12 * k;
                    if (l.Mid is not null) rightWidth = Math.Max(rightWidth, (dots - MidX(dots) + MidWidth / 2) * k);
                    var box = new RectangleF(full.X, full.Y, full.Width - rightWidth, h);
                    var text = l.Text ?? "";
                    var rtl = text.Any(ch => ch is >= '؀' and <= 'ۿ');
                    using var sf = new StringFormat(rtl ? StringFormatFlags.DirectionRightToLeft : 0)
                    {
                        // Right-to-left text: "Far" is the left edge, so a line with an amount keeps its text on the left, like every other line.
                        // In right-to-left text Near is the right edge: "right" and "left" are mapped so they mean the same edges as in English.
                        Alignment = l.Right is not null ? (rtl ? StringAlignment.Far : StringAlignment.Near) : (l.Align ?? "left") switch
                        {
                            "center" => StringAlignment.Center,
                            "right" => rtl ? StringAlignment.Near : StringAlignment.Far,
                            _ => rtl ? StringAlignment.Far : StringAlignment.Near,
                        },
                        Trimming = StringTrimming.Word,
                    };
                    g.DrawString(text, font, ink, box, sf);
                    if (!string.IsNullOrEmpty(l.Ar))
                    {
                        // Right-to-left: "Near" is the right edge of the box, i.e. just before the amount column.
                        using var ar = new StringFormat(StringFormatFlags.DirectionRightToLeft) { Alignment = StringAlignment.Near };
                        g.DrawString(l.Ar, font, ink, box, ar);
                    }
                    if (l.Mid is not null)
                    {
                        using var mid = new StringFormat { Alignment = StringAlignment.Center };
                        g.DrawString(l.Mid, font, ink, new RectangleF((MidX(dots) - MidWidth / 2) * k, full.Y, MidWidth * k, h), mid);
                    }
                    if (l.Right is not null)
                    {
                        using var right = new StringFormat { Alignment = StringAlignment.Far };
                        g.DrawString(l.Right, font, ink, full, right);
                    }
                }
                y += h;
            }
        }
        return bmp;
    }

    /// <summary>The middle column's centre (the Qty of the item table) and width, in printer dots.</summary>
    private static int MidX(int dots) => dots * 64 / 100;
    private const int MidWidth = 80;

    /// <summary>Thermal paper prints thin strokes faint: body text is semibold, bold is bold, and sizes suit 203 dpi.</summary>
    private static Font FontOf(ReceiptLine l, int k) => new(l.Bold ? "Segoe UI" : "Segoe UI Semibold",
        (l.Size == "large" ? 36 : l.Size == "name" ? 32 : l.Size == "small" ? 22 : 27) * k, l.Bold ? FontStyle.Bold : FontStyle.Regular, GraphicsUnit.Pixel);

    /// <summary>The picture of an image line, or null when it can't be read (then the line takes no room).</summary>
    private static Bitmap? Picture(ReceiptLine l)
    {
        try { return new Bitmap(new MemoryStream(Convert.FromBase64String(l.Image!))); }
        catch (Exception ex) when (ex is FormatException or ArgumentException) { return null; }
    }

    /// <summary>The printed size of a picture, in printer dots: its width capped (default 60 % of the paper), height in proportion.</summary>
    private static (int W, int H) Fit(Bitmap pic, ReceiptLine l, int dots)
    {
        var w = Math.Min(Math.Min(l.ImageWidth ?? dots * 6 / 10, dots - 2 * Margin), pic.Width * 3);
        return (w, Math.Max(1, pic.Height * w / pic.Width));
    }

    /// <summary>
    /// Floyd–Steinberg: a picture to pure black and white dots, its shades kept as patterns. Transparent counts as white. A mostly
    /// dark picture (a white-on-black logo) is reversed first: thermal paper prints large black areas badly.
    /// </summary>
    private static void Dither(Bitmap b)
    {
        var w = b.Width; var h = b.Height;
        var lum = new float[w * h];
        var dark = 0;
        for (var y = 0; y < h; y++)
            for (var x = 0; x < w; x++)
            {
                var c = b.GetPixel(x, y);
                var v = (c.R * 299 + c.G * 587 + c.B * 114) / 1000f;
                lum[y * w + x] = c.A < 128 ? 255 : v;
                if (lum[y * w + x] < 128) dark++;
            }
        if (dark > w * h * 45 / 100)
        {
            // Reversed: but the outside of the picture stays paper-white (a dark box's white margin doesn't turn into a black frame).
            for (var i = 0; i < lum.Length; i++) lum[i] = 255 - lum[i];
            FloodWhite(lum, w, h);
        }
        for (var y = 0; y < h; y++)
            for (var x = 0; x < w; x++)
            {
                var i = y * w + x;
                var black = lum[i] < 128;
                var err = lum[i] - (black ? 0 : 255);
                b.SetPixel(x, y, black ? Color.Black : Color.White);
                if (x + 1 < w) lum[i + 1] += err * 7 / 16;
                if (y + 1 < h)
                {
                    if (x > 0) lum[i + w - 1] += err * 3 / 16;
                    lum[i + w] += err * 5 / 16;
                    if (x + 1 < w) lum[i + w + 1] += err * 1 / 16;
                }
            }
    }

    /// <summary>After reversing: what is dark and joined to the picture's edge was its white margin; it goes back to white.</summary>
    private static void FloodWhite(float[] lum, int w, int h)
    {
        var seen = new bool[w * h];
        var todo = new Stack<int>();
        for (var x = 0; x < w; x++) { todo.Push(x); todo.Push((h - 1) * w + x); }
        for (var y = 0; y < h; y++) { todo.Push(y * w); todo.Push(y * w + w - 1); }
        while (todo.Count > 0)
        {
            var i = todo.Pop();
            if (seen[i] || lum[i] >= 128) continue;
            seen[i] = true;
            lum[i] = 255;
            int x = i % w, y = i / w;
            if (x > 0) todo.Push(i - 1);
            if (x + 1 < w) todo.Push(i + 1);
            if (y > 0) todo.Push(i - w);
            if (y + 1 < h) todo.Push(i + w);
        }
    }

    private static int LineHeight(Graphics g, ReceiptLine l, int dots, int k)
    {
        if (l.Image is not null)
        {
            using var pic = Picture(l);
            return pic is null ? 0 : (Fit(pic, l, dots).H + 10) * k;
        }
        if (l.Rule) return 14 * k;
        using var font = FontOf(l, k);
        // The room the text has, as it is drawn: the amount's real width (and the middle column, a band's inset) kept clear.
        var rightWidth = l.Right is null ? 0 : g.MeasureString(l.Right, font).Width + 12 * k;
        if (l.Mid is not null) rightWidth = Math.Max(rightWidth, (dots - MidX(dots) + MidWidth / 2) * k);
        var room = (dots - 2 * Margin - (l.Invert ? 20 : 0)) * k - rightWidth;
        var size = g.MeasureString(l.Text ?? " ", font, (int)Math.Max(room, 40 * k));
        return (int)Math.Ceiling(Math.Max(size.Height, font.GetHeight(g))) + 2 * k + (l.Invert ? 10 * k : 0);
    }
}
