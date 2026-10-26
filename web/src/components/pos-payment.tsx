"use client";

import { printReceiptArea } from "@/lib/browser-print";
import { useRef, useState } from "react";
import { BanknoteIcon, CreditCardIcon, GiftIcon, Loader2Icon, PrinterIcon, UserRoundIcon, WalletCardsIcon, StarIcon, BikeIcon, PlusIcon, SplitIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { api, newKey, useApi } from "@/lib/api";
import { openDrawerForCash, printReceipt, type ReceiptLine } from "@/lib/device";
import { cn } from "@/lib/utils";
import { fmtIn, roundTo } from "@/lib/num";
import { fmtQty, METHOD_LABEL, orderLabel, TYPE_LABEL, type OrderDetail, type PayMethod, orderNo, cardLabel } from "@/lib/pos";
import { Segmented } from "@/components/kit";
import { Numpad } from "@/components/numpad";
import { celebrate } from "@/components/motion";
import { PrintedLines } from "@/components/printed-lines";
import { qrImage, receiptUrl, useReceiptQr } from "@/lib/qr";
import { useSession } from "@/components/session";
import { withBase } from "@/lib/base-path";
import { AR, METHOD_AR } from "@/lib/receipt-ar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const money = (n: number) => fmtIn(n, 2);
const METHODS: { value: PayMethod; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { value: "cash", label: "Cash", icon: BanknoteIcon },
  { value: "card", label: "Card", icon: CreditCardIcon },
  { value: "other", label: "Other", icon: WalletCardsIcon },
  { value: "voucher", label: "Voucher", icon: GiftIcon },
  { value: "account", label: "Account", icon: UserRoundIcon },
  { value: "points", label: "Points", icon: StarIcon },
  { value: "platform", label: "Platform", icon: BikeIcon },
];

/** One part of a split payment, as sent to the server. */
type Part = { method: PayMethod; amount: number; tendered: number | null; reference: string | null; cardType: string | null };

/** Notes a guest is likely to hand over for `due` (the next round amounts above it). */
function tenders(due: number): number[] {
  const out = new Set<number>([roundTo(due, 2)]);
  for (const step of [5, 10, 50, 100, 200, 500]) {
    const v = Math.ceil(due / step) * step;
    if (v > due) out.add(v);
  }
  return [...out].sort((a, b) => a - b).slice(0, 5);
}

/**
 * Takes payment (REQ PAY-01, PAY-02): cash (the cashier types what was handed over, the change shows), card (its FACTS card type),
 * other, voucher, customer account. Less than due is a part payment and the dialog stays open for the rest. Paid in full: the
 * receipt prints and the till goes back to a new order (onPaid gets whether it printed).
 */
export function PaymentDialog({ detail, currency, open, onOpenChange, onChanged, onPaid }: {
  detail: OrderDetail; currency: string; open: boolean; onOpenChange: (o: boolean) => void;
  onChanged: (d: OrderDetail) => void; onPaid: (d: OrderDetail, printed: boolean, change: number) => void;
}) {
  const due = detail.order.due;
  const { company } = useSession();
  // A split payment (cash + cards, several cards…): the parts added so far, all taken together with the last one when "Pay" is pressed.
  const [parts, setParts] = useState<Part[]>([]);
  const [splitting, setSplitting] = useState(false);
  const partsTotal = roundTo(parts.reduce((s, p) => s + p.amount, 0), 2);
  const left = roundTo(due - partsTotal, 2);
  // Vouchers and points only where the company uses them; points only with a customer on the order.
  const methods = METHODS.filter((m) => (m.value !== "voucher" || company?.vouchersEnabled) && (m.value !== "points" || (company?.loyaltyEnabled && detail.order.customerId))
    && (m.value !== "platform" || detail.order.platformId));
  const [method, setMethod] = useState<PayMethod>(detail.order.platformId ? "platform" : "cash");
  const [amount, setAmount] = useState("");
  // The amount shown was filled in (the amount due, a note button…): the first key typed replaces it.
  const [pristine, setPristine] = useState(true);
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [seen, setSeen] = useState<string | null>(null);
  const payRef = useRef<HTMLButtonElement>(null);
  const key = open ? `${detail.order.id}:${due}` : null;
  if (key !== seen) { setSeen(key); setAmount(method === "cash" ? "" : due ? due.toFixed(2) : ""); setReference(""); setPristine(true); setParts([]); setSplitting(false); }

  // Cash: nothing typed is the exact amount (of what's left after the split's parts); otherwise what the customer handed over.
  const value = method === "cash" && amount === "" ? left : Number(amount || 0);
  const applied = method === "cash" ? Math.min(value, left) : value;
  const change = method === "cash" ? Math.max(0, roundTo(value - left, 2)) : 0;
  const part = applied < left - 0.004;
  const over = method !== "cash" && value > left + 0.004;
  const needsRef = method === "voucher" || method === "account";
  // The branch's FACTS card types (where it posts to FACTS): the cashier picks one for a card payment.
  const modes = useApi<{ name: string; kind: string; label: string }[]>("/erp/payment-modes");
  const cardTypes = (modes.data ?? []).filter((m) => m.kind === "card");
  const [cardType, setCardType] = useState<string | null>(null);
  const needsCard = method === "card" && cardTypes.length > 0;
  // The voucher typed in: what it has left (checked as it's typed).
  const code = reference.trim();
  const voucher = useApi<{ code: string; balance: number; expiresOn: string | null; usable: boolean; status: string }>(method === "voucher" && code.length >= 9 ? `/vouchers/check?code=${encodeURIComponent(code)}` : null);
  const rewards = useApi<{ pointValue: number; minRedeem: number }>(method === "points" ? "/rewards" : null);
  const customer = useApi<{ customer: { points: number; name: string } }>(method === "points" && detail.order.customerId ? `/customers/${detail.order.customerId}` : null);
  const pointsWorth = customer.data && rewards.data ? roundTo(customer.data.customer.points * rewards.data.pointValue, 2) : null;

  const entryOk = !!value && !over && !(needsRef && !reference.trim()) && !(needsCard && !cardType);
  const current = (): Part => ({ method, amount: roundTo(applied, 2), tendered: method === "cash" ? value : null, reference: reference || null, cardType: needsCard ? cardType : null });

  /** The amount on screen becomes one part of the split; the screen is ready for the next part (what's left). */
  function addPart() {
    if (!entryOk || !part) return;
    const p = { ...current(), tendered: method === "cash" ? roundTo(applied, 2) : null };
    setParts((ps) => [...ps, p]);
    const rest = roundTo(left - p.amount, 2);
    setAmount(method === "cash" ? "" : rest.toFixed(2)); setReference(""); setCardType(null); setPristine(true);
  }

  async function pay() {
    if (!entryOk && parts.length === 0) return;
    const payments = [...parts, ...(entryOk ? [current()] : [])];
    if (payments.length === 0) return;
    setBusy(true);
    try {
      const d = await api<OrderDetail>(`/orders/${detail.order.id}/pay`, "POST", { payments }, { key: newKey() });
      setParts([]); setSplitting(false);
      // Cash taken (alone, in a split or as a part payment): the drawer opens now, not only when a receipt prints.
      if (payments.some((p) => p.method === "cash")) void openDrawerForCash();
      onChanged(d);
      if (d.order.status === "paid") {
        celebrate(payRef.current);
        // The receipt prints on this till's printer (the drawer already opened above when cash was taken: REQ HW-04).
        const printed = await printOrderReceipt(d.order.id, false).catch((e: Error) => { toast.error(`Receipt not printed: ${e.message}`); return false; });
        onPaid(d, printed, change);
      } else {
        toast.success(`${currency} ${money(payments.reduce((s, p) => s + p.amount, 0))} taken. ${currency} ${money(d.order.due)} left.`);
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-1rem)] sm:max-w-3xl">
        <DialogHeader><DialogTitle>Take payment · #{detail.order.number} · {orderLabel(detail.order)}</DialogTitle></DialogHeader>
        <div className="grid gap-5 md:grid-cols-[1fr_300px]">
          <div className="space-y-4">
            <div className="rounded-2xl p-5 text-white shadow-lift" style={{ background: "var(--hero)" }}>
              <div className="text-xs text-white/70">{parts.length > 0 ? "Left to pay in this split" : detail.order.paid > 0 ? "Left to pay" : "Amount due"}</div>
              <div className="mt-1 flex items-baseline gap-1.5 font-heading text-[2.6rem] leading-none font-semibold tracking-tight tabular-nums">
                <span className="text-base font-medium opacity-60">{currency}</span>{money(left)}
              </div>
              {parts.length > 0 ? <div className="mt-2 text-xs text-white/70">{currency} {money(partsTotal)} of {money(due)} in the parts below</div>
                : detail.order.paid > 0 && <div className="mt-2 text-xs text-white/70">{currency} {money(detail.order.paid)} of {money(detail.order.total)} already paid</div>}
            </div>
            {(splitting || parts.length > 0) && (
              <div className="overflow-hidden rounded-xl border">
                <div className="flex items-center justify-between bg-muted/50 px-3.5 py-2 text-xs font-medium text-muted-foreground">
                  <span className="flex items-center gap-1.5"><SplitIcon className="size-3.5" /> Split payment</span>
                  <span>{parts.length === 0 ? "Choose how the first part is paid, type its amount, then Add." : "Next part below; Pay takes all parts together."}</span>
                </div>
                {parts.map((p, i) => (
                  <div key={i} className="flex items-center gap-3 border-t px-3.5 py-2 text-sm">
                    <span className="font-medium">{i + 1}. {cardLabel(p.cardType) ?? METHOD_LABEL[p.method]}</span>
                    {p.reference && <span className="truncate text-xs text-muted-foreground">{p.reference}</span>}
                    <span className="ml-auto font-heading font-semibold tabular-nums">{money(p.amount)}</span>
                    <button type="button" aria-label={`Remove part ${i + 1}`} className="-mr-1 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                      onClick={() => { setParts((ps) => ps.filter((_, j) => j !== i)); setAmount(method === "cash" ? "" : roundTo(left + p.amount, 2).toFixed(2)); setPristine(true); }}><XIcon className="size-4" /></button>
                  </div>
                ))}
              </div>
            )}
            <Segmented id="pay-method" value={method} onChange={(m) => { setMethod(m); setAmount(m === "cash" ? "" : left.toFixed(2)); setPristine(true); }} className="w-full" size="md"
              options={methods.map((m) => ({ value: m.value, label: m.label, icon: m.icon }))} />
            {needsCard && (
              <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Card type">
                {cardTypes.map((t) => (
                  <button key={t.name} type="button" role="radio" aria-checked={cardType === t.name} onClick={() => setCardType(t.name)}
                    className={cn("h-11 rounded-xl border px-3.5 text-sm transition-[background-color,transform] active:scale-[0.97]",
                      cardType === t.name ? "border-primary bg-primary/10 font-medium text-primary" : "bg-card hover:bg-muted")}>{t.label}</button>
                ))}
                {!cardType && <span className="self-center text-xs text-warning">Choose the card type.</span>}
              </div>
            )}
            {method === "voucher" && voucher.data && (
              <div className={cn("flex items-center justify-between rounded-xl px-4 py-2.5 text-sm", voucher.data.usable ? "bg-success/10 text-success" : "bg-danger/10 text-danger")}>
                <span>{voucher.data.usable ? `Voucher ${voucher.data.code}: ${currency} ${money(voucher.data.balance)} left${voucher.data.expiresOn ? `, valid until ${new Date(voucher.data.expiresOn).toLocaleDateString("en-GB")}` : ""}` : voucher.data.status === "cancelled" ? "This voucher was cancelled." : voucher.data.balance <= 0 ? "This voucher is used up." : "This voucher has expired."}</span>
                {voucher.data.usable && voucher.data.balance < value && <Button size="sm" variant="outline" onClick={() => setAmount(Math.min(voucher.data!.balance, due).toFixed(2))}>Use {money(Math.min(voucher.data.balance, due))}</Button>}
              </div>
            )}
            {method === "voucher" && voucher.error && code.length >= 9 && <div className="rounded-xl bg-danger/10 px-4 py-2.5 text-sm text-danger">{voucher.error}</div>}
            {method === "points" && customer.data && rewards.data && (
              <div className={cn("flex items-center justify-between rounded-xl px-4 py-2.5 text-sm", customer.data.customer.points >= rewards.data.minRedeem ? "bg-success/10 text-success" : "bg-warning/12 text-warning")}>
                <span>{customer.data.customer.name}: {customer.data.customer.points.toLocaleString()} points = {currency} {money(pointsWorth ?? 0)}{customer.data.customer.points < rewards.data.minRedeem ? ` · usable from ${rewards.data.minRedeem.toLocaleString()}` : ""}</span>
                {pointsWorth !== null && pointsWorth < value && customer.data.customer.points >= rewards.data.minRedeem && <Button size="sm" variant="outline" onClick={() => setAmount(Math.min(pointsWorth, due).toFixed(2))}>Use {money(Math.min(pointsWorth, due))}</Button>}
              </div>
            )}
            {method === "cash" ? (
              <div className="grid grid-cols-5 gap-2">
                {tenders(left).map((v, i) => (
                  <Button key={v} variant={value === v ? "default" : "outline"} className="h-12 text-sm tabular-nums" onClick={() => { setAmount(v.toFixed(2)); setPristine(true); }}>
                    {i === 0 ? "Exact" : money(v)}
                  </Button>
                ))}
              </div>
            ) : null}
            {method === "platform" && (
              <div className="rounded-xl bg-muted/60 px-4 py-2.5 text-sm text-muted-foreground">
                {detail.order.platformName} order #{detail.order.platformRef ?? "?"}: the platform collects from the customer and pays the outlet, less its commission.
              </div>
            )}
            {(method !== "cash" && method !== "points" && method !== "platform") && (
              <input value={reference} onChange={(e) => setReference(e.target.value)}
                placeholder={method === "card" ? "Approval code or last 4 digits (optional)" : method === "voucher" ? "Voucher code" : method === "account" ? "Customer account" : "Reference (optional)"}
                className={cn("h-12 w-full rounded-xl border bg-card px-3.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40 dark:bg-input/30",
                  needsRef && !reference.trim() && "border-danger/50")} />
            )}
            <div className={cn("flex items-center justify-between rounded-xl px-4 py-3 text-sm transition-colors",
              change > 0 ? "bg-success/10 text-success" : over ? "bg-danger/10 text-danger" : part && value ? "bg-warning/12 text-warning" : "bg-muted text-muted-foreground")}>
              <span className="font-medium">{change > 0 ? "Change to give" : over ? `Can't be more than ${money(left)}` : part && value ? (splitting || parts.length > 0 ? "Add this part, then pay the rest" : "Part payment") : "No change"}</span>
              <span className="font-heading text-xl font-semibold tabular-nums">{change > 0 ? `${currency} ${money(change)}` : part && value ? `${money(left - applied)} left` : ""}</span>
            </div>
          </div>
          <div className="space-y-3">
            <div className="flex h-14 items-center justify-end rounded-xl border bg-muted/40 px-4 font-heading text-3xl font-semibold tabular-nums">
              <span className="mr-auto text-sm font-medium text-muted-foreground">{method === "cash" ? "Received" : "Amount"}</span>
              {method === "cash" && amount === "" ? <span className="text-muted-foreground/60">{money(left)}</span> : amount || "0"}
            </div>
            <Numpad value={amount} onChange={setAmount} pristine={pristine} onTouch={() => setPristine(false)}
              onEnter={() => { if (busy) return; if (part && (splitting || parts.length > 0)) addPart(); else void pay(); }} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" className="mr-auto h-12 px-5" onClick={() => onOpenChange(false)}>Back to order</Button>
          {!splitting && parts.length === 0 && method !== "platform" && (
            <Button variant="outline" className="h-12 px-5" onClick={() => { setSplitting(true); setAmount(""); setPristine(true); }}><SplitIcon /> Split payment</Button>
          )}
          {(splitting || parts.length > 0) && part && (
            <Button variant="outline" className="h-12 px-5" disabled={busy || !entryOk} onClick={() => void pay()}>Take {money(partsTotal + applied)} now</Button>
          )}
          {(splitting || parts.length > 0) && part ? (
            <Button className="h-12 min-w-48 text-base" disabled={busy || !entryOk} onClick={addPart}><PlusIcon /> Add {currency} {money(applied)}</Button>
          ) : (
            <Button ref={payRef} className="h-12 min-w-48 text-base" disabled={busy || (!entryOk && !(parts.length > 0 && left <= 0.004))} onClick={pay}>
              {busy ? <><Loader2Icon className="animate-spin" /> Taking payment…</> : part ? `Take ${currency} ${money(applied)}` : `Pay ${currency} ${money(due)}`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export type Receipt = {
  legalName: string; trn: string | null; currency: string; branch: string; branchCode: string; address: string | null; phone: string | null;
  receiptHeader: string | null; receiptFooter: string | null; detail: OrderDetail;
  /** Arabic (REQ UX-05): the company's and branch's Arabic names; "bilingual" receipts carry Arabic labels and item names. */
  legalNameAr: string | null; branchAr: string | null; addressAr: string | null; language: "en" | "bilingual";
  email: string | null; website: string | null; settings: ReceiptSettings; logoAt: string | null; companyId: string; tradingName: string;
  /** The digital receipt's link (REQ PAY-05) where the branch prints its QR code and the order is paid. */
  qrToken?: string | null;
  /** On the public digital receipt page: the logo comes through the receipt's link (no sign-in). */
  publicToken?: string;
};

/** What the branch's receipt header shows (Receipt & display screen). */
export type HeaderKey = "logo" | "name" | "nameAr" | "branch" | "branchAr" | "address" | "phone" | "email" | "website" | "trn";
export type ReceiptSettings = {
  /** The header lines, top to bottom. */
  order: HeaderKey[];
  /** Each header line, and the order details (table, customer, cashier), on or off. */
  show: Record<HeaderKey | "table" | "customer" | "cashier" | "qr", boolean>;
  /** Which name prints: the legal name, the trading name, custom text, or none (e.g. the logo shows it). */
  nameSource: "legal" | "trading" | "custom" | "none";
  customName: string | null; customNameAr: string | null;
};

/** The name a receipt prints (English, Arabic) under the branch's settings; null when it prints none. */
export function receiptName(r: Pick<Receipt, "legalName" | "legalNameAr" | "tradingName" | "settings">): { en: string; ar: string | null } | null {
  const s = r.settings;
  switch (s.nameSource) {
    case "none": return null;
    case "trading": return { en: r.tradingName, ar: r.legalNameAr };
    case "custom": return s.customName ? { en: s.customName, ar: s.customNameAr } : { en: r.legalName, ar: r.legalNameAr };
    default: return { en: r.legalName, ar: r.legalNameAr };
  }
}

/** The top of a receipt or credit note: who issues it (in Arabic too when bilingual), its title, TRN and phone. */
export function receiptHead(r: Receipt, titleEn: string, titleAr: string): ReceiptLine[] {
  const bi = r.language !== "en", s = r.settings, on = (k: HeaderKey) => s.show[k];
  const name = receiptName(r);
  // A tax invoice or credit note must show the supplier's TRN (UAE VAT): it prints whatever the setting; the setting only hides it on bills.
  const taxDoc = titleAr === AR.taxInvoice || titleAr === AR.creditNote;
  const out: ReceiptLine[] = [];
  for (const k of s.order) {
    switch (k) {
      case "logo": if (on("logo") && r.logoAt) out.push({ image: withBase(r.publicToken ? `/api/public/receipts/${r.publicToken}/logo` : `/api/companies/${r.companyId}/logo?v=${encodeURIComponent(r.logoAt)}`) }); break;
      case "name": if (on("name") && name) out.push({ text: name.en, align: "center", bold: true, size: "name" }); break;
      case "nameAr": if (bi && on("nameAr") && name?.ar) out.push({ text: name.ar, align: "center", bold: true, size: "name" }); break;
      case "branch": if (on("branch")) out.push({ text: r.branch, align: "center", size: "small" }); break;
      case "branchAr": if (bi && on("branchAr") && r.branchAr) out.push({ text: r.branchAr, align: "center", size: "small" }); break;
      case "address":
        if (on("address") && r.address) out.push({ text: r.address, align: "center", size: "small" });
        if (bi && on("address") && r.addressAr) out.push({ text: r.addressAr, align: "center", size: "small" });
        break;
      case "phone": if (on("phone") && r.phone) out.push({ text: `Phone: ${r.phone}`, align: "center", size: "small" }); break;
      case "email": if (on("email") && r.email) out.push({ text: r.email, align: "center", size: "small" }); break;
      case "website": if (on("website") && r.website) out.push({ text: r.website, align: "center", size: "small" }); break;
      case "trn": if (r.trn && (on("trn") || taxDoc)) out.push({ text: `TRN: ${r.trn}`, align: "center", size: "small" }); break;
    }
  }
  // The title on one line, in a black band: "TAX INVOICE | فاتورة ضريبية" (written Arabic first: in a right-to-left line the
  // English lands on the left).
  out.push({ text: bi ? `${titleAr} | ${titleEn}` : titleEn, align: "center", bold: true, invert: true });
  return out;
}

/**
 * The receipt as lines for the receipt printer and the screen (the same lines), laid out like the bakery's printed tax invoice:
 * header, title band, Ref#, the order's details in two columns, the items as a table (Item · Qty · Sub Total), the totals with
 * the amount before VAT, the grand total band, how it was paid, the footer. English and Arabic, or English only (Receipt & display).
 */
export function receiptLines(r: Receipt, qr?: string | null): ReceiptLine[] {
  const d = r.detail, o = d.order, bi = r.language !== "en", show = r.settings.show;
  const a = (s: string) => (bi ? s : null);
  const paidDoc = !!o.invoiceNo;
  const out = receiptHead(r, paidDoc ? "TAX INVOICE" : "BILL · NOT PAID YET", paidDoc ? AR.taxInvoice : AR.bill);
  if (r.receiptHeader) for (const t of r.receiptHeader.split("\n")) out.push({ text: t, align: "center", size: "small" });
  // Ref#: the invoice's serial (EBQS-00123 -> 00123, INV-EB-QS-000123 -> 000123); a bill not paid yet, the order's number.
  const serial = o.invoiceNo?.match(/-(\d+)$/)?.[1] ?? o.invoiceNo?.match(/(\d{6})$/)?.[1];
  out.push({ text: `Ref# ${serial ?? o.number ?? "-"}`, align: "center", bold: true, size: "large" }, { rule: true });

  // The details, two columns: the customer's side on the left, the invoice's on the right.
  const at = new Date(o.closedAt ?? o.openedAt);
  const when = `${at.toLocaleDateString("en-GB")} ${at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
  const left: string[] = [], right: string[] = [];
  if (show.customer && o.customerName) left.push(`Customer: ${o.customerName}`);
  if (show.customer && o.customerPhone) left.push(`Contact: ${o.customerPhone}`);
  left.push(`Order Type: ${TYPE_LABEL[o.orderType]}`);
  const table = o.tableNames ?? o.tableLabel;
  if (show.table && table) left.push(`Table: ${table}${o.guests ? ` (${o.guests})` : ""}`);
  if (o.platformName) left.push(`${o.platformName}: ${o.platformRef ?? ""}`);
  if (paidDoc) right.push(`Invoice No: ${o.invoiceNo}`);
  if (show.cashier) right.push(`User: ${o.openedByName ?? ""}`, o.registerName ?? r.branchCode);
  right.push(when);
  for (let k = 0; k < Math.max(left.length, right.length); k++) out.push({ text: left[k] ?? "", right: right[k] ?? "", size: "small" });
  if (o.orderType === "delivery" && o.deliveryAddress && show.customer) out.push({ text: `Address: ${o.deliveryAddress}`, size: "small" });

  // The items: a table between solid rules, its heading in both languages.
  out.push({ rule: true, solid: true }, { text: "Item", mid: "Qty", right: "Sub Total", bold: true });
  if (bi) out.push({ text: AR.item, mid: AR.qty, right: AR.lineTotal, bold: true, size: "small", align: "left" });
  out.push({ rule: true, solid: true });
  for (const l of d.lines.filter((x) => !x.isVoid)) {
    // The item's line shows its own price; a combo's chosen items and free options go under it without a price, and paid extras
    // (e.g. an extra shot) are lines of their own, so the amounts down the right add up to the total.
    const extras = l.modifiers.filter((m) => !m.itemId && m.price);
    const extrasTotal = extras.reduce((t, m) => t + m.price * l.qty, 0);
    out.push({ text: l.name.toUpperCase(), mid: fmtQty(l.qty), right: money(l.lineTotal - extrasTotal) });
    if (bi && l.nameAr) out.push({ text: l.nameAr, align: "left", size: "small" });
    for (const m of l.modifiers.filter((x) => !extras.includes(x))) out.push({ text: `   + ${m.name}`, size: "small" });
    for (const m of extras) out.push({ text: m.name, right: money(m.price * l.qty) });
    if (l.note) out.push({ text: `   - ${l.note}`, size: "small" });
    // The item's own discount (a promotion, an item discount) when that is what it got, under the item.
    if (l.discount > 0 && l.discType) out.push({ text: `   ${l.discName ?? "Discount"}`, right: `-${money(l.discount)}`, size: "small" });
  }
  out.push({ rule: true, solid: true });

  // The totals: the base amount, discount, service, the amount before VAT, the VAT; then the grand total in a black band.
  // "Subtotal / المبلغ الأساسي": written Arabic first, so in the right-to-left line the English lands on the left.
  const label = (en: string, ar: string) => (bi ? `${ar} / ${en}` : en);
  out.push({ text: label("Subtotal", AR.subtotal), right: money(o.subtotal) });
  const itemDiscounts = d.lines.some((l) => !l.isVoid && l.discount > 0 && l.discType);
  const discountLabel = o.discountName ?? (o.discountPct ? `Discount ${o.discountPct}%` : itemDiscounts ? "Discounts" : "Discount");
  out.push({ text: label(discountLabel, AR.discount), right: o.discountTotal > 0 ? `-${money(o.discountTotal)}` : money(0) });
  if (o.serviceCharge > 0) out.push({ text: label(`Service charge ${o.servicePct}%`, AR.service), right: money(o.serviceCharge) });
  out.push({ text: label("Amount Before VAT", AR.beforeVat), right: money(o.total - o.vat), size: "small" });
  out.push({ text: label(`VAT @${o.vatRate}%`, AR.vat), right: money(o.vat), size: "small" });
  // Bilingual: the English on the left, the Arabic beside the amount (one line; both together don't fit beside it).
  out.push({ text: "GRAND TOTAL", ar: a(AR.grandTotal), right: `${r.currency} ${money(o.total)}`, bold: true, size: bi ? undefined : "large", invert: true });

  // How it was paid: the account (card type, cash...), paid, received and change.
  for (const p of d.payments) {
    const refund = p.kind === "refund";
    out.push({ text: `${refund ? "Refund" : "Account"}: ${cardLabel(p.cardType) ?? METHOD_LABEL[p.method]}`, ar: a(refund ? AR.refund : METHOD_AR[p.method]), size: "small" });
    out.push({ text: refund ? "Refunded" : "Paid", ar: a(refund ? AR.refund : AR.paid), right: (refund ? "-" : "") + money(p.amount), size: "small" });
    if (!refund && p.method === "cash" && p.tendered != null) {
      out.push({ text: "Received", ar: a(AR.received), right: money(p.tendered), size: "small" });
      out.push({ text: "Change", ar: a(AR.change), right: money(p.changeGiven), size: "small", bold: p.changeGiven > 0 });
    }
  }
  for (const n of d.creditNotes) out.push({ text: `Credit note ${n.number}`, ar: a(AR.creditNote), right: `-${money(n.total)}`, size: "small" });
  out.push({ rule: true });

  if (r.receiptFooter) for (const t of r.receiptFooter.split("\n")) out.push({ text: t, align: "center", bold: true });
  // The QR code to the digital receipt (REQ PAY-05), where the branch prints it.
  if (qr) out.push({ image: qr, imageWidth: 200 }, { text: "Scan for your digital receipt", ar: a("امسح للحصول على الإيصال الرقمي"), align: "center", size: "small" });
  if (paidDoc) out.push({ text: bi ? "نسخة العميل | Customer Copy" : "Customer Copy", align: "center", size: "small" });
  return out;
}

/**
 * Prints an order's receipt on this till's receipt printer (Device Service). `drawer`: also kick the cash drawer (cash taken).
 * Returns false when there is no device service, so the caller can fall back to the browser's print dialog.
 */
export async function printOrderReceipt(orderId: string, drawer: boolean, jobId = newKey()): Promise<boolean> {
  const r = await api<Receipt>(`/orders/${orderId}/receipt`);
  const qr = r.qrToken ? await qrImage(receiptUrl(r.qrToken)).catch(() => null) : null;
  try {
    await printReceipt(jobId, receiptLines(r, qr), drawer);
    return true;
  } catch (e) {
    if ((e as Error).message.includes("isn't running")) return false;
    throw e;
  }
}

/** A printable tax-invoice receipt (only it prints: globals.css .print-area). Phase 1 prints through the browser; the Device Service takes over. */
export function ReceiptDialog({ orderId, onClose, primary }: { orderId: string | null; onClose: () => void; primary?: { label: string; onClick: () => void } }) {
  const r = useApi<Receipt>(orderId ? `/orders/${orderId}/receipt` : null);
  const qr = useReceiptQr(r.data?.qrToken);
  const d = r.data?.detail;
  return (
    <Dialog open={!!orderId} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[calc(100dvh-1rem)] sm:max-w-sm">
        <DialogHeader><DialogTitle>Receipt{d ? ` · ${orderNo(d.order)}` : ""}</DialogTitle></DialogHeader>
        {!r.data || !d ? <div className="h-80 rounded-xl skeleton-shimmer" /> : (
          <PrintedLines lines={receiptLines(r.data, qr)} className="max-h-[60vh]" />
        )}
        <DialogFooter>
          <Button variant="outline" className="h-12" disabled={!d} onClick={async () => {
            try { if (!(await printOrderReceipt(orderId!, false))) printReceiptArea(); else toast.success("Receipt sent to the printer."); }
            catch (e) { toast.error((e as Error).message); }
          }}><PrinterIcon /> Print</Button>
          <Button className="h-12" onClick={primary?.onClick ?? onClose}>{primary?.label ?? "Done"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
