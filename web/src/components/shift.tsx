"use client";

import { useState } from "react";
import { ArrowDownToLineIcon, ArrowUpFromLineIcon, LandmarkIcon, PrinterIcon, VaultIcon } from "lucide-react";
import { toast } from "sonner";
import { api, newKey } from "@/lib/api";
import { cn } from "@/lib/utils";
import { fmtIn } from "@/lib/num";
import { openDrawerForCash, printReceipt, type ReceiptLine } from "@/lib/device";
import { cardLabel, METHOD_LABEL, TYPE_LABEL, type OrderType, type PayMethod } from "@/lib/pos";
import { Numpad } from "@/components/numpad";
import { Segmented } from "@/components/kit";
import { useSession } from "@/components/session";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

/*
 * Shifts on the till (REQ DAY-03 … DAY-06): the opening float counted by denomination, cash in / out / safe drops, the X report
 * while open, and the blind closing count (the cashier doesn't see what's expected until it's counted).
 */

const money = (n: number) => fmtIn(n, 2);

export type DayRow = { id: string; date: string; status: "open" | "closed"; openedAt: string; openedByName: string | null; closedAt: string | null; closedByName: string | null; reopened: number };
export type ShiftStatus = "open" | "closed" | "needs_approval" | "not_counted";
export type ShiftRow = {
  id: string; registerId: string; registerName: string; userId: string; userName: string; status: ShiftStatus; openedAt: string; openingFloat: number;
  floatExpected: number; closedAt: string | null; expectedCash: number | null; countedCash: number | null; variance: number | null; note: string | null; approvedByName: string | null;
  /** The till's drawer is shared: several cashiers work in this shift. */
  sharedDrawer?: boolean;
};
/** A cash movement in a shift: in, out, a drop to the safe, or a bank deposit straight from the drawer. */
export type MoveKind = "in" | "out" | "drop" | "deposit";
export type ShiftReport = {
  kind: "X" | "Z"; shift: ShiftRow; expected: number; orders: number;
  cash: { openingFloat: number; cashSales: number; cashRefunds: number; cashIn: number; cashOut: number; drops: number; deposits?: number; expected: number };
  payments: PayLine[];
  /** Orders paid in the shift by type, each delivery platform apart (reports from before it have none). */
  byType?: TypeLine[];
  movements: { kind: MoveKind; amount: number; reason: string; at: string }[];
  /** Who took what (payments less refunds given): several names on a shared drawer. */
  byCashier?: { name: string; cash: number; total: number; payments: number }[];
};
export type DayReport = {
  date: string; status: string; netSales: number; variance: number; depositTotal: number;
  sales: { orders: number; gross: number; net: number; vat: number; discounts: number; serviceCharge: number; guests: number };
  refunds: { count: number; total: number; vat: number };
  byType: TypeLine[];
  payments: PayLine[];
  voids: { count: number; value: number };
  shifts: { id: string; registerName: string; userName: string; status: ShiftStatus; openingFloat: number; expectedCash: number | null; countedCash: number | null; variance: number | null }[];
  /** `fromRegister`: taken straight from that drawer during a shift; none: from the safe. */
  deposits: { amount: number; bagNo: string | null; takenBy: string; at: string; fromRegister?: string | null }[];
  /** The day's cash over all its shifts (older stored Z reports don't have it). */
  cash?: {
    openingFloat: number; cashSales: number; cashRefunds: number; cashIn: number; cashOut: number; drops: number; deposits?: number; expected: number; counted: number; uncounted: number;
    /** Taken out (positive) or put in between shifts on the same till: the last count less the next float (reports since 25 Oct). */
    shiftChange?: number;
    movements: { kind: MoveKind; amount: number; reason: string; register: string | null; by: string | null; at: string }[];
  };
  openOrders: { count: number; value: number };
  wastage?: { count: number; value: number };
  /** Items given away for marketing (posted in FACTS as an MCV50 once approved). */
  marketing?: { count: number; value: number };
  noSales?: number;
};
export type DayInfo = {
  dayControl: "manual" | "automatic" | "cashier"; defaultFloat: number; tolerance: number; openOrdersAtClose: "carry" | "void_unsent"; autoOpen: string; autoClose: string;
  day: DayRow | null; shifts: ShiftRow[]; pending: ShiftRow[]; myShiftId: string | null; registerId: string | null; report: DayReport | null;
  recent: (DayRow & { z: DayReport | null })[]; canManage: boolean; canReopen: boolean; canDeposit: boolean;
  /** Automatic close: when the day closes (with any delay); closingAt: the countdown is on and ends then. */
  closesAt: string | null; closingAt: string | null; delayedMinutes: number; canDelay: boolean; delayStep: number;
};

