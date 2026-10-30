"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArmchairIcon, BikeIcon, ReceiptTextIcon, RotateCcwIcon, ShoppingBagIcon } from "lucide-react";
import { openDrawerForCash } from "@/lib/device";
import { toast } from "sonner";
import { api, newKey, useApi } from "@/lib/api";
import { cn } from "@/lib/utils";
import { fmtIn } from "@/lib/num";
import { cardLabel, fmtQty, METHOD_LABEL, orderLabel, TYPE_LABEL, type Order, type OrderDetail, type OrderStatus, orderNo } from "@/lib/pos";
import { CreditNoteDialog } from "@/components/credit-note";
import { useSession } from "@/components/session";
import { useLiveEvent } from "@/components/live";
import { EmptyState, ErrorNote, LoadingRows, ObjectStatus, PageHeader, Segmented, TablePanel, TONE } from "@/components/kit";
import { ReceiptDialog } from "@/components/pos-payment";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const money = (n: number) => fmtIn(n, 2);
type Filter = "open" | "paid" | "void" | "refunded" | "all";
const STATUS: Record<OrderStatus, { label: string; tone: string }> = {
  open: { label: "Open", tone: TONE.open }, paid: { label: "Paid", tone: TONE.done }, void: { label: "Void", tone: TONE.struck }, refunded: { label: "Refunded", tone: TONE.violet },
  merged: { label: "Merged", tone: TONE.muted },
};

/** The branch's orders of a day (REQ ORD-01, ORD-02): open ones go back to the register; closed ones show the receipt and can be refunded. */
export default function OrdersPage() {
  return <Suspense fallback={null}><Orders /></Suspense>;
}

