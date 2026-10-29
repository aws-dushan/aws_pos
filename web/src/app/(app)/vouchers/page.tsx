"use client";

import { useEffect, useState } from "react";
import { BanIcon, GiftIcon, PlusIcon, PrinterIcon, StarIcon, TicketIcon } from "lucide-react";
import { toast } from "sonner";
import { api, newKey, useApi } from "@/lib/api";
import { cn, timeAgo } from "@/lib/utils";
import { fmtIn } from "@/lib/num";
import type { ReceiptLine } from "@/lib/device";
import { useSession } from "@/components/session";
import { printLines } from "@/components/shift";
import { EmptyState, ErrorNote, Field, LoadingRows, ObjectStatus, PageHeader, SearchField, Segmented, StatTile, TablePanel, TONE } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

type Reason = "goodwill" | "promotion" | "sold" | "refund";
type Voucher = {
  id: string; code: string; initialValue: number; balance: number; reason: Reason; status: "active" | "cancelled"; expiresOn: string | null;
  customerId: string | null; customerName: string | null; note: string | null; issuedByName: string | null; branchCode: string | null; issuedAt: string;
};
type Move = { kind: "issue" | "redeem" | "refund" | "cancel"; amount: number; at: string; by: string; orderNumber: number | null; branch: string | null; note: string | null };
type Rewards = {
  vouchersEnabled: boolean; loyaltyEnabled: boolean; pointsPerUnit: number; pointValue: number; minRedeem: number;
  members: number; outstanding: number; liability: number; openVouchers: number; voucherBalance: number;
};

const REASON_LABEL: Record<Reason, string> = { goodwill: "Goodwill", promotion: "Promotion", sold: "Sold", refund: "Store credit" };
const MOVE_LABEL: Record<Move["kind"], string> = { issue: "Issued", redeem: "Paid with", refund: "Given back", cancel: "Cancelled" };
const money = (n: number) => fmtIn(n, 2);
const today = () => new Date().toISOString().slice(0, 10);

function state(v: Voucher): { label: string; tone: string } {
  if (v.status === "cancelled") return { label: "Cancelled", tone: TONE.muted };
  if (v.balance <= 0) return { label: "Used up", tone: TONE.muted };
  if (v.expiresOn && v.expiresOn < today()) return { label: "Expired", tone: TONE.danger };
  return { label: v.balance < v.initialValue ? "Part used" : "Active", tone: TONE.done };
}

/** A voucher on the receipt printer: the code large, its value and expiry. */
function voucherLines(v: Voucher, company: string, currency: string): ReceiptLine[] {
  return [
    { text: company, align: "center", bold: true },
    { text: "GIFT VOUCHER", ar: "قسيمة هدية", align: "center", bold: true },
    { rule: true },
    { text: v.code, align: "center", bold: true, size: "large" },
    { text: `${currency} ${money(v.balance)}`, align: "center", bold: true, size: "large" },
    { rule: true },
    ...(v.customerName ? [{ text: `For ${v.customerName}` }] : []),
    { text: v.expiresOn ? `Valid until ${new Date(v.expiresOn).toLocaleDateString("en-GB")}` : "No expiry date" },
    { text: "Pay with it at any branch; what isn't spent stays on the code.", size: "small" },
    { text: `Issued ${new Date(v.issuedAt).toLocaleDateString("en-GB")}${v.branchCode ? ` · ${v.branchCode}` : ""}`, size: "small" },
  ];
}

