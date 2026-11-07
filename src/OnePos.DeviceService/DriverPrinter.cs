using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Printing;

namespace OnePos.DeviceService;

/// <summary>
/// Prints the receipt picture through the printer's own Windows driver, as any program does ("Windows driver" on the Devices screen):
/// for a printer that doesn't understand ESC/POS pictures (it prints letters and symbols instead). The driver turns the picture into
/// the printer's own language, so any printer whose driver prints a Windows test page works. The picture is printed dot for dot
/// at the thermal printers' 203 dpi; a receipt longer than the driver's page goes on over several pages.
/// </summary>
public static class DriverPrinter
{
    private const float Dpi = 203f;

    public static void Print(string printer, Bitmap receipt, string jobName)
    {
        if (printer.StartsWith("file:", StringComparison.OrdinalIgnoreCase))
        {
            receipt.Save(printer[5..] + ".png", System.Drawing.Imaging.ImageFormat.Png);
            return;
        }
        using var doc = new PrintDocument { DocumentName = jobName, PrintController = new StandardPrintController() };
        doc.PrinterSettings.PrinterName = printer;
        if (!doc.PrinterSettings.IsValid) throw new IOException($"Printer \"{printer}\" isn't available.");
        // Sizes in hundredths of an inch: the picture at 203 dots per inch, as wide as the paper's printable width.
        var width = (int)Math.Ceiling(receipt.Width * 100 / Dpi);
        var height = (int)Math.Ceiling(receipt.Height * 100 / Dpi);
        doc.DefaultPageSettings.Margins = new Margins(0, 0, 0, 0);
        try { doc.DefaultPageSettings.PaperSize = new PaperSize("One POS receipt", width, Math.Max(height, 100)); }
        catch (Exception) { /* a driver that takes no custom size keeps its own; the receipt then goes on over its pages */ }
        var top = 0;   // the first picture row of the next page
        doc.PrintPage += (_, e) =>
        {
            var g = e.Graphics!;
            g.InterpolationMode = InterpolationMode.NearestNeighbor;
            g.PixelOffsetMode = PixelOffsetMode.Half;
            g.PageUnit = GraphicsUnit.Display;   // hundredths of an inch
            // What fits on this page (the driver's own page length if it ignored the custom one).
            var pageRows = (int)Math.Floor(e.PageBounds.Height * Dpi / 100f);
            if (pageRows <= 0) pageRows = receipt.Height;
            var rows = Math.Min(pageRows, receipt.Height - top);
            var dest = new RectangleF(0, 0, receipt.Width * 100 / Dpi, rows * 100 / Dpi);
            g.DrawImage(receipt, dest, new RectangleF(0, top, receipt.Width, rows), GraphicsUnit.Pixel);
            top += rows;
            e.HasMorePages = top < receipt.Height;
        };
        doc.Print();
    }
}
