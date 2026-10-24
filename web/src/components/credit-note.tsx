"use client";

import { printReceiptArea } from "@/lib/browser-print";
import { PrinterIcon } from "lucide-react";
import { toast } from "sonner";
import { api, useApi } from "@/lib/api";
import { fmtIn } from "@/lib/num";
import { printReceipt, type ReceiptLine } from "@/lib/device";
import { fmtQty, METHOD_LABEL, orderNo, type CreditNote } from "@/lib/pos";
import { receiptHead, type Receipt } from "@/components/pos-payment";
import { PrintedLines } from "@/components/printed-lines";
import { AR, METHOD_AR } from "@/lib/receipt-ar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const money = (n: number) => fmtIn(n, 2);

/** A tax credit note as lines for the receipt printer and the screen (UAE VAT: names the original tax invoice, the refund and its VAT). */
export function creditNoteLines(r: Receipt, n: CreditNote): ReceiptLine[] {
  const o = r.detail.order, bi = r.language !== "en";
  const a = (s: string) => (bi ? s : null);
  const out = receiptHead(r, `TAX CREDIT NOTE ${n.number}`, AR.creditNote);
  out.push(
    { text: new Date(n.createdAt).toLocaleString("en-GB"), align: "center", size: "small" },
    { text: `Against tax invoice ${o.invoiceNo ?? orderNo(o)}`, ar: a(AR.against), size: "small" },
    { rule: true },
  );
  if (n.lines.length) for (const l of n.lines) {
    out.push({ text: `${fmtQty(l.qty)} x ${l.name}`, right: `-${money(l.amount)}` });
    if (bi && l.nameAr) out.push({ text: l.nameAr, align: "right", size: "small" });
    if (!l.restock) out.push({ text: "   wastage", size: "small" });
  }
  else out.push({ text: "Refund", ar: a(AR.refund), right: `-${money(n.total)}` });
  out.push(
    { rule: true },
    { text: `VAT ${o.vatRate}% included`, ar: a(AR.vat), right: `-${money(n.vat)}` },
    { text: `TOTAL REFUND ${r.currency}`, ar: a(AR.refundTotal), right: money(n.total), bold: true, size: "large" },
    { text: `Paid back · ${METHOD_LABEL[n.method]}`, ar: a(`${AR.refund} · ${METHOD_AR[n.method]}`), right: money(n.total) },
    ...(n.voucherCode ? [
      { rule: true },
      { text: "STORE CREDIT VOUCHER", ar: a("قسيمة رصيد"), bold: true },
      { text: n.voucherCode, align: "center" as const, bold: true, size: "large" as const },
      { text: `Worth ${r.currency} ${money(n.total)} · use it as payment at any branch`, align: "center" as const, size: "small" as const },
    ] : []),
    { text: `Reason: ${n.reason}`, size: "small" },
  );
  return out;
}

/** Prints a credit note on this till's receipt printer; false when there's no device service (the caller shows the dialog instead). */
export async function printCreditNote(orderId: string, noteId: string): Promise<boolean> {
  const r = await api<Receipt>(`/orders/${orderId}/receipt`);
  const n = r.detail.creditNotes.find((x) => x.id === noteId);
  if (!n) return false;
  try {
    // Printing (or reprinting) never opens the drawer: a cash refund opened it when it was made.
    await printReceipt(`cn-${noteId}`, creditNoteLines(r, n), false);
    return true;
  } catch (e) {
    if ((e as Error).message.includes("isn't running")) return false;
    throw e;
  }
}

/** A credit note on screen (printable: globals.css .print-area). */
export function CreditNoteDialog({ orderId, noteId, onClose }: { orderId: string | null; noteId: string | null; onClose: () => void }) {
  const r = useApi<Receipt>(orderId ? `/orders/${orderId}/receipt` : null);
  const n = r.data?.detail.creditNotes.find((x) => x.id === noteId);
  const o = r.data?.detail.order;
  return (
    <Dialog open={!!orderId && !!noteId} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader><DialogTitle>Credit note{n ? ` · ${n.number}` : ""}</DialogTitle></DialogHeader>
        {!r.data || !n || !o ? <div className="h-72 rounded-xl skeleton-shimmer" /> : (
          <PrintedLines lines={creditNoteLines(r.data, n)} className="max-h-[60vh]" />
        )}
        <DialogFooter>
          <Button variant="outline" className="h-12" disabled={!n} onClick={async () => {
            try { if (!(await printCreditNote(orderId!, noteId!))) printReceiptArea(); else toast.success("Credit note sent to the printer."); }
            catch (e) { toast.error((e as Error).message); }
          }}><PrinterIcon /> Print</Button>
          <Button className="h-12" onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
