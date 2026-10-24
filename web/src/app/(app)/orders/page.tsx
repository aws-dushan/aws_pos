"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArmchairIcon, BikeIcon, MinusIcon, PlusIcon, ReceiptTextIcon, RotateCcwIcon, ShoppingBagIcon } from "lucide-react";
import { openDrawerForCash } from "@/lib/device";
import { toast } from "sonner";
import { api, newKey, useApi } from "@/lib/api";
import { cn } from "@/lib/utils";
import { fmtIn } from "@/lib/num";
import { fmtQty, METHOD_LABEL, orderLabel, TYPE_LABEL, type Order, type OrderDetail, type OrderStatus, type PayMethod, orderNo } from "@/lib/pos";
import { CreditNoteDialog, printCreditNote } from "@/components/credit-note";
import { useSession } from "@/components/session";
import { useLiveEvent } from "@/components/live";
import { EmptyState, ErrorNote, LoadingRows, ObjectStatus, PageHeader, Segmented, TablePanel, TONE } from "@/components/kit";
import { Numpad } from "@/components/numpad";
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
                    {branch?.returnsEnabled && (o.status === "paid" || o.status === "refunded") && o.paid > o.refunded && can("pos.sell") && (
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
      <ReturnDialog order={refund} currency={cur} onClose={() => setRefund(null)} onDone={(orderId, noteId) => {
        setRefund(null); list.reload();
        // The credit note prints on this till; without the device service it opens on screen to print from the browser.
        printCreditNote(orderId, noteId).then((printed) => { if (!printed) setNote({ orderId, noteId }); }).catch((e: Error) => { toast.error(e.message); setNote({ orderId, noteId }); });
      }} />
      <CreditNoteDialog orderId={note?.orderId ?? null} noteId={note?.noteId ?? null} onClose={() => setNote(null)} />
    </div>
  );
}

const REASONS = ["Wrong order", "Food quality", "Cold food", "Long wait", "Customer changed mind", "Charged twice"];

/**
 * A return (REQ PAY-04): items back (quantities, back to stock or wastage — the refund is each item's share of what was paid) or an
 * amount only; how the money goes back (the way they paid, by default); a reason. Every refund is a numbered tax credit note.
 */
