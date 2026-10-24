import type { ReceiptLine } from "@/lib/device";

/*
 * A receipt drawn in the browser exactly as the Device Service draws it for the receipt printer (ReceiptRenderer.cs): the same
 * paper width in dots, margins, fonts and sizes (Segoe UI, semibold body), columns (amount on the right, Qty at 64 %), framed bands
 * and rules. The screen preview and the browser print show it, so they look like the till's printed receipt.
 * Keep the two in step: a change to the layout there belongs here too.
 */

const MARGIN = 8;
const MID_WIDTH = 80;
const midX = (dots: number) => (dots * 64) / 100;
/** 80 mm paper at 203 dpi (the Device Service's 80 mm setting). */
export const DOTS_80MM = 576;

const sizeOf = (l: ReceiptLine) => (l.size === "large" ? 36 : l.size === "name" ? 32 : l.size === "small" ? 22 : 27);
const fontOf = (l: ReceiptLine, k: number) => `${l.bold ? 700 : 600} ${sizeOf(l) * k}px "Segoe UI", "Segoe UI Variable", system-ui, sans-serif`;
/*
 * GDI+ text metrics, so lines wrap, space and sit as the Device Service prints them: a line is 1.41 × the size (Segoe UI as
 * GDI+ measures it), text starts at the font's ascent (1.08 × the size above the baseline), and GDI+ keeps ⅙ of the size clear
 * on each side of a text box.
 */
const LINE = 1.41;
const ASCENT = 1.08;
const padOf = (l: ReceiptLine, k: number) => (sizeOf(l) * k) / 6;
const textHeight = (l: ReceiptLine, k: number, rows: number) => Math.ceil(rows * sizeOf(l) * k * LINE);
const isRtl = (t: string) => /[؀-ۿ]/.test(t);

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src.startsWith("data:") || src.includes("/") ? src : `data:image/png;base64,${src}`;
  });
}

function fit(img: HTMLImageElement, l: ReceiptLine, dots: number) {
  const w = Math.min(Math.min(l.imageWidth ?? Math.floor((dots * 6) / 10), dots - 2 * MARGIN), img.naturalWidth * 3);
  return { w, h: Math.max(1, Math.floor((img.naturalHeight * w) / img.naturalWidth)) };
}

/** Words broken into lines that fit `room` (as GDI+ wraps them), each line as drawn. */
function wrap(g: CanvasRenderingContext2D, text: string, room: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/(\s+)/)) {
      const next = line + word;
      if (line.trim() && g.measureText(next.trimEnd()).width > room) { out.push(line.trimEnd()); line = word.trimStart(); }
      else line = next;
    }
    out.push(line.trimEnd());
  }
  return out;
}

/** The space a line's text has: the amount (and the Qty column, a band's inset) kept clear. */
function layout(g: CanvasRenderingContext2D, l: ReceiptLine, dots: number, k: number) {
  g.font = fontOf(l, k);
  const pad = padOf(l, k);
  let rightWidth = l.right == null ? 0 : g.measureText(l.right).width + 2 * pad + 12 * k;
  if (l.mid != null) rightWidth = Math.max(rightWidth, (dots - midX(dots) + MID_WIDTH / 2) * k);
  const room = Math.max((dots - 2 * MARGIN - (l.invert ? 20 : 0)) * k - rightWidth, 40 * k);
  const rows = wrap(g, l.text ?? " ", room - 2 * pad);
  return { rightWidth, rows, height: textHeight(l, k, rows.length) + 2 * k + (l.invert ? 10 * k : 0) };
}

/** Draws the receipt; `k`: how many times sharper than the paper (2 for a crisp screen and print). Returns a PNG data URL. */
export async function drawReceipt(lines: ReceiptLine[], dots = DOTS_80MM, k = 2): Promise<string> {
  if (typeof document !== "undefined" && document.fonts) await document.fonts.ready;
  const images = await Promise.all(lines.map((l) => (l.image ? loadImage(l.image) : Promise.resolve(null))));
  const probe = document.createElement("canvas").getContext("2d")!;
  const heights = lines.map((l, i) => {
    if (l.image) { const img = images[i]; return img ? (fit(img, l, dots).h + 10) * k : 0; }
    if (l.rule) return 14 * k;
    return layout(probe, l, dots, k).height;
  });
  const width = dots * k;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = MARGIN * k * 2 + heights.reduce((a, b) => a + b, 0);
  const g = canvas.getContext("2d")!;
  g.fillStyle = "#fff"; g.fillRect(0, 0, canvas.width, canvas.height);
  g.fillStyle = "#000"; g.strokeStyle = "#000"; g.textBaseline = "alphabetic";
  const m = MARGIN * k;
  let y = m;
  lines.forEach((l, i) => {
    const h = heights[i];
    if (l.image) {
      const img = images[i];
      if (img) {
        const { w, h: ph } = fit(img, l, dots);
        g.filter = "grayscale(1) contrast(1.4)";   // thermal paper is black and white
        g.drawImage(img, (width - w * k) / 2, y + 4 * k, w * k, ph * k);
        g.filter = "none";
      }
    } else if (l.rule) {
      g.lineWidth = (l.solid ? 2 : 1.5) * k;
      g.setLineDash(l.solid ? [] : [3 * g.lineWidth, 2 * g.lineWidth]);
      g.beginPath(); g.moveTo(m, y + h / 2); g.lineTo(width - m, y + h / 2); g.stroke();
      g.setLineDash([]);
    } else {
      const { rightWidth, rows } = layout(g, l, dots, k);
      if (l.invert) { g.lineWidth = 3 * k; g.strokeRect(m + 1.5 * k, y + 2.5 * k, width - 2 * m - 3 * k, h - 5 * k); }
      const pad = l.invert ? 10 * k : 0;
      const fx = m + pad, fy = y + (l.invert ? 4 * k : 0), fw = width - 2 * m - 2 * pad;
      const boxW = fw - rightWidth;
      const rtl = isRtl(l.text ?? "");
      // A line with an amount keeps its text on the left; otherwise its own alignment (Arabic-only lines default to the right).
      const align = l.right != null ? "left" : l.align ?? (rtl ? "right" : "left");
      const tp = padOf(l, k);
      const gap = sizeOf(l) * k * LINE;
      const base = fy + sizeOf(l) * k * ASCENT;   // the first line's baseline
      rows.forEach((row, r) => {
        g.direction = rtl ? "rtl" : "ltr";
        g.textAlign = align === "center" ? "center" : align === "right" ? "right" : "left";
        const x = align === "center" ? fx + boxW / 2 : align === "right" ? fx + boxW - tp : fx + tp;
        g.fillText(row, x, base + r * gap);
      });
      g.direction = "ltr";
      if (l.ar) { g.direction = "rtl"; g.textAlign = "right"; g.fillText(l.ar, fx + boxW - tp, base); g.direction = "ltr"; }
      if (l.mid != null) { g.textAlign = "center"; g.fillText(l.mid, midX(dots) * k, base); }
      if (l.right != null) { g.textAlign = "right"; g.fillText(l.right, fx + fw - tp, base); }
    }
    y += h;
  });
  return canvas.toDataURL("image/png");
}
