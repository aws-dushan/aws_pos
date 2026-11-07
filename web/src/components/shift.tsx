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
  /** The branch's cash to bank on the shift's day (still to deposit). */
  toBank?: ToBank | null;
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
  /** The branch's cash to bank on that day (still to deposit). */
  toBank?: ToBank | null;
};
export type DayInfo = {
  dayControl: "manual" | "automatic" | "cashier"; defaultFloat: number; tolerance: number; openOrdersAtClose: "carry" | "void_unsent"; autoOpen: string; autoClose: string;
  day: DayRow | null; shifts: ShiftRow[]; pending: ShiftRow[]; myShiftId: string | null; registerId: string | null; report: DayReport | null;
  recent: (DayRow & { z: DayReport | null; toBank?: ToBank | null })[]; canManage: boolean; canReopen: boolean; canDeposit: boolean;
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

/** The cash in that is owed to the bank, not float (it is added to Cash to bank). */
const TO_BANK = "Cash to deposit to bank";
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
  // A cash in owed to the bank (not float): the box then takes an optional note, kept as the remark on Cash to bank.
  const [toBank, setToBank] = useState(false);
  const deposit = kind === "deposit";
  const bank = kind === "in" && toBank;
  const ready = Number(amount) > 0 && (deposit ? takenBy.trim() : bank || reason.trim());
  async function submit() {
    setBusy(true);
    try {
      if (deposit) await api(`/shifts/${shiftId}/deposit`, "POST", { amount: Number(amount), bagNo: bagNo || null, takenBy: takenBy.trim() });
      else if (bank) await api(`/shifts/${shiftId}/cash`, "POST", { kind, amount: Number(amount), reason: `${TO_BANK}${reason.trim() ? ` · ${reason.trim()}` : ""}`, toBank: true });
      else await api(`/shifts/${shiftId}/cash`, "POST", { kind, amount: Number(amount), reason });
      // Money goes into or out of the drawer, so it opens.
      void openDrawerForCash();
      toast.success(bank ? "Cash in recorded, owed to the bank" : kind === "in" ? "Cash in recorded" : kind === "out" ? "Cash out recorded" : deposit ? "Bank deposit recorded" : "Safe drop recorded");
      setAmount(""); setReason(""); setBagNo(""); setTakenBy(""); setToBank(false);
      onDone();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Dialog open={!!shiftId} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>Cash in or out</DialogTitle><DialogDescription>Every movement is counted in the shift and shows in its report.</DialogDescription></DialogHeader>
        <Segmented id="cash-kind" value={kind} onChange={(k) => { setKind(k); setReason(""); setToBank(false); if (k === "deposit" && !takenBy) setTakenBy(me.user.displayName); }} className="w-full"
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
                <button key={r} type="button" onClick={() => { setReason(r); setToBank(false); }}
                  className={cn("h-10 rounded-full border px-4 text-sm active:scale-[0.97]", !bank && reason === r ? "border-primary bg-primary/10 text-primary" : "bg-card hover:bg-muted")}>{r}</button>
              ))}
              {kind === "in" && (
                <button type="button" onClick={() => { setToBank(true); setReason(""); }}
                  className={cn("h-10 rounded-full border px-4 text-sm active:scale-[0.97]", bank ? "border-primary bg-primary/10 text-primary" : "bg-card hover:bg-muted")}>{TO_BANK}</button>
              )}
            </div>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={bank ? "Note (optional), e.g. Balance from before One POS" : "Reason"} className="h-11" />
            {bank && <p className="text-xs text-muted-foreground">Goes into the drawer and is added to what this branch owes the bank (Cash to bank). Any other reason is float.</p>}
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

/** A branch's cash to bank on the report's day: brought forward, that day's cash, amounts added, deposits, and still to deposit. */
export type ToBank = { broughtForward: number; cash: number; added: number; deposited: number; stillToDeposit: number };

