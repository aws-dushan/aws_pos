"use client";

import { useRef, useState } from "react";
import { BanknoteIcon, CreditCardIcon, PrinterIcon, WalletCardsIcon } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { parseNum, roundTo } from "@/lib/num";
import { PosError, usePos, usePosState } from "@/prototype/store";
import { money, orderTotals } from "@/prototype/totals";
import { Segmented } from "@/components/kit";
import { celebrate } from "@/components/motion";
import { BRAND } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { Order, PayMethod } from "@/prototype/types";

const METHODS: { value: PayMethod; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { value: "cash", label: "Cash", icon: BanknoteIcon },
  { value: "card", label: "Card", icon: CreditCardIcon },
  { value: "other", label: "Other", icon: WalletCardsIcon },
];

/** Cash notes a guest is likely to hand over for `due` (the next round amounts above it). */
function tenderSuggestions(due: number): number[] {
  const out = new Set<number>([roundTo(due, 2)]);
  for (const step of [5, 10, 50, 100, 200, 500]) {
    const v = Math.ceil(due / step) * step;
    if (v > due) out.add(v);
  }
  return [...out].sort((a, b) => a - b).slice(0, 5);
}

/**
 * Takes payment for an order: cash (with change), card or other; a smaller amount is a part payment
 * (split bill) and the dialog stays open for the rest. When the order is paid in full: AWS One's
 * success check-mark with confetti, then the receipt.
 */
