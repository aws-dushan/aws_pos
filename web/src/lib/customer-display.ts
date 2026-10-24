"use client";

/*
 * The customer-facing display (REQ HW-05): a second window (second monitor / rear screen) on the same till, fed by the register over
 * a BroadcastChannel — no server round trip. A pole display, if the till has one, gets the same news through the Device Service.
 */

import { poleDisplay } from "@/lib/device";
import { fmtQty } from "@/lib/pos";

export const DISPLAY_CHANNEL = "onepos-customer-display";

export type DisplayMessage =
  | { kind: "order"; currency: string; number: number | null; lines: { id: string; qty: number; name: string; nameAr?: string | null; extras: string; amount: number }[]; discount: number; vat: number; total: number; due: number }
  | { kind: "paid"; currency: string; total: number; change: number }
  | { kind: "idle" };

let channel: BroadcastChannel | null = null;
let last = "";

export function sendToDisplay(m: DisplayMessage) {
  const json = JSON.stringify(m);
  if (json === last) return;
  last = json;
  channel ??= typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(DISPLAY_CHANNEL);
  channel?.postMessage(m);
  // The 2-line pole display: the last item and the total, or the change.
  const fit = (a: string, b: string) => (a.slice(0, 20 - b.length - 1).padEnd(20 - b.length) + b);
  if (m.kind === "order") {
    const l = m.lines.at(-1);
    void poleDisplay(l ? fit(`${fmtQty(l.qty)} ${l.name}`, l.amount.toFixed(2)) : "Welcome", fit("TOTAL", m.due.toFixed(2)));
  } else if (m.kind === "paid") void poleDisplay(fit("PAID", m.total.toFixed(2)), fit("CHANGE", m.change.toFixed(2)));
  else void poleDisplay("Welcome", "");
}

/**
 * Opens the customer display on the second screen when the browser can tell where it is (Chrome/Edge window management, asked once),
 * else in a new window to drag there. The display goes full screen on its first tap.
 */
export async function openCustomerDisplay(url: string) {
  let features = "popup,width=1024,height=768";
  try {
    const w = window as unknown as { getScreenDetails?: () => Promise<{ screens: { isPrimary: boolean; availLeft: number; availTop: number; availWidth: number; availHeight: number }[] }> };
    if (w.getScreenDetails) {
      const d = await w.getScreenDetails();
      const second = d.screens.find((s) => !s.isPrimary);
      if (second) features = `popup,left=${second.availLeft},top=${second.availTop},width=${second.availWidth},height=${second.availHeight}`;
    }
  } catch {
    // permission refused: open where the browser puts it
  }
  window.open(url, "onepos-customer-display", features);
}