export const SHIFT_STATUS: Record<ShiftStatus, string> = { open: "Open", closed: "Closed", needs_approval: "Needs approval", not_counted: "Not counted" };

/** UAE dirham notes and coins, largest first. */
const DENOMS = [1000, 500, 200, 100, 50, 20, 10, 5, 1, 0.5, 0.25];
type Counts = Record<string, number>;
const countTotal = (c: Counts) => Math.round(DENOMS.reduce((t, d) => t + d * (c[String(d)] ?? 0), 0) * 100) / 100;

/** Counting the drawer by denomination: tap a note or coin, type how many on the pad. The total adds up as you go. */
function CashCount({ counts, onChange, currency, onLast }: { counts: Counts; onChange: (c: Counts) => void; currency: string; onLast?: () => void }) {
  const [sel, setSel] = useState("100");
  const typed = counts[sel] ? String(counts[sel]) : "";
  return (
    <div className="grid gap-4 sm:grid-cols-[1fr_15rem]">
      <div className="grid grid-cols-3 gap-2 content-start">
        {DENOMS.map((d) => {
          const k = String(d), n = counts[k] ?? 0, on = sel === k;
          return (
            <button key={k} type="button" onClick={() => setSel(k)}
              className={cn("flex h-16 flex-col items-start justify-center rounded-xl border px-3 text-left transition-[transform,background-color] active:scale-[0.96]",
                on ? "border-primary bg-primary/8 ring-2 ring-primary/30" : "bg-card hover:bg-muted")}>
              <span className="font-heading text-[0.95rem] font-semibold">{d >= 1 ? d : d.toFixed(2)}{d >= 5 ? "" : " coin"}</span>
              <span className={cn("text-xs tabular-nums", n ? "text-foreground" : "text-muted-foreground")}>{n ? `× ${n} = ${money(n * d)}` : "—"}</span>
            </button>
          );
        })}
      </div>
      <div className="flex flex-col gap-3">
        <div className="rounded-xl border bg-muted/50 px-4 py-3">
          <div className="text-xs text-muted-foreground">How many of {Number(sel) >= 1 ? sel : Number(sel).toFixed(2)}?</div>
          <div className="font-heading text-2xl font-semibold tabular-nums">{typed || "0"}</div>
        </div>
        <Numpad value={typed} decimals={0} max={4} onChange={(v) => onChange({ ...counts, [sel]: Number(v || 0) })}
          onEnter={() => { const i = DENOMS.findIndex((d) => String(d) === sel); if (i < DENOMS.length - 1) setSel(String(DENOMS[i + 1])); else onLast?.(); }} />
        <div className="flex items-baseline justify-between border-t pt-3">
          <span className="font-medium">Total</span>
          <span className="font-heading text-2xl font-semibold tabular-nums"><span className="mr-1 text-xs text-muted-foreground">{currency}</span>{money(countTotal(counts))}</span>
        </div>
      </div>
    </div>
  );
}