function Orders() {
  const router = useRouter();
  // ?receipt=<order>: opened from "Receipt" on the paid message at the register.
  const params = useSearchParams();
  const { company, branch, can } = useSession();
  const [filter, setFilter] = useState<Filter>("all");
  const [date, setDate] = useState("");
  const [q, setQ] = useState("");
  const list = useApi<{ date: string; orders: Order[] }>(`/orders?status=${filter}${date ? `&date=${date}` : ""}${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ""}`);
  useLiveEvent(["order.changed"], () => list.reload());
  const [receipt, setReceipt] = useState<string | null>(() => params.get("receipt"));
  const [refund, setRefund] = useState<Order | null>(null);
  const [note, setNote] = useState<{ orderId: string; noteId: string } | null>(null);
  const cur = company?.currency ?? "AED";
  const rows = list.data?.orders ?? [];
  const total = rows.filter((o) => o.status === "paid" || o.status === "refunded").reduce((t, o) => t + o.total - o.refunded, 0);

  return (
    <div>
      <PageHeader title="Orders" icon={ReceiptTextIcon} module="bank" count={rows.length}
        description={list.data ? `${new Date(list.data.date + "T00:00:00").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })} · sales ${cur} ${money(total)}` : "Today"} />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Segmented id="order-filter" value={filter} onChange={setFilter}
          options={[{ value: "all", label: "All" }, { value: "open", label: "Open" }, { value: "paid", label: "Paid" }, { value: "refunded", label: "Refunded" }, { value: "void", label: "Voided" }]} />
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Business date"
          className="h-10 rounded-xl border bg-card px-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/40 dark:bg-input/30" />
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Number, table, name or phone"
          className="h-10 min-w-56 flex-1 rounded-xl border bg-card px-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/40 sm:max-w-xs dark:bg-input/30" />
      </div>
      <ErrorNote message={list.error} />
      {list.loading && !list.data ? <LoadingRows /> : rows.length ? (
        <TablePanel>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-5">Order</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="text-right">Items</TableHead>
                <TableHead>Time</TableHead>
                <TableHead>Till · cashier</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="pr-5" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((o) => (
                <TableRow key={o.id} className="h-14 cursor-pointer" onClick={() => (o.status === "open" ? router.push(`/register?order=${o.id}`) : setReceipt(o.id))}>
                  <TableCell className="pl-5">
                    <span className="font-mono text-xs text-muted-foreground">{orderNo(o)}</span> <span className="font-medium">{orderLabel(o)}</span>
                    {o.invoiceNo && <div className="font-mono text-[0.7rem] text-muted-foreground">{o.invoiceNo}</div>}
                  </TableCell>
                  <TableCell>
                    <span className="inline-flex items-center gap-1.5 text-sm">
                      {o.orderType === "dine_in" ? <ArmchairIcon className="size-4 text-mod-sales" /> : o.orderType === "delivery" ? <BikeIcon className="size-4 text-mod-bank" /> : <ShoppingBagIcon className="size-4 text-primary" />}
                      {TYPE_LABEL[o.orderType]}
                    </span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{o.items}</TableCell>
                  <TableCell className="tabular-nums">{new Date(o.openedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{o.registerName ?? "Back office"} · {o.openedByName}</TableCell>
                  <TableCell className="text-right font-medium tabular-nums">
                    {money(o.total)}{o.refunded > 0 && <div className="text-xs font-normal text-violet-600">−{money(o.refunded)} refunded</div>}
                  </TableCell>
                  <TableCell><ObjectStatus className={STATUS[o.status].tone}>{STATUS[o.status].label}</ObjectStatus></TableCell>
                  <TableCell className="pr-5 text-right">
                    {branch?.returnsEnabled && o.status === "paid" && o.paid > 0 && o.refunded === 0 && can("pos.sell") && (
                      <Button variant="outline" className="h-10" onClick={(e) => { e.stopPropagation(); setRefund(o); }}><RotateCcwIcon /> Return</Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TablePanel>
      ) : <EmptyState icon={ReceiptTextIcon} title="No orders here" module="bank">Orders appear as they are taken at the register.</EmptyState>}
      <ReceiptDialog orderId={receipt} onClose={() => setReceipt(null)} />
      <ReturnDialog order={refund} currency={cur} onClose={() => setRefund(null)} onDone={(orderId, noteId, message) => {
        setRefund(null); list.reload();
        // Not printed by itself: the credit note opens from the message to print when wanted.
        toast.success(message, { action: { label: "Credit note", onClick: () => setNote({ orderId, noteId }) } });
      }} />
      <CreditNoteDialog orderId={note?.orderId ?? null} noteId={note?.noteId ?? null} onClose={() => setNote(null)} />
    </div>
  );
}

const REASONS = ["Wrong payment method", "Wrong item", "Wrong quantity", "Wrong price", "Wrong customer", "Food quality", "Customer changed mind", "Charged twice"];

/**
 * Return (REQ PAY-04): the whole bill comes back, each payment refunded the way it was paid, the items back on stock, with a reason.
 * It's a numbered tax credit note (and, where the company posts returns, a PSR51 in FACTS). A mistake is put right by ringing up
 * the bill again.
 */
function ReturnDialog({ order, currency, onClose, onDone }: { order: Order | null; currency: string; onClose: () => void; onDone: (orderId: string, noteId: string, message: string) => void }) {
  const detail = useApi<OrderDetail>(order ? `/orders/${order.id}` : null);
  const d = detail.data;
  const [reason, setReason] = useState("");
  const [seen, setSeen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if ((order?.id ?? null) !== seen) { setSeen(order?.id ?? null); setReason(""); }
  const pays = (d?.payments ?? []).filter((p) => p.kind === "payment");
  const lines = (d?.lines ?? []).filter((l) => !l.isVoid && l.qty - l.returnedQty > 0);
  const amount = order?.paid ?? 0;

  async function go() {
    if (!order) return;
    setBusy(true);
    try {
      const r = await api<OrderDetail>(`/orders/${order.id}/return-bill`, "POST", { reason }, { key: newKey() });
      const note = r.creditNotes.at(-1)!;
      // Cash back to the customer: the drawer opens now.
      if (pays.some((p) => p.method === "cash")) void openDrawerForCash();
      onDone(order.id, note.id, `Credit note ${note.number}: ${currency} ${money(note.total)} back the way it was paid.`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={!!order} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[calc(100dvh-1rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Return · {order?.invoiceNo ?? (order ? orderNo(order) : "")} {order ? orderLabel(order) : ""}</DialogTitle>
          <DialogDescription>The whole bill comes back and the items go back on stock. A tax credit note is made (print it from the message if needed).</DialogDescription>
        </DialogHeader>
        <div className="divide-y rounded-xl border text-sm">
          {!d ? <div className="h-24 skeleton-shimmer" /> : (
            <>
              {lines.map((l) => (
                <div key={l.id} className="flex items-center gap-3 px-3 py-2">
                  <span className="w-10 tabular-nums text-muted-foreground">{fmtQty(l.qty - l.returnedQty)} ×</span>
                  <span className="min-w-0 flex-1 truncate">{l.name}</span>
                </div>
              ))}
              {pays.map((p) => (
                <div key={p.id} className="flex items-center justify-between gap-3 bg-muted/40 px-3 py-2">
                  <span>Back by {p.method === "card" ? cardLabel(p.cardType) ?? "Card" : METHOD_LABEL[p.method] ?? p.method}</span>
                  <span className="font-medium tabular-nums">{currency} {money(p.amount)}</span>
                </div>
              ))}
            </>
          )}
        </div>
        <div>
          <div className="mb-2 text-[0.8rem] font-medium text-foreground/80">Reason</div>
          <div className="flex flex-wrap gap-2">
            {REASONS.map((r) => (
              <button key={r} type="button" onClick={() => setReason(r)} aria-pressed={reason === r}
                className={cn("h-11 rounded-xl border px-3.5 text-sm transition-[background-color,transform] active:scale-[0.97]", reason === r ? "border-primary bg-primary/10 font-medium text-primary" : "bg-card hover:bg-muted")}>{r}</button>
            ))}
          </div>
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Or type the reason"
            className="mt-2 h-11 w-full rounded-xl border bg-card px-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/40" />
        </div>
        <DialogFooter>
          <Button variant="outline" className="h-12" onClick={onClose}>Cancel</Button>
          <Button className="h-12 min-w-52 bg-danger text-white hover:bg-danger/90" disabled={busy || !d || !reason.trim()} onClick={go}>
            <RotateCcwIcon /> Return {currency} {money(amount)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