function ReturnDialog({ order, currency, onClose, onDone }: { order: Order | null; currency: string; onClose: () => void; onDone: (orderId: string, noteId: string) => void }) {
  const detail = useApi<OrderDetail>(order ? `/orders/${order.id}` : null);
  const d = detail.data;
  const left = order ? order.paid - order.refunded : 0;
  const [mode, setMode] = useState<"items" | "amount">("items");
  const [qty, setQty] = useState<Record<string, number>>({});
  const [restock, setRestock] = useState<Record<string, boolean>>({});
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<PayMethod>("cash");
  const [reason, setReason] = useState("");
  const [seen, setSeen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { company } = useSession();
  // Store credit (a new voucher) and points only where the company uses them; points need the order's customer.
  const methods: PayMethod[] = ["cash", "card", "other", ...(company?.vouchersEnabled ? ["voucher" as const] : []), ...(company?.loyaltyEnabled && d?.order.customerId ? ["points" as const] : []), ...(d?.order.platformId ? ["platform" as const] : [])];
  if ((order?.id ?? null) !== seen) { setSeen(order?.id ?? null); setQty({}); setRestock({}); setAmount(""); setReason(""); setMode("items"); }
  // The money goes back the way they paid, by default (the biggest payment's method).
  const [methodSet, setMethodSet] = useState<string | null>(null);
  if (d && methodSet !== d.order.id) {
    setMethodSet(d.order.id);
    const pays = d.payments.filter((p) => p.kind === "payment").sort((a, b) => b.amount - a.amount);
    if (pays[0] && ["cash", "card", "other"].includes(pays[0].method)) setMethod(pays[0].method);
  }

  const lines = (d?.lines ?? []).filter((l) => !l.isVoid && l.qty - l.returnedQty > 0);
  const subtotal = (d?.lines ?? []).filter((l) => !l.isVoid).reduce((t, l) => t + l.lineTotal, 0);
  const estimate = d && subtotal > 0
    ? Math.min(left, lines.reduce((t, l) => t + d.order.total * (l.lineTotal * (qty[l.id] ?? 0) / l.qty) / subtotal, 0)) : 0;
  const value = mode === "items" ? Math.round(estimate * 100) / 100 : Number(amount || 0);
  const items = lines.reduce((n, l) => n + (qty[l.id] ?? 0), 0);

  async function go() {
    if (!order) return;
    setBusy(true);
    try {
      const r = mode === "items"
        ? await api<OrderDetail>(`/orders/${order.id}/return`, "POST", {
          lines: Object.entries(qty).filter(([, n]) => n > 0).map(([lineId, n]) => ({ lineId, qty: n, restock: restock[lineId] ?? false })), method, reason,
        }, { key: newKey() })
        : await api<OrderDetail>(`/orders/${order.id}/refund`, "POST", { amount: value, method, reason }, { key: newKey() });
      const note = r.creditNotes.at(-1)!;
      // Cash back to the customer: the drawer opens now.
      if (note.method === "cash") void openDrawerForCash();
      toast.success(`Credit note ${note.number}: ${currency} ${money(note.total)} ${note.voucherCode ? ` as voucher ${note.voucherCode}` : ` back by ${METHOD_LABEL[method].toLowerCase()}`}.`);
      onDone(order.id, note.id);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={!!order} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[calc(100dvh-1rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Return · {order?.invoiceNo ?? (order ? orderNo(order) : "")} {order ? orderLabel(order) : ""}</DialogTitle>
          <DialogDescription>Up to {currency} {money(left)} can go back. A tax credit note is made and printed.</DialogDescription>
        </DialogHeader>
        <Segmented id="return-mode" value={mode} onChange={setMode} className="w-full"
          options={[{ value: "items", label: "Return items" }, { value: "amount", label: "Amount only" }]} />
        {mode === "items" ? (
          <div className="divide-y rounded-xl border">
            {!d ? <div className="h-32 skeleton-shimmer" /> : lines.length ? lines.map((l) => {
              const n = qty[l.id] ?? 0;
              const avail = l.qty - l.returnedQty;
              return (
                <div key={l.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{l.name}</div>
                    <div className="text-xs text-muted-foreground">{fmtQty(avail)} of {fmtQty(l.qty)} can come back{l.returnedQty ? ` · ${fmtQty(l.returnedQty)} returned before` : ""}</div>
                  </div>
                  {n > 0 && (
                    <Segmented id={`restock-${l.id}`} size="sm" value={restock[l.id] ? "stock" : "waste"} onChange={(v) => setRestock({ ...restock, [l.id]: v === "stock" })}
                      options={[{ value: "waste", label: "Wastage" }, { value: "stock", label: "Back to stock" }]} />
                  )}
                  <div className="flex h-11 items-center rounded-xl border bg-card">
                    <button type="button" aria-label="Fewer" className="flex size-11 items-center justify-center text-muted-foreground" onClick={() => setQty({ ...qty, [l.id]: Math.max(0, n - 1) })}><MinusIcon className="size-4" /></button>
                    <span className={cn("w-7 text-center font-heading font-semibold tabular-nums", n > 0 && "text-primary")}>{n}</span>
                    <button type="button" aria-label="More" className="flex size-11 items-center justify-center text-muted-foreground" onClick={() => setQty({ ...qty, [l.id]: Math.min(avail, n + 1) })}><PlusIcon className="size-4" /></button>
                  </div>
                </div>
              );
            }) : <p className="p-4 text-sm text-muted-foreground">Everything on this order was returned already.</p>}
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-[1fr_240px]">
            <p className="text-sm text-muted-foreground">For a goodwill refund or an overcharge, without items coming back. Its VAT is worked out in proportion.</p>
            <div className="space-y-3">
              <div className="flex h-14 items-center justify-end rounded-xl border bg-muted/40 px-4 font-heading text-3xl font-semibold tabular-nums">
                <span className="mr-auto text-sm font-medium text-muted-foreground">{currency}</span>{amount || "0"}
              </div>
              <Numpad value={amount} onChange={setAmount}
                onEnter={() => { if (!busy && value && value <= left + 0.004 && reason.trim()) void go(); }} />
            </div>
          </div>
        )}
        <div className="space-y-2">
          <div className="text-[0.8rem] font-medium text-foreground/80">Money goes back by</div>
          <Segmented id="return-method" value={method} onChange={setMethod} className="w-full" options={methods.map((m) => ({ value: m, label: m === "voucher" ? "Store credit" : METHOD_LABEL[m] }))} />
          {method === "voucher" && <p className="text-xs text-muted-foreground">A new voucher for the amount; its code prints on the credit note and pays at any branch.</p>}
          {method === "points" && <p className="text-xs text-muted-foreground">The amount goes back to the customer as loyalty points.</p>}
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
          <Button className="h-12 min-w-52 bg-danger text-white hover:bg-danger/90" disabled={busy || !value || value > left + 0.004 || !reason.trim() || (mode === "items" && !items)} onClick={go}>
            <RotateCcwIcon /> {mode === "items" ? `Return ${items} item${items === 1 ? "" : "s"} · ` : "Refund "}{currency} {money(value)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
