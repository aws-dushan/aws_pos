"use client";

/*
 * The One POS Device Service on this till (src/OnePos.DeviceService, http://127.0.0.1:5199): receipt printer, cash drawer
 * (through the printer) and pole display (REQ HW-01 … HW-08). The browser calls it directly; when it isn't installed or running,
 * receipts fall back to the browser's print dialog.
 */

export const DEVICE_URL = process.env.NEXT_PUBLIC_DEVICE_URL ?? "http://127.0.0.1:5199";

export type DeviceStatus = {
  service: string; version: string; machine: string; receiptPrinter: string | null; paperWidth: 58 | 80; drawerOnCash: boolean;
  poleDisplayPort: string | null; printers: string[]; ports: string[]; lastError: string | null; lastPrintAt: string | null;
  /** What Windows' spooler says about the receipt printer: ready, paper out, offline, error… (REQ HW-08). */
  printerState?: string | null;
  /** Self-update (REQ HW-01): on or off on this PC, the newest release the server has, when it last looked, what happened. */
  update?: { autoUpdate: boolean; latest: string | null; lastCheck: string | null; result: string | null; paired: boolean };
};

/** One printed line; `ar`: an Arabic label on the same row (bilingual receipts), right-aligned before the amount. */
export type ReceiptLine = {
  text?: string | null; right?: string | null; align?: "left" | "center" | "right";
  /** A middle column (the item table's Qty), centred between the text and the amount. */
  mid?: string | null;
  /** White on a black band (the title, the grand total). `solid`: a rule drawn solid, not dashed. */
  invert?: boolean; solid?: boolean; bold?: boolean; size?: "small" | "large" | "name"; rule?: boolean; ar?: string | null;
  /** A picture (the company logo): its address here; the printer gets it as a black-and-white PNG. */
  image?: string | null;
  /** How wide the picture prints, in printer dots (a QR code: about 200); the logo's default otherwise. */
  imageWidth?: number;
};

async function call<T>(path: string, method = "GET", body?: unknown, timeoutMs = 4000): Promise<T> {
  const ctl = new AbortController();
  const t = window.setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(DEVICE_URL + path, {
      method, signal: ctl.signal,
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : undefined;
    if (!res.ok) throw new Error(data?.error ?? `The device service answered ${res.status}.`);
    return data as T;
  } catch (e) {
    if ((e as Error).name === "AbortError" || e instanceof TypeError) throw new Error("The One POS Device Service isn't running on this till.");
    throw e;
  } finally {
    window.clearTimeout(t);
  }
}

/** This till's device service, or null when it isn't installed / running (checked quickly). */
export async function deviceStatus(): Promise<DeviceStatus | null> {
  try { return await call<DeviceStatus>("/status", "GET", undefined, 1500); } catch { return null; }
}

export const saveDeviceSettings = (s: { receiptPrinter: string | null; paperWidth: number; drawerOnCash: boolean; poleDisplayPort: string | null }) =>
  call("/settings", "PUT", s);

/** A picture as base64 PNG for the printer: at most 384 dots wide, flattened on white (thermal paper has no transparency), in greys. */
async function forPrinter(url: string): Promise<string | null> {
  try {
    const blob = await (await fetch(url, { credentials: "same-origin" })).blob();
    const img = await createImageBitmap(blob);
    const scale = Math.min(1, 384 / img.width);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.width * scale); canvas.height = Math.round(img.height * scale);
    const g = canvas.getContext("2d")!;
    g.fillStyle = "#fff"; g.fillRect(0, 0, canvas.width, canvas.height);
    g.drawImage(img, 0, 0, canvas.width, canvas.height);
    // Greys, not black and white: the Device Service dithers them to dots, so a tinted background stays light and a light brand
    // colour still shows (as a fine pattern) instead of the whole picture printing as a black block.
    const px = g.getImageData(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < px.data.length; i += 4) {
      const lum = Math.round(0.299 * px.data[i] + 0.587 * px.data[i + 1] + 0.114 * px.data[i + 2]);
      px.data[i] = px.data[i + 1] = px.data[i + 2] = lum;
    }
    g.putImageData(px, 0, 0);
    return canvas.toDataURL("image/png").split(",")[1] ?? null;
  } catch { return null; }
}

/** Prints a receipt; `jobId` makes a retry print once. `openDrawer`: kick the drawer too (the till's "drawer on cash" setting decides). */
export async function printReceipt(jobId: string, lines: ReceiptLine[], openDrawer: boolean, printer?: string | null) {
  const ready = await Promise.all(lines.map(async (l) => (l.image ? { ...l, image: await forPrinter(l.image) } : l)));
  return call("/print/receipt", "POST", { jobId, lines: ready.filter((l) => !("image" in l) || l.image), openDrawer, cut: true, printer: printer ?? null });
}
export const openDrawer = (jobId: string) => call("/drawer/open", "POST", { jobId });

/**
 * Cash changed hands at this till (a cash payment, part payment, cash refund, cash in or out): the drawer opens at once, whether or
 * not a receipt prints (paper out, no receipt yet). Skipped where the till's "Drawer on cash" is off or it has no printer to kick
 * the drawer through. Never throws: the money is already recorded.
 */
export async function openDrawerForCash(): Promise<boolean> {
  try {
    const s = await deviceStatus();
    if (!s || !s.receiptPrinter || !s.drawerOnCash) return false;
    await openDrawer(`cash-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    return true;
  } catch {
    return false;
  }
}
export const printTest = () => call("/print/test", "POST", {});
/** Tells the service which One POS server this web app is (updates come only from there). */
export const pairServer = (api: string) => call("/server", "PUT", { api }, 2000);
export const setAutoUpdate = (on: boolean) => call("/update/auto", "PUT", { on });
/** Asks the server for a newer Device Service; with install, a newer one is downloaded, checked and installed. */
export const checkUpdate = (install: boolean) => call<{ result: string }>("/update/check", "POST", { install }, 120_000);
/** Shows two lines on a pole display, if the till has one (ignored otherwise). */
export const poleDisplay = (line1: string, line2: string) => call("/display", "POST", { line1, line2 }, 1500).catch(() => {});
