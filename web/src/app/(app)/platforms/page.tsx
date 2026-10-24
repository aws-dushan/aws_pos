"use client";

import { useState } from "react";
import { BikeIcon, HandCoinsIcon, LandmarkIcon, PercentIcon, PlusIcon, ReceiptTextIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { api, useApi } from "@/lib/api";
import { cn } from "@/lib/utils";
import { fmtIn } from "@/lib/num";
import { useSession } from "@/components/session";
import { useLiveEvent } from "@/components/live";
import { EmptyState, ErrorNote, Field, LoadingRows, PageHeader, Segmented, StatTile, TablePanel } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

type SummaryRow = { id: string; name: string; rate: number; feeRate: number; orders: number; sales: number; refunded: number; net: number; commission: number; bankFee: number; owed: number; payout: number;
  received: number | null; stillOwed: number | null };
type Summary = { from: string; to: string; payoutsEnabled: boolean; items: SummaryRow[];
  totals: { orders: number; net: number; commission: number; bankFee: number; owed: number; payout: number; received: number | null; stillOwed: number | null } };
type Payout = { id: string; platformId: string; platformName: string; receivedOn: string; periodFrom: string | null; periodTo: string | null; amount: number; commission: number; bankFee: number;
  reference: string | null; note: string | null; recordedByName: string | null };
const day = (s: string) => new Date(s + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** The delivery platform report: over business days, what each platform's orders sold, its commission, and what it owes. */
export default function PlatformReportPage() {
  const { company, can } = useSession();
  const cur = company?.currency ?? "AED";
  const today = iso(new Date());
  const [from, setFrom] = useState(() => { const d = new Date(); d.setDate(1); return iso(d); });
  const [to, setTo] = useState(today);
  const [scope, setScope] = useState<"branch" | "all">("branch");
  const summary = useApi<Summary>(`/platforms/summary?from=${from}&to=${to}${scope === "all" ? "&all=true" : ""}`);
  const on = !!summary.data?.payoutsEnabled;
  const payouts = useApi<Payout[]>(on ? `/platforms/payouts?from=${from}&to=${to}` : null);
  useLiveEvent(["order.changed", "platforms.changed"], () => { summary.reload(); payouts.reload(); });
  const [recording, setRecording] = useState(false);
  const canRecord = can("branch.manage") || can("day.manage");
  const t = summary.data?.totals;

  async function takeOff(p: Payout) {
    if (!window.confirm(`Take off the ${p.platformName} payout of ${cur} ${fmtIn(p.amount, 2)}?`)) return;
    try {
      await api(`/platforms/payouts/${p.id}/void`, "POST", {});
      toast.success("Payout taken off.");
      summary.reload(); payouts.reload();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <div>
      <PageHeader title="Delivery platform report" icon={BikeIcon} module="bank"
        description="Orders from Talabat, Deliveroo and the others: sales, their commission, and what each platform owes the outlet. Platforms are set up under Administration."
        actions={on && canRecord && <Button size="lg" onClick={() => setRecording(true)}><PlusIcon /> Record payout</Button>} />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <label className="grid gap-1 text-xs font-medium text-muted-foreground">From<Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className="h-10 w-40" /></label>
        <label className="grid gap-1 text-xs font-medium text-muted-foreground">To<Input type="date" value={to} min={from} max={today} onChange={(e) => setTo(e.target.value)} className="h-10 w-40" /></label>
        <Segmented id="plat-scope" value={scope} onChange={setScope} options={[{ value: "branch", label: "This branch" }, { value: "all", label: "All branches" }]} />
      </div>
      <div className="mb-5 grid gap-3 sm:grid-cols-2 md:grid-cols-4">
        <StatTile label="Platform orders" value={t ? t.orders : "…"} icon={ReceiptTextIcon} module="bank" hint={t ? `${cur} ${fmtIn(t.net, 2)} after refunds` : undefined} />
        <StatTile label="Owed by the platforms" value={t ? `${cur} ${fmtIn(t.owed, 2)}` : "…"} icon={HandCoinsIcon} module="bank" hint="Paid by the platform at the register" />
        <StatTile label="Commission + bank fee" value={t ? `${cur} ${fmtIn(t.commission + t.bankFee, 2)}` : "…"} icon={PercentIcon} module="bank" hint={t ? `${fmtIn(t.commission, 2)} commission + ${fmtIn(t.bankFee, 2)} bank fee, at each order's rates` : undefined} />
        <StatTile label="Expected payout" value={t ? `${cur} ${fmtIn(t.payout, 2)}` : "…"} icon={HandCoinsIcon} module="bank" tone="success" hint="Owed less commission and bank fee" />
      </div>
      {on && t && (
        <div className="mb-5 grid gap-3 sm:grid-cols-2">
          <StatTile label="Received in these days" value={`${cur} ${fmtIn(t.received ?? 0, 2)}`} icon={LandmarkIcon} module="bank" hint="Payouts recorded, by date received" />
          <StatTile label="Still owed by the platforms" value={`${cur} ${fmtIn(t.stillOwed ?? 0, 2)}`} icon={HandCoinsIcon} module="bank" tone={(t.stillOwed ?? 0) > 0 ? "warn" : "default"}
            hint="All branches, to date: owed less payouts and the commission and bank fee they kept" />
        </div>
      )}
      <ErrorNote message={summary.error} />
      {summary.loading && !summary.data ? <LoadingRows rows={3} /> : summary.data?.items.length ? (
        <TablePanel>
          <Table>
            <TableHeader><TableRow>
              <TableHead className="pl-5">Platform</TableHead><TableHead className="text-right">Orders</TableHead><TableHead className="text-right">Sales</TableHead>
              <TableHead className="text-right">Refunds</TableHead><TableHead className="text-right">Commission</TableHead><TableHead className="text-right">Bank fee</TableHead><TableHead className="text-right">Owed</TableHead>
              <TableHead className={cn("text-right", !on && "pr-5")}>Payout</TableHead>
              {on && <><TableHead className="text-right">Received</TableHead><TableHead className="pr-5 text-right">Still owed</TableHead></>}
            </TableRow></TableHeader>
            <TableBody>
              {summary.data.items.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="pl-5"><span className="font-medium">{r.name}</span> <span className="text-xs text-muted-foreground">{r.rate}%{r.feeRate ? ` + ${r.feeRate}%` : ""}</span></TableCell>
                  <TableCell className="text-right tabular-nums">{r.orders}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtIn(r.sales, 2)}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{r.refunded ? `−${fmtIn(r.refunded, 2)}` : "—"}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{fmtIn(r.commission, 2)}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{fmtIn(r.bankFee, 2)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtIn(r.owed, 2)}</TableCell>
                  <TableCell className={cn("text-right font-medium tabular-nums", !on && "pr-5")}>{fmtIn(r.payout, 2)}</TableCell>
                  {on && <>
                    <TableCell className="text-right tabular-nums">{fmtIn(r.received ?? 0, 2)}</TableCell>
                    <TableCell className={cn("pr-5 text-right font-medium tabular-nums", (r.stillOwed ?? 0) > 0 && "text-warning")}>{fmtIn(r.stillOwed ?? 0, 2)}</TableCell>
                  </>}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TablePanel>
      ) : (
        <EmptyState icon={BikeIcon} title="No delivery platforms yet" module="bank" compact>
          An administrator adds them under Administration → Delivery platforms.
        </EmptyState>
      )}
      {on && (
        <section className="mt-6">
          <h2 className="mb-3 font-heading text-[0.95rem] font-semibold">Payouts received</h2>
          {payouts.data?.length ? (
            <TablePanel>
              <Table>
                <TableHeader><TableRow>
                  <TableHead className="pl-5">Received</TableHead><TableHead>Platform</TableHead><TableHead>Period</TableHead><TableHead>Reference</TableHead>
                  <TableHead className="text-right">Amount</TableHead><TableHead className="text-right">Commission kept</TableHead><TableHead className="text-right">Bank fee kept</TableHead><TableHead className="pr-5" />
                </TableRow></TableHeader>
                <TableBody>
                  {payouts.data.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell className="pl-5">{day(p.receivedOn)}</TableCell>
                      <TableCell className="font-medium">{p.platformName}</TableCell>
                      <TableCell className="text-muted-foreground">{p.periodFrom && p.periodTo ? `${day(p.periodFrom)} – ${day(p.periodTo)}` : "—"}</TableCell>
                      <TableCell className="text-muted-foreground">{p.reference ?? "—"}{p.note ? ` · ${p.note}` : ""}</TableCell>
                      <TableCell className="text-right font-medium tabular-nums">{fmtIn(p.amount, 2)}</TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">{fmtIn(p.commission, 2)}</TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">{fmtIn(p.bankFee, 2)}</TableCell>
                      <TableCell className="pr-5 text-right">
                        {canRecord && <Button variant="ghost" size="icon" aria-label="Take off this payout" onClick={() => void takeOff(p)}><Trash2Icon /></Button>}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TablePanel>
          ) : <p className="text-sm text-muted-foreground">No payouts recorded in these days.</p>}
        </section>
      )}
      <PayoutDialog open={recording} platforms={(summary.data?.items ?? []).map((i) => ({ id: i.id, name: i.name, rate: i.rate }))} currency={cur}
        onClose={() => setRecording(false)} onSaved={() => { summary.reload(); payouts.reload(); }} />
    </div>
  );
}

/** A payout from a platform: what reached the bank, the commission it kept (from its statement), and the statement's reference. */
function PayoutDialog({ open, platforms, currency, onClose, onSaved }: {
  open: boolean; platforms: { id: string; name: string; rate: number }[]; currency: string; onClose: () => void; onSaved: () => void;
}) {
  const blank = { platformId: "", receivedOn: iso(new Date()), periodFrom: "", periodTo: "", amount: "", commission: "", bankFee: "", reference: "", note: "" };
  const [f, setF] = useState(blank);
  const [was, setWas] = useState(open);
  const [busy, setBusy] = useState(false);
  if (open !== was) { setWas(open); if (open) setF({ ...blank, platformId: platforms[0]?.id ?? "" }); }
  const set = (k: keyof typeof blank, v: string) => setF((x) => ({ ...x, [k]: v }));

  async function save() {
    setBusy(true);
    try {
      await api("/platforms/payouts", "POST", {
        platformId: f.platformId, receivedOn: f.receivedOn, periodFrom: f.periodFrom || null, periodTo: f.periodTo || null,
        amount: Number(f.amount), commission: Number(f.commission || 0), bankFee: Number(f.bankFee || 0), reference: f.reference || null, note: f.note || null,
      });
      toast.success("Payout recorded.");
      onSaved();
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[calc(100dvh-1rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Record a platform payout</DialogTitle>
          <DialogDescription>From the platform&apos;s statement: what reached the bank, and the commission and bank fee it kept. Together they clear what it owed.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Platform" required span>
            <Segmented id="payout-platform" value={f.platformId} onChange={(v) => set("platformId", v)} className="w-full"
              options={platforms.map((p) => ({ value: p.id, label: p.name }))} />
          </Field>
          <Field label="Received on" required><Input type="date" value={f.receivedOn} onChange={(e) => set("receivedOn", e.target.value)} /></Field>
          <Field label="Statement reference"><Input value={f.reference} onChange={(e) => set("reference", e.target.value)} placeholder="e.g. TLB-STM-0412" /></Field>
          <Field label={`Amount received (${currency})`} required><Input value={f.amount} inputMode="decimal" onChange={(e) => set("amount", e.target.value)} /></Field>
          <Field label={`Commission kept (${currency})`}><Input value={f.commission} inputMode="decimal" onChange={(e) => set("commission", e.target.value)} /></Field>
          <Field label={`Bank fee kept (${currency})`}><Input value={f.bankFee} inputMode="decimal" onChange={(e) => set("bankFee", e.target.value)} /></Field>
          <Field label="Orders from"><Input type="date" value={f.periodFrom} max={f.periodTo || undefined} onChange={(e) => set("periodFrom", e.target.value)} /></Field>
          <Field label="Orders to"><Input type="date" value={f.periodTo} min={f.periodFrom || undefined} onChange={(e) => set("periodTo", e.target.value)} /></Field>
          <Field label="Note" span><Input value={f.note} onChange={(e) => set("note", e.target.value)} placeholder="e.g. includes a 15.00 marketing fee" /></Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={busy || !f.platformId || !(Number(f.amount) > 0) || !f.receivedOn} onClick={() => void save()}><LandmarkIcon /> Record payout</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