export function PaymentDialog({ order, open, onOpenChange, onPaid }: {
  order: Order | null; open: boolean; onOpenChange: (o: boolean) => void; onPaid: (order: Order) => void;
}) {
  const s = usePosState();
  const pos = usePos();
  const cur = s.settings.currency;
  const t = order ? orderTotals(order, s.settings) : null;
  const [method, setMethod] = useState<PayMethod>("cash");
  const [amount, setAmount] = useState("");
  const [seenFor, setSeenFor] = useState<string | null>(null);
  const payRef = useRef<HTMLButtonElement>(null);
  const key = order && open ? `${order.id}:${t?.due}` : null;
  if (key !== seenFor) { setSeenFor(key); setAmount(t ? t.due.toFixed(2) : ""); setMethod("cash"); }
  if (!order || !t) return null;

  const value = parseNum(amount);
  const valid = value > 0;
  const tendered = method === "cash" ? value : Math.min(value, t.due);
  const charge = Math.min(tendered, t.due);
  const change = method === "cash" ? Math.max(0, roundTo(value - t.due, 2)) : 0;
  const part = charge < t.due - 0.004;

  function pay() {
    if (!order || !t || !valid) return;
    try {
      pos.pay(order.id, [{ method, amount: roundTo(charge, 2), tendered: method === "cash" ? value : undefined }], t.total);
    } catch (e) {
      if (e instanceof PosError) return toast.error(e.message);
      throw e;
    }
    if (part) {
      toast.success(`${cur} ${money(charge)} taken by ${method}. ${cur} ${money(t.due - charge)} left to pay.`);
      return;
    }
    celebrate(payRef.current);
    toast.success(change > 0 ? `Paid. Change due: ${cur} ${money(change)}` : `Order #${order.number} paid`);
    onPaid(order);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Take payment · #{order.number}</DialogTitle>
        </DialogHeader>
        <div className="rounded-2xl p-5 text-white shadow-lift" style={{ background: "var(--hero)" }}>
          <div className="text-xs text-white/70">{t.paid > 0 ? "Left to pay" : "Amount due"}</div>
          <div className="mt-1 flex items-baseline gap-1.5 font-heading text-4xl font-semibold tracking-tight tabular-nums">
            <span className="text-base font-medium opacity-60">{cur}</span>{money(t.due)}
          </div>
          {t.paid > 0 && <div className="mt-1 text-xs text-white/70">{cur} {money(t.paid)} of {money(t.total)} already paid</div>}
        </div>

        <Segmented id="pay-method" value={method} onChange={setMethod} options={METHODS} className="w-full" />

        <label className="block space-y-1.5">
          <span className="block text-[0.8rem] font-medium text-foreground/80">{method === "cash" ? "Cash received" : "Amount"}</span>
          <div className="relative">
            <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm text-muted-foreground">{cur}</span>
            <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" autoFocus
              onKeyDown={(e) => { if (e.key === "Enter") pay(); }}
              className="h-12 w-full rounded-xl border border-input bg-card pr-3 pl-14 text-right font-heading text-2xl font-semibold tabular-nums outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40 dark:bg-input/30" />
          </div>
        </label>

        {method === "cash" && (
          <div className="flex flex-wrap gap-1.5">
            {tenderSuggestions(t.due).map((v, i) => (
              <Button key={v} variant={value === v ? "default" : "outline"} size="lg" className="flex-1 tabular-nums" onClick={() => setAmount(v.toFixed(2))}>
                {i === 0 ? "Exact" : money(v)}
              </Button>
            ))}
          </div>
        )}
        {method !== "cash" && (
          <div className="flex gap-1.5">
            {[2, 3, 4].map((n) => (
              <Button key={n} variant="outline" size="lg" className="flex-1" onClick={() => setAmount(roundTo(t.due / n, 2).toFixed(2))}>Split ÷{n}</Button>
            ))}
          </div>
        )}

        <div className={cn("flex items-center justify-between rounded-xl px-4 py-3 text-sm transition-colors", change > 0 ? "bg-success/10 text-success" : part && valid ? "bg-warning/10 text-warning" : "bg-muted text-muted-foreground")}>
          <span className="font-medium">{change > 0 ? "Change to give" : part && valid ? "Part payment, the rest stays open" : "No change"}</span>
          <span className="font-heading text-lg font-semibold tabular-nums">{change > 0 ? `${cur} ${money(change)}` : part && valid ? `${cur} ${money(t.due - charge)} left` : ""}</span>
        </div>

        <DialogFooter>
          <Button variant="outline" size="lg" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button ref={payRef} size="lg" disabled={!valid} onClick={pay} className="min-w-40">
            {part ? `Take ${cur} ${money(charge)}` : `Pay ${cur} ${money(t.due)}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A printable receipt (only it prints: globals.css .print-area). */
export function ReceiptDialog({ orderId, onClose }: { orderId: string | null; onClose: () => void }) {
  const s = usePosState();
  const order = orderId ? s.orders.find((o) => o.id === orderId) : undefined;
  if (!order) return null;
  const t = orderTotals(order, s.settings);
  const cur = s.settings.currency;
  const table = order.tableId ? s.tables.find((x) => x.id === order.tableId) : undefined;
  const row = (label: string, v: string, strong?: boolean) => (
    <div className={cn("flex justify-between", strong && "border-t border-dashed pt-1.5 font-heading text-base font-semibold")}><span>{label}</span><span className="tabular-nums">{v}</span></div>
  );
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader><DialogTitle>Receipt · #{order.number}</DialogTitle></DialogHeader>
        <div className="print-area rounded-xl border bg-white p-5 font-mono text-[0.78rem] leading-relaxed text-neutral-900">
          <div className="text-center">
            <div className="font-sans text-base font-bold">{s.settings.restaurantName}</div>
            <div>{s.settings.outletCode} · Tax invoice</div>
            <div>{new Date(order.paidAt ?? order.createdAt).toLocaleString("en-GB")}</div>
            <div>Order #{order.number} · {table ? `Table ${table.name}` : order.type === "delivery" ? "Delivery" : "Takeaway"}{order.guests ? ` · ${order.guests} guests` : ""}</div>
          </div>
          <div className="my-3 border-t border-dashed" />
          {order.lines.map((l) => (
            <div key={l.id}>
              <div className="flex justify-between gap-3"><span>{l.qty} × {l.name}</span><span className="tabular-nums">{money(l.qty * l.price)}</span></div>
              {l.note && <div className="pl-4 text-neutral-500">– {l.note}</div>}
            </div>
          ))}
          <div className="my-3 border-t border-dashed" />
          <div className="space-y-0.5">
            {row("Subtotal", money(t.subtotal))}
            {t.discount > 0 && row(`Discount ${order.discountPct}%`, `-${money(t.discount)}`)}
            {t.service > 0 && row(`Service charge ${s.settings.serviceChargeRate}%`, money(t.service))}
            {row(`VAT ${s.settings.vatRate}%${s.settings.vatInclusive ? " (incl.)" : ""}`, money(t.vat))}
            {row(`Total ${cur}`, money(t.total), true)}
            {order.payments.map((p) => (
              <div key={p.id}>
                {row(`Paid · ${p.method}`, money(p.tendered ?? p.amount))}
                {p.tendered !== undefined && p.tendered > p.amount && row("Change", money(p.tendered - p.amount))}
              </div>
            ))}
          </div>
          <div className="mt-4 text-center text-neutral-500">Thank you · {BRAND}</div>
        </div>
        <DialogFooter>
          <Button variant="outline" size="lg" onClick={() => window.print()}><PrinterIcon /> Print</Button>
          <Button size="lg" onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