/** Opening a shift on this till: count the float. A difference to the branch's usual float is fine but recorded. */
export function OpenShiftDialog({ open, defaultFloat, currency, onClose, onDone }: {
  open: boolean; defaultFloat: number; currency: string; onClose: () => void; onDone: () => void;
}) {
  const [counts, setCounts] = useState<Counts>({});
  const [busy, setBusy] = useState(false);
  const total = countTotal(counts);
  async function submit() {
    setBusy(true);
    try {
      await api("/shifts/open", "POST", { openingFloat: total, counts });
      toast.success("Shift open");
      setCounts({});
      onDone();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Open your shift</DialogTitle>
          <DialogDescription>Count the float in the drawer. The usual float here is {currency} {money(defaultFloat)}.</DialogDescription>
        </DialogHeader>
        <CashCount counts={counts} onChange={setCounts} currency={currency} onLast={() => { if (!busy && total > 0) void submit(); }} />
        {total > 0 && total !== defaultFloat && (
          <p className="rounded-lg bg-warning/10 px-3 py-2 text-sm text-warning">{total > defaultFloat ? "More" : "Less"} than the usual float by {money(Math.abs(total - defaultFloat))}. It will be noted.</p>
        )}
        <DialogFooter>
          <Button variant="outline" className="h-12" onClick={onClose}>Not now</Button>
          <Button className="h-12 min-w-40" disabled={busy || total <= 0} onClick={() => void submit()}>Open shift · {money(total)}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const MOVE_REASONS = { in: ["Change from the safe", "Float top-up"], out: ["Supplier paid", "Petty cash", "Staff advance"], drop: ["Safe drop"] };

/** Cash put in, taken out, dropped to the safe, or taken to the bank during the shift. */
export function CashMoveDialog({ shiftId, currency, onClose, onDone }: { shiftId: string | null; currency: string; onClose: () => void; onDone: () => void }) {
  const { can, me } = useSession();
  const canDeposit = can("day.deposit") || can("day.manage");
  const [kind, setKind] = useState<"in" | "out" | "drop" | "deposit">("drop");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [bagNo, setBagNo] = useState("");
  const [takenBy, setTakenBy] = useState("");
  const [busy, setBusy] = useState(false);
  const deposit = kind === "deposit";
  const ready = Number(amount) > 0 && (deposit ? takenBy.trim() : reason.trim());
  async function submit() {
    setBusy(true);
    try {
      if (deposit) await api(`/shifts/${shiftId}/deposit`, "POST", { amount: Number(amount), bagNo: bagNo || null, takenBy: takenBy.trim() });
      else await api(`/shifts/${shiftId}/cash`, "POST", { kind, amount: Number(amount), reason });
      // Money goes into or out of the drawer, so it opens.
      void openDrawerForCash();
      toast.success(kind === "in" ? "Cash in recorded" : kind === "out" ? "Cash out recorded" : deposit ? "Bank deposit recorded" : "Safe drop recorded");
      setAmount(""); setReason(""); setBagNo(""); setTakenBy("");
      onDone();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Dialog open={!!shiftId} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>Cash in or out</DialogTitle><DialogDescription>Every movement is counted in the shift and shows in its report.</DialogDescription></DialogHeader>
        <Segmented id="cash-kind" value={kind} onChange={(k) => { setKind(k); setReason(""); if (k === "deposit" && !takenBy) setTakenBy(me.user.displayName); }} className="w-full"
          options={[{ value: "drop", label: "Safe drop", icon: VaultIcon }, { value: "in", label: "Cash in", icon: ArrowDownToLineIcon }, { value: "out", label: "Cash out", icon: ArrowUpFromLineIcon },
            ...(canDeposit ? [{ value: "deposit" as const, label: "Bank deposit", icon: LandmarkIcon }] : [])]} />
        <div className="rounded-xl border bg-muted/50 px-4 py-3 text-right font-heading text-3xl font-semibold tabular-nums"><span className="mr-1 text-sm text-muted-foreground">{currency}</span>{amount || "0"}</div>
        <Numpad value={amount} onChange={setAmount} onEnter={() => { if (!busy && ready) void submit(); }} />
        {deposit ? (
          <>
            <Input value={bagNo} onChange={(e) => setBagNo(e.target.value)} placeholder="Bag or slip number" className="h-11" />
            <Input value={takenBy} onChange={(e) => setTakenBy(e.target.value)} placeholder="Taken by (name or cash-in-transit company)" className="h-11" />
            <p className="text-xs text-muted-foreground">Leaves the drawer and is recorded as the day&apos;s bank deposit.</p>
          </>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              {MOVE_REASONS[kind as keyof typeof MOVE_REASONS].map((r) => (
                <button key={r} type="button" onClick={() => setReason(r)}
                  className={cn("h-10 rounded-full border px-4 text-sm active:scale-[0.97]", reason === r ? "border-primary bg-primary/10 text-primary" : "bg-card hover:bg-muted")}>{r}</button>
              ))}
            </div>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason" className="h-11" />
          </>
        )}
        <DialogFooter>
          <Button variant="outline" className="h-12" onClick={onClose}>Cancel</Button>
          <Button className="h-12 min-w-32" disabled={busy || !ready} onClick={() => void submit()}>Record</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Closing the shift with a blind count (REQ DAY-05). After counting, the report shows the variance. */
export function CloseShiftDialog({ shiftId, currency, onClose, onDone }: { shiftId: string | null; currency: string; onClose: () => void; onDone: (r: ShiftReport) => void }) {
  const [counts, setCounts] = useState<Counts>({});
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const total = countTotal(counts);
  async function submit() {
    setBusy(true);
    try {
      const r = await api<ShiftReport>(`/shifts/${shiftId}/close`, "POST", { countedCash: total, counts, note });
      setCounts({}); setNote("");
      onDone(r);
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Dialog open={!!shiftId} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Close your shift</DialogTitle>
          <DialogDescription>Count everything in the drawer. You&apos;ll see the difference to what&apos;s expected once you close.</DialogDescription>
        </DialogHeader>
        <CashCount counts={counts} onChange={setCounts} currency={currency} onLast={() => { if (!busy) void submit(); }} />
        <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" className="h-11" />
        <DialogFooter>
          <Button variant="outline" className="h-12" onClick={onClose}>Cancel</Button>
          <Button className="h-12 min-w-40" disabled={busy} onClick={() => void submit()}>Close shift · {money(total)}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const MOVE_LABEL: Record<MoveKind, string> = { in: "Cash in", out: "Cash out", drop: "Safe drop", deposit: "Bank deposit" };

/** An order type's line; `platform`: a delivery platform's orders (null: not a platform's; missing: a report from before the split). */
type TypeLine = { type: OrderType; platform?: string | null; orders: number; amount: number };
/** Talabat, Deliveroo… by name; the branch's own delivery as "Own delivery" once platforms are split out. */
const typeLabel = (t: TypeLine) => t.platform ?? (t.type === "delivery" && "platform" in t ? "Own delivery" : TYPE_LABEL[t.type] ?? t.type);
/** A payment method's line; `platform`: a platform payment's platform, `cardType`: a card payment's FACTS card type. */
type PayLine = { method: PayMethod; kind: "payment" | "refund"; platform?: string | null; cardType?: string | null; amount: number; count?: number };
/** A payment method's label: platform payments by platform ("Talabat"), card payments by card type ("Card · VISA CARD"). */
const methodLabel = (p: PayLine) => (p.method === "platform" && p.platform ? p.platform
  : p.method === "card" && p.cardType ? `Card · ${cardLabel(p.cardType)}` : METHOD_LABEL[p.method] ?? p.method);
/** The payment lines, and under several card types their total (to match the card machine's settlement). */
function paymentLines(ps: PayLine[], withCount: boolean): ReceiptLine[] {
  const out: ReceiptLine[] = [];
  const line = (p: PayLine) => ({ text: `${methodLabel(p)}${p.kind === "refund" ? " refunds" : ""}${withCount && p.count != null ? ` (${p.count})` : ""}`, right: `${p.kind === "refund" ? "-" : ""}${money(p.amount)}` });
  const cards = ps.filter((p) => p.method === "card" && p.kind === "payment");
  for (const p of ps) {
    out.push(line(p));
    if (cards.length > 1 && p === cards[cards.length - 1]) out.push({ text: "Card total", right: money(cards.reduce((t, c) => t + c.amount, 0)), bold: true });
  }
  return out;
}

/** A shift's X (open) or Z (closed) report as lines for the receipt printer. */
export function shiftReportLines(r: ShiftReport, title: string): ReceiptLine[] {
  const s = r.shift;
  const out: ReceiptLine[] = [
    { text: title, align: "center", bold: true },
    { text: `${r.kind} REPORT · SHIFT`, align: "center", bold: true, size: "large" },
    { text: s.sharedDrawer ? `${s.registerName} · shared drawer, opened by ${s.userName}` : `${s.registerName} · ${s.userName}`, align: "center", size: "small" },
    { text: `${new Date(s.openedAt).toLocaleString("en-GB")}${s.closedAt ? ` – ${new Date(s.closedAt).toLocaleTimeString("en-GB")}` : ""}`, align: "center", size: "small" },
    { rule: true }, { text: `Orders paid: ${r.orders}` },
  ];
  if (r.byType?.length) {
    for (const t of r.byType) out.push({ text: `${typeLabel(t)} (${t.orders})`, right: money(t.amount) });
    out.push({ rule: true });
  }
  out.push(...paymentLines(r.payments, true));
  out.push({ rule: true }, { text: "CASH", bold: true }, { text: "Opening float", right: money(r.cash.openingFloat) }, { text: "Cash sales", right: money(r.cash.cashSales) });
  if (r.cash.cashRefunds) out.push({ text: "Cash refunds", right: `-${money(r.cash.cashRefunds)}` });
  for (const m of r.movements) out.push({ text: `${MOVE_LABEL[m.kind]}: ${m.reason}`, right: `${m.kind === "in" ? "" : "-"}${money(m.amount)}`, size: "small" });
  // A shared drawer: what each cashier took (payments less refunds), so the count can be talked through.
  if (s.sharedDrawer || (r.byCashier?.length ?? 0) > 1) {
    out.push({ rule: true }, { text: "BY CASHIER", bold: true });
    for (const x of r.byCashier ?? []) out.push({ text: `${x.name} (${x.payments})`, right: money(x.total) }, { text: "   of which cash", right: money(x.cash), size: "small" });
    out.push({ rule: true });
  }
  if (r.kind === "Z") {
    out.push({ text: "Expected in drawer", right: money(r.expected), bold: true });
    if (s.countedCash !== null) out.push({ text: "Counted", right: money(s.countedCash) }, { text: "Variance", right: money(s.variance ?? 0), bold: true });
    out.push({ text: `Status: ${SHIFT_STATUS[s.status]}`, size: "small" });
  }
  out.push({ rule: true }, { text: `Printed ${new Date().toLocaleString("en-GB")}`, align: "center", size: "small" });
  return out;
}

/** The day's Z report as lines for the receipt printer. */
export function dayReportLines(z: DayReport, title: string): ReceiptLine[] {
  const out: ReceiptLine[] = [
    { text: title, align: "center", bold: true },
    { text: z.status === "closed" ? "Z REPORT · DAY" : "X REPORT · DAY", align: "center", bold: true, size: "large" },
    { text: new Date(z.date).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" }), align: "center", size: "small" },
    { rule: true },
    { text: `Orders ${z.sales.orders} · Guests ${z.sales.guests}` },
    { text: "Gross sales", right: money(z.sales.gross) }, { text: "VAT", right: money(z.sales.vat) }, { text: "Net of VAT", right: money(z.sales.net) },
    { text: "Discounts given", right: money(z.sales.discounts) },
    ...(z.sales.serviceCharge ? [{ text: "Service charge", right: money(z.sales.serviceCharge) }] : []),
    { text: `Credit notes (${z.refunds.count})`, right: `-${money(z.refunds.total)}` },
    { text: "Net sales", right: money(z.netSales), bold: true },
    { rule: true },
  ];
  for (const t of z.byType) out.push({ text: `${typeLabel(t)} (${t.orders})`, right: money(t.amount) });
  out.push({ rule: true });
  out.push(...paymentLines(z.payments, false));
  // The day's cash, all shifts together: it adds up to what the drawers should hold, against what was counted.
  if (z.cash) {
    const k = z.cash;
    out.push({ rule: true }, { text: "CASH (all tills)", bold: true }, { text: k.shiftChange === undefined ? "Opening floats" : "Opening float", right: money(k.openingFloat) }, { text: "Cash sales", right: money(k.cashSales) });
    if (k.cashRefunds) out.push({ text: "Cash refunds", right: `-${money(k.cashRefunds)}` });
    for (const m of k.movements) out.push({ text: `${MOVE_LABEL[m.kind]}: ${m.reason}${m.register ? ` (${m.register})` : ""}`, right: `${m.kind === "in" ? "" : "-"}${money(m.amount)}`, size: "small" });
    if (k.movements.length) {
      if (k.cashIn) out.push({ text: "Cash in, total", right: money(k.cashIn) });
      if (k.cashOut) out.push({ text: "Cash out, total", right: `-${money(k.cashOut)}` });
      if (k.drops) out.push({ text: "Safe drops, total", right: `-${money(k.drops)}` });
      if (k.deposits) out.push({ text: "Bank deposits from drawers, total", right: `-${money(k.deposits)}` });
    }
    if (k.shiftChange) out.push({ text: k.shiftChange > 0 ? "Taken out at shift changes" : "Put in at shift changes", right: `${k.shiftChange > 0 ? "-" : ""}${money(Math.abs(k.shiftChange))}` });
    out.push({ text: "Expected in drawers", right: money(k.expected), bold: true });
    const unit = k.shiftChange === undefined ? "shift" : "till";
    out.push({ text: k.uncounted ? `Counted (${k.uncounted} ${unit}${k.uncounted === 1 ? "" : "s"} not counted yet)` : "Counted", right: money(k.counted) });
  }
  out.push({ rule: true }, { text: `Voids (${z.voids.count})`, right: money(z.voids.value) });
  for (const s of z.shifts) out.push({ text: `${s.registerName} · ${s.userName}`, right: s.variance === null ? SHIFT_STATUS[s.status] : money(s.variance), size: "small" });
  out.push({ text: "Total variance", right: money(z.variance), bold: true });
  if (z.depositTotal) {
    out.push({ text: "Bank deposits", right: money(z.depositTotal) });
    for (const x of z.deposits) out.push({ text: `   ${x.fromRegister ? `from drawer (${x.fromRegister})` : "from safe"} · ${x.bagNo ? `bag ${x.bagNo} · ` : ""}${x.takenBy}`, right: money(x.amount), size: "small" });
  }
  if (z.wastage?.count) out.push({ text: `Wastage (${z.wastage.count})`, right: money(z.wastage.value) });
  if (z.marketing?.count) out.push({ text: `Marketing, given away (${z.marketing.count})`, right: money(z.marketing.value) });
  if (z.noSales) out.push({ text: "No-sales (drawer opened)", right: String(z.noSales) });
  out.push({ rule: true }, { text: `Printed ${new Date().toLocaleString("en-GB")}`, align: "center", size: "small" });
  return out;
}

/** Prints report lines on this till's receipt printer; false (and a hint) when no device service answers. */
export async function printLines(lines: ReceiptLine[]): Promise<boolean> {
  try {
    await printReceipt(newKey(), lines, false);
    return true;
  } catch {
    toast.message("No receipt printer on this device", { description: "Use the browser's print instead." });
    return false;
  }
}

/** A report shown on screen, as it prints: monospace, receipt width. `viewOnly`: no print buttons (Reports › Closed days). */
export function ReportDialog({ lines, onClose, viewOnly }: { lines: ReceiptLine[] | null; onClose: () => void; viewOnly?: boolean }) {
  return (
    <Dialog open={!!lines} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader><DialogTitle>Report</DialogTitle></DialogHeader>
        <div className="print-area max-h-[65dvh] overflow-y-auto rounded-xl border bg-white px-4 py-3 font-mono text-[0.78rem] leading-relaxed text-black">
          {lines?.map((l, i) => l.rule ? <div key={i} className="my-1.5 border-t border-dashed border-black/40" /> : (
            <div key={i} className={cn("flex justify-between gap-3", l.align === "center" && "justify-center text-center", l.bold && "font-bold", l.size === "large" && "text-base", l.size === "small" && "text-[0.7rem]")}>
              <span>{l.text}</span>{l.right != null && <span className="tabular-nums">{l.right}</span>}
            </div>
          ))}
        </div>
        <DialogFooter>
          {viewOnly ? <Button variant="outline" className="h-11" onClick={onClose}>Close</Button> : <>
            <Button variant="outline" className="h-11" onClick={() => window.print()}><PrinterIcon /> Browser print</Button>
            <Button className="h-11" onClick={() => lines && void printLines(lines)}><PrinterIcon /> Print</Button>
          </>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