const small = (text: string): ReceiptLine => ({ text: `   ${text}`, size: "small" });
const signed = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${money(Math.abs(n))}`;
const dayLabel = (d: string) => new Date(d).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });

/**
 * Block 1, what was sold: each order type, the delivery platforms together on one line (named underneath). `t.platform` set = a
 * platform's orders; reports from before platforms were split have none.
 */
function soldLines(types: TypeLine[]): ReceiptLine[] {
  const out: ReceiptLine[] = [];
  const plats = types.filter((t) => t.platform);
  for (const t of types.filter((x) => !x.platform)) out.push({ text: `   ${typeLabel(t)} (${t.orders})`, right: money(t.amount) });
  if (plats.length) {
    out.push({ text: `   Delivery platforms (${plats.reduce((n, t) => n + t.orders, 0)})`, right: money(plats.reduce((n, t) => n + t.amount, 0)) });
    out.push(small(`   ${plats.map((t) => `${t.platform} ${t.orders}`).join(" · ")}`));
  }
  return out;
}

/**
 * Block 2, how it was paid: card (by card type underneath), the platforms (they pay the outlet), cash and the rest, refunds given back,
 * and a total that matches the sales.
 */
function paidLines(ps: PayLine[]): ReceiptLine[] {
  const out: ReceiptLine[] = [];
  const pay = ps.filter((p) => p.kind === "payment"), back = ps.filter((p) => p.kind === "refund");
  const sum = (xs: PayLine[]) => xs.reduce((t, p) => t + p.amount, 0);
  const cards = pay.filter((p) => p.method === "card");
  if (cards.length) {
    out.push({ text: "Card", right: money(sum(cards)) });
    if (cards.length > 1 || cards[0].cardType) out.push(small(cards.map((p) => `${p.cardType ? cardLabel(p.cardType) : "Card"} ${money(p.amount)}`).join(" · ")));
  }
  const plats = pay.filter((p) => p.method === "platform");
  if (plats.length) {
    out.push({ text: "Platforms (they pay us)", right: money(sum(plats)) });
    out.push(small(plats.map((p) => `${p.platform ?? "Platform"} ${money(p.amount)}`).join(" · ")));
  }
  for (const p of pay.filter((x) => x.method !== "card" && x.method !== "platform")) out.push({ text: METHOD_LABEL[p.method] ?? p.method, right: money(p.amount) });
  if (back.length) {
    out.push({ text: "Given back (returns)", right: `−${money(sum(back))}` });
    out.push(small(back.map((p) => `${methodLabel(p)} ${money(p.amount)}`).join(" · ")));
  }
  out.push({ text: "Total", right: money(sum(pay) - sum(back)), bold: true });
  return out;
}

/** "Still to deposit" with how it came about (Cash to bank for the day). */
function toBankLines(b: ToBank | null | undefined, label: string): ReceiptLine[] {
  if (!b) return [];
  const parts = [`${money(b.broughtForward)} from before`, `+ ${money(b.cash)} cash`];
  if (b.added) parts.push(`${b.added > 0 ? "+" : "−"} ${money(Math.abs(b.added))} added`);
  if (b.deposited) parts.push(`− ${money(b.deposited)} deposited`);
  return [{ text: label, right: money(b.stillToDeposit), bold: true }, small(parts.join(" "))];
}

/** The movements behind the drawer figure, in one small line. */
function cashDetail(opened: number, sales: number, refunds: number, moves: { kind: MoveKind; amount: number }[], shiftChange?: number): ReceiptLine {
  const total = (k: MoveKind) => moves.filter((m) => m.kind === k).reduce((t, m) => t + m.amount, 0);
  const parts = [`opened with ${money(opened)}`, `+ cash sales ${money(sales)}`];
  if (refunds) parts.push(`− cash returns ${money(refunds)}`);
  if (total("in")) parts.push(`+ cash in ${money(total("in"))}`);
  if (total("out")) parts.push(`− cash out ${money(total("out"))}`);
  if (total("drop")) parts.push(`− safe drops ${money(total("drop"))}`);
  if (total("deposit")) parts.push(`− bank deposits ${money(total("deposit"))}`);
  if (shiftChange) parts.push(`${shiftChange > 0 ? "− taken out" : "+ put in"} at shift changes ${money(Math.abs(shiftChange))}`);
  return { text: `Cash details: ${parts.join(" · ")}`, size: "small" };
}

/** A shift's X (open) or Z (closed) report as lines for the receipt printer and the screen: what I sold, how I was paid, my drawer, also. */
export function shiftReportLines(r: ShiftReport, title: string): ReceiptLine[] {
  const s = r.shift;
  const out: ReceiptLine[] = [
    { text: title, align: "center", bold: true },
    { text: `SHIFT REPORT (${r.kind})`, align: "center", bold: true, size: "large" },
    { text: s.sharedDrawer ? `${s.registerName} · shared drawer, opened by ${s.userName}` : `${s.registerName} · ${s.userName}`, align: "center", size: "small" },
    { text: `${new Date(s.openedAt).toLocaleString("en-GB")}${s.closedAt ? ` – ${new Date(s.closedAt).toLocaleTimeString("en-GB")}` : " · still open"}`, align: "center", size: "small" },
    { rule: true },
    { text: "1. WHAT I SOLD", bold: true },
  ];
  const sold = (r.byType ?? []).reduce((t, x) => t + x.amount, 0);
  out.push({ text: "Sales", right: money(sold), bold: true }, { text: `   Bills ${r.orders}`, size: "small" }, ...soldLines(r.byType ?? []));
  out.push({ rule: true }, { text: "2. HOW I WAS PAID", bold: true }, ...paidLines(r.payments));
  // A shared drawer: what each cashier took (payments less refunds), so the count can be talked through.
  if (s.sharedDrawer || (r.byCashier?.length ?? 0) > 1)
    for (const x of r.byCashier ?? []) out.push(small(`${x.name}: ${x.payments} bills ${money(x.total)}, cash ${money(x.cash)}`));
  out.push({ rule: true }, { text: "3. MY DRAWER", bold: true });
  // The X report keeps the count blind: it shows what moved, not what the drawer should hold.
  if (r.kind === "Z") {
    out.push({ text: "Should be in the drawer", right: money(r.expected) });
    if (s.countedCash !== null) out.push({ text: "Counted", right: money(s.countedCash) }, { text: "Difference", right: signed(s.variance ?? 0), bold: true });
    out.push(small(`Status: ${SHIFT_STATUS[s.status]}`));
  }
  const sent = r.movements.filter((m) => m.kind === "deposit");
  if (sent.length) {
    out.push({ text: "Sent to the bank", right: money(sent.reduce((t, m) => t + m.amount, 0)) });
    for (const m of sent) out.push(small(m.reason));
  }
  out.push(...toBankLines(r.toBank, "Still to deposit (branch)"));
  out.push(cashDetail(r.cash.openingFloat, r.cash.cashSales, r.cash.cashRefunds, r.movements));
  const other = r.movements.filter((m) => m.kind !== "deposit");
  if (other.length) {
    out.push({ rule: true }, { text: "4. ALSO", bold: true });
    for (const m of other) out.push({ text: `${MOVE_LABEL[m.kind]}: ${m.reason}`, right: `${m.kind === "in" ? "+" : "−"}${money(m.amount)}`, size: "small" });
  }
  out.push({ rule: true }, { text: `Printed ${new Date().toLocaleString("en-GB")}`, align: "center", size: "small" });
  return out;
}

/** The day's X (open) or Z (closed) report as lines for the receipt printer and the screen: what we sold, how we were paid, cash drawers, also today. */
export function dayReportLines(z: DayReport, title: string): ReceiptLine[] {
  const closed = z.status === "closed";
  const out: ReceiptLine[] = [
    { text: title, align: "center", bold: true },
    { text: `DAY REPORT (${closed ? "Z" : "X"})`, align: "center", bold: true, size: "large" },
    { text: `${dayLabel(z.date)}${closed ? "" : " · still open"}`, align: "center", size: "small" },
    { rule: true },
    { text: "1. WHAT WE SOLD", bold: true },
    { text: "Net sales", right: money(z.netSales), bold: true },
    { text: `   Bills ${z.sales.orders} · Guests ${z.sales.guests}`, size: "small" },
    ...soldLines(z.byType),
    { text: "Discounts given", right: money(z.sales.discounts) },
    ...(z.sales.serviceCharge ? [{ text: "Service charge", right: money(z.sales.serviceCharge) }] : []),
    { text: `Returns (${z.refunds.count})`, right: z.refunds.total ? `−${money(z.refunds.total)}` : money(0) },
    { text: "VAT included", right: money(z.sales.vat) },
    { rule: true },
    { text: "2. HOW WE WERE PAID", bold: true },
    ...paidLines(z.payments),
    { rule: true },
  ];

  // Block 3: the drawers. Is the cash right, what went to the bank, what is still to deposit; the movements in one small line.
  const tills = [...new Set(z.shifts.map((s) => s.registerName))];
  out.push({ text: `3. CASH DRAWER${tills.length === 1 ? ` · ${tills[0]}` : "S"}`, bold: true });
  if (z.cash) {
    const k = z.cash;
    out.push({ text: tills.length > 1 ? "Should be in the drawers" : "Should be in the drawer", right: money(k.expected) });
    const unit = k.shiftChange === undefined ? "shift" : "till";
    out.push({ text: k.uncounted ? `Counted (${k.uncounted} ${unit}${k.uncounted === 1 ? "" : "s"} not counted yet)` : "Counted", right: money(k.counted) });
  }
  out.push({ text: "Difference", right: signed(z.variance), bold: true });
  const perShift = z.shifts.map((s) => `${tills.length > 1 ? `${s.registerName} ` : ""}${s.userName} ${s.variance === null ? SHIFT_STATUS[s.status].toLowerCase() : signed(s.variance)}`);
  if (perShift.length) out.push(small(perShift.join(" · ")));
  if (z.depositTotal) {
    out.push({ text: "Sent to the bank today", right: money(z.depositTotal) });
    for (const x of z.deposits) out.push(small(`${x.takenBy}${x.bagNo ? ` · bag ${x.bagNo}` : ""} · ${x.fromRegister ? `from ${x.fromRegister}` : "from the safe"} · ${money(x.amount)}`));
  }
  out.push(...toBankLines(z.toBank, "Still to deposit"));
  if (z.cash) out.push(cashDetail(z.cash.openingFloat, z.cash.cashSales, z.cash.cashRefunds, z.cash.movements, z.cash.shiftChange));

  // Block 4: everything else of the day.
  const also: ReceiptLine[] = [{ text: "Voids", right: `${z.voids.count} · ${money(z.voids.value)}` }];
  if (z.wastage?.count) also.push({ text: "Wastage", right: `${z.wastage.count} · ${money(z.wastage.value)}` });
  if (z.marketing?.count) also.push({ text: "Given away (marketing)", right: `${z.marketing.count} · ${money(z.marketing.value)}` });
  if (z.noSales) also.push({ text: "Drawer opened without a sale", right: String(z.noSales) });
  if (!closed && z.openOrders.count) also.push({ text: "Open bills", right: `${z.openOrders.count} · ${money(z.openOrders.value)}` });
  for (const m of z.cash?.movements.filter((x) => x.kind !== "deposit") ?? [])
    also.push({ text: `${MOVE_LABEL[m.kind]}: ${m.reason}${m.register ? ` (${m.register})` : ""}`, right: `${m.kind === "in" ? "+" : "−"}${money(m.amount)}`, size: "small" });
  out.push({ rule: true }, { text: `4. ALSO ${closed ? "THAT DAY" : "TODAY"}`, bold: true }, ...also);
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
