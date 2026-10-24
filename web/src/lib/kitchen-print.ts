"use client";

/*
 * Kitchen and bar tickets on paper (REQ KIT-03): after a send, the till claims each new ticket (only one till ever gets it) and prints
 * it on its station's printer through this till's Device Service. A station without a printer works from the kitchen display only.
 */

import { toast } from "sonner";
import { api } from "@/lib/api";
import { printReceipt, type ReceiptLine } from "@/lib/device";
import type { KitchenTicket, OrderDetail } from "@/lib/pos";
import { fmtQty } from "@/lib/pos";

type Claim = { claimed: boolean; printer: string | null; ticket: KitchenTicket };

export function ticketLines(t: KitchenTicket): ReceiptLine[] {
  const when = new Date(t.createdAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const out: ReceiptLine[] = [];
  if (t.isCancel) out.push({ text: "*** CANCEL ***", align: "center", bold: true, size: "large" });
  out.push(
    { text: t.station === "bar" ? "BAR" : "KITCHEN", align: "center", bold: true },
    { text: `#${t.orderNumber} · ${t.label}`, align: "center", bold: true, size: "large" },
    { text: `${when}${t.sentByName ? ` · ${t.sentByName}` : ""}`, align: "center", size: "small" },
    { rule: true },
  );
  for (const l of t.lines) {
    out.push({ text: `${fmtQty(l.qty)} x ${l.name}`, bold: true, size: "large" });
    if (l.extras) out.push({ text: `   ${l.extras}` });
    if (l.note) out.push({ text: `   !! ${l.note}`, bold: true });
  }
  out.push({ rule: true });
  return out;
}

/** Prints a claimed ticket; quietly skips stations without a printer. */
async function printClaim(c: Claim) {
  if (!c.claimed || !c.printer) return;
  try {
    await printReceipt(`ticket-${c.ticket.id}`, ticketLines(c.ticket), false, c.printer);
  } catch (e) {
    toast.error(`Kitchen ticket #${c.ticket.orderNumber} not printed: ${(e as Error).message} It's on the kitchen display.`);
  }
}

/** After a send or payment: print this order's tickets nobody printed yet. */
export async function printNewTickets(d: OrderDetail) {
  for (const t of d.tickets.filter((x) => !x.printedAt)) {
    try { await printClaim(await api<Claim>(`/kitchen/tickets/${t.id}/claim-print`, "POST")); } catch { /* shown on the display anyway */ }
  }
}

export async function reprintTicket(id: string) {
  const c = await api<Claim>(`/kitchen/tickets/${id}/reprint`, "POST");
  if (!c.printer) throw new Error("This station has no printer. Set one under Devices.");
  await printReceipt(`reprint-${id}-${Date.now()}`, ticketLines(c.ticket), false, c.printer);
}