/** Gift vouchers and loyalty (REQ CUS-02, CUS-03): issue, print and cancel vouchers; what's still owed on vouchers and points. */
export default function VouchersPage() {
  const { company, can } = useSession();
  const cur = company?.currency ?? "AED";
  const rewards = useApi<Rewards>("/rewards");
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  useEffect(() => { const t = window.setTimeout(() => setTerm(q.trim()), 250); return () => window.clearTimeout(t); }, [q]);
  const list = useApi<Voucher[]>(company?.vouchersEnabled ? `/vouchers${term ? `?q=${encodeURIComponent(term)}` : ""}` : null);
  const [issuing, setIssuing] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const manage = can("day.manage");
  const r = rewards.data;
  const reload = () => { list.reload(); rewards.reload(); };

  return (
    <div>
      <PageHeader title="Vouchers & loyalty" icon={GiftIcon} module="sales" count={list.data?.length}
        description="The gift vouchers and store credit this branch issued, and the points its customers collect. A voucher pays at any branch."
        actions={company?.vouchersEnabled && manage && <Button size="lg" onClick={() => setIssuing(true)}><PlusIcon /> Issue voucher</Button>} />
      <ErrorNote message={rewards.error} />
      <div className="mb-6 grid gap-3 sm:grid-cols-2 md:grid-cols-4">
        {company?.vouchersEnabled && <>
          <StatTile label="Open vouchers" value={r ? r.openVouchers : "…"} icon={TicketIcon} module="sales" hint="Active, with something left" />
          <StatTile label="Still to be spent" value={r ? `${cur} ${money(r.voucherBalance)}` : "…"} icon={GiftIcon} module="sales" hint="What open vouchers are worth" />
        </>}
        {company?.loyaltyEnabled && <>
          <StatTile label="Points held" value={r ? r.outstanding.toLocaleString() : "…"} icon={StarIcon} module="appr" hint={r ? `${r.members} customer${r.members === 1 ? "" : "s"} with points` : undefined} />
          <StatTile label="Points are worth" value={r ? `${cur} ${money(r.liability)}` : "…"} icon={StarIcon} module="appr"
            hint={r ? `${r.pointsPerUnit} point${r.pointsPerUnit === 1 ? "" : "s"} per ${cur} 1 spent · 1 point = ${cur} ${r.pointValue} · usable from ${r.minRedeem}` : undefined} />
        </>}
      </div>
      {company?.vouchersEnabled ? <>
        <SearchField value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search code or customer" className="mb-4 w-80 max-w-full" />
        <ErrorNote message={list.error} />
        {list.loading && !list.data ? <LoadingRows /> : list.data?.length ? (
          <TablePanel>
            <Table>
              <TableHeader><TableRow>
                <TableHead className="pl-5">Code</TableHead><TableHead>Kind</TableHead><TableHead>Customer</TableHead>
                <TableHead className="text-right">Value</TableHead><TableHead className="text-right">Left</TableHead><TableHead>Expires</TableHead><TableHead className="pr-5">Issued</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {list.data.map((v) => {
                  const s = state(v);
                  return (
                    <TableRow key={v.id} className="cursor-pointer" onClick={() => setOpen(v.id)}>
                      <TableCell className="pl-5"><span className="font-mono font-semibold tracking-wider">{v.code}</span> <ObjectStatus className={s.tone}>{s.label}</ObjectStatus></TableCell>
                      <TableCell className="text-muted-foreground">{REASON_LABEL[v.reason]}</TableCell>
                      <TableCell>{v.customerName ?? <span className="text-muted-foreground">—</span>}</TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">{cur} {money(v.initialValue)}</TableCell>
                      <TableCell className={cn("text-right font-medium tabular-nums", v.balance <= 0 && "text-muted-foreground")}>{cur} {money(v.balance)}</TableCell>
                      <TableCell className="text-muted-foreground">{v.expiresOn ? new Date(v.expiresOn).toLocaleDateString("en-GB") : "—"}</TableCell>
                      <TableCell className="pr-5 text-muted-foreground">{timeAgo(v.issuedAt)}{v.issuedByName ? ` · ${v.issuedByName}` : ""}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TablePanel>
        ) : (
          <EmptyState icon={GiftIcon} title={term ? "No voucher matches" : "No vouchers yet"} module="sales"
            action={manage && !term && <Button size="lg" onClick={() => setIssuing(true)}><PlusIcon /> Issue voucher</Button>}>
            {term ? `Nothing with “${term}” in its code or customer.` : "Issue one here, or refund an order as store credit."}
          </EmptyState>
        )}
      </> : (
        <p className="text-sm text-muted-foreground">Gift vouchers are off for {company?.name}. An administrator switches them on under Companies & branches.</p>
      )}
      <IssueDialog open={issuing} currency={cur} onClose={() => setIssuing(false)}
        onIssued={(v) => { reload(); setIssuing(false); setOpen(v.id); void printLines(voucherLines(v, company?.name ?? "", cur)); }} />
      <VoucherDialog id={open} currency={cur} companyName={company?.name ?? ""} canCancel={manage} onClose={() => setOpen(null)} onChanged={reload} />
    </div>
  );
}

function IssueDialog({ open, currency, onClose, onIssued }: { open: boolean; currency: string; onClose: () => void; onIssued: (v: Voucher) => void }) {
  const [f, setF] = useState({ value: "", reason: "goodwill" as Exclude<Reason, "refund">, expiresOn: "", note: "" });
  const [busy, setBusy] = useState(false);
  const [was, setWas] = useState(open);
  if (open !== was) { setWas(open); if (open) setF({ value: "", reason: "goodwill", expiresOn: "", note: "" }); }

  async function issue() {
    setBusy(true);
    try {
      const v = await api<Voucher>("/vouchers", "POST", { value: Number(f.value), reason: f.reason, expiresOn: f.expiresOn || null, note: f.note || null }, { key: newKey() });
      toast.success(`Voucher ${v.code} for ${currency} ${money(v.balance)} issued.`);
      onIssued(v);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Issue a gift voucher</DialogTitle>
          <DialogDescription>It gets its own code and prints on the receipt printer. It pays (part of) a bill at any branch.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <Field label={`Value (${currency})`} required><Input value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} inputMode="decimal" autoFocus /></Field>
          <div className="space-y-2">
            <span className="block text-[0.8rem] font-medium text-foreground/80">Why</span>
            <Segmented id="voucher-reason" value={f.reason} onChange={(v) => setF({ ...f, reason: v })} className="w-full"
              options={[{ value: "goodwill", label: "Goodwill" }, { value: "promotion", label: "Promotion" }, { value: "sold", label: "Sold" }]} />
            {f.reason === "sold" && <p className="text-xs text-warning">Take the money for a sold voucher at the till as an order; this only makes the code.</p>}
          </div>
          <Field label="Valid until" hint="Leave empty for no expiry."><Input type="date" min={today()} value={f.expiresOn} onChange={(e) => setF({ ...f, expiresOn: e.target.value })} /></Field>
          <Field label="Note"><Input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="e.g. cold food complaint, table 4" /></Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={busy || !(Number(f.value) > 0)} onClick={() => void issue()}><GiftIcon /> Issue {f.value ? `${currency} ${money(Number(f.value) || 0)}` : ""}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function VoucherDialog({ id, currency, companyName, canCancel, onClose, onChanged }: {
  id: string | null; currency: string; companyName: string; canCancel: boolean; onClose: () => void; onChanged: () => void;
}) {
  const d = useApi<{ voucher: Voucher; moves: Move[] }>(id ? `/vouchers/${id}` : null);
  const v = d.data?.voucher;
  const [busy, setBusy] = useState(false);

  async function cancel() {
    if (!v || !window.confirm(`Cancel voucher ${v.code}? Its ${currency} ${money(v.balance)} can't be used after this.`)) return;
    setBusy(true);
    try {
      await api(`/vouchers/${v.id}/cancel`, "POST", {});
      toast.success(`Voucher ${v.code} cancelled.`);
      d.reload();
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const s = v ? state(v) : null;
  return (
    <Dialog open={!!id} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><span className="font-mono tracking-wider">{v?.code ?? "Voucher"}</span> {s && <ObjectStatus className={s.tone}>{s.label}</ObjectStatus>}</DialogTitle>
          <DialogDescription>
            {v ? `${REASON_LABEL[v.reason]} · ${currency} ${money(v.balance)} left of ${money(v.initialValue)}${v.expiresOn ? ` · valid until ${new Date(v.expiresOn).toLocaleDateString("en-GB")}` : ""}${v.customerName ? ` · ${v.customerName}` : ""}` : "Loading…"}
          </DialogDescription>
        </DialogHeader>
        {v?.note && <p className="rounded-xl bg-muted/50 px-3 py-2 text-sm">{v.note}</p>}
        <div className="divide-y rounded-xl border">
          {(d.data?.moves ?? []).map((m, i) => (
            <div key={i} className="flex items-center gap-3 px-3 py-2.5 text-sm">
              <div className="min-w-0 flex-1">
                <div className="font-medium">{MOVE_LABEL[m.kind]}{m.orderNumber ? ` · order #${m.orderNumber}` : ""}{m.branch ? ` · ${m.branch}` : ""}</div>
                <div className="text-xs text-muted-foreground">{new Date(m.at).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })} · {m.by}</div>
              </div>
              <span className={cn("font-medium tabular-nums", m.amount < 0 ? "text-danger" : "text-success")}>{m.amount < 0 ? "−" : "+"}{money(Math.abs(m.amount))}</span>
            </div>
          ))}
          {!d.data && <div className="h-24 skeleton-shimmer" />}
        </div>
        <DialogFooter>
          {v && canCancel && v.status === "active" && v.balance > 0 && (
            <Button variant="ghost" className="mr-auto text-danger" disabled={busy} onClick={() => void cancel()}><BanIcon /> Cancel voucher</Button>
          )}
          <Button variant="outline" onClick={onClose}>Close</Button>
          {v && v.status === "active" && v.balance > 0 && <Button onClick={() => void printLines(voucherLines(v, companyName, currency))}><PrinterIcon /> Print</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
