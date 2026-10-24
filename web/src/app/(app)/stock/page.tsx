"use client";

import { useMemo, useState } from "react";
import { AlertTriangleIcon, CheckCircle2Icon, PackageIcon, PackageOpenIcon, SendIcon, Trash2Icon, TruckIcon, Undo2Icon } from "lucide-react";
import { toast } from "sonner";
import { api, useApi } from "@/lib/api";
import { cn, timeAgo } from "@/lib/utils";
import { fmtIn } from "@/lib/num";
import { fmtQty, type Menu, type MenuItem } from "@/lib/pos";
import { useSession } from "@/components/session";
import { useLiveEvent } from "@/components/live";
import { confirmDialog } from "@/components/confirm";
import { EmptyState, ErrorNote, LoadingRows, ObjectStatus, PageHeader, SearchField, Segmented, TONE } from "@/components/kit";
import { Numpad } from "@/components/numpad";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

type Waste = {
  id: string; itemId: string; name: string; qty: number; unit: string | null; reason: Reason; note: string | null; costValue: number | null;
  erpStatus: "none" | "pending" | "draft" | "posted" | "failed"; erpDoc: string | null; recordedByName: string; recordedAt: string; voidedAt: string | null;
  approval: "none" | "waiting" | "approved" | "rejected"; requestedQty: number | null; decisionNote: string | null; decidedByName: string | null;
};
/** Transfers to the branch's wastage location in FACTS (read-only): finance's, or One POS' drafts once posted. */
type Moves = {
  linked: boolean; location: string | null; wasteLocation: string | null; matched: number;
  moves: { docType: string; docNo: string; date: string; posted: boolean; lines: { line: number; code: string; name: string; qty: number; unit: string | null; batch: string | null; matched: string | null }[] }[];
};
type Reason = "expired" | "damaged" | "quality" | "returned" | "staff" | "calibration" | "other";
type Delivery = {
  docType: string; docNo: string; date: string; from: string; fromName: string | null; narration: string | null; totalQty: number; posted: boolean;
  /** `line`: the line on the transfer; an item can be on it twice (e.g. two batches). */
  lines: { line: number; code: string; name: string; qty: number; unit: string | null }[];
  check: { by: string; at: string; allOk: boolean; differences: { line?: number | null; code: string; name: string; sent: number; received: number; note: string | null }[] | null; note: string | null } | null;
  /** What goes back against it (its difference, by itself; returns from the Returns tab) to where it came from. */
  returns: Return[];
};
type Return = {
  id: string; source: "variance" | "manual"; line?: number; itemName: string; qty: number; requestedQty: number | null; unit: string | null; reason: ReturnReason; note: string | null; toLocation: string;
  recordedByName: string; recordedAt: string; approval: "waiting" | "approved" | "rejected" | "cancelled"; decidedByName: string | null; decisionNote: string | null;
  erpStatus: "none" | "pending" | "posted" | "failed"; erpDoc: string | null;
};
type ReturnReason = "short" | "excess" | "damaged" | "wrong" | "quality" | "expiry" | "other";
const RETURN_REASONS: Record<ReturnReason, string> = { short: "Short delivered", excess: "Not needed", damaged: "Damaged", wrong: "Wrong item", quality: "Quality", expiry: "Near expiry", other: "Other" };
/** The reasons chosen on the Returns tab ("short delivered" is a delivery's own difference). */
const PICK_REASONS = (Object.keys(RETURN_REASONS) as ReturnReason[]).filter((r) => r !== "short");

const REASONS: Record<Reason, string> = { expired: "Expired", damaged: "Damaged", quality: "Quality", returned: "Customer return", staff: "Staff meal", calibration: "Machine calibration", other: "Other" };
const money = (n: number) => fmtIn(n, 2);

/** Branch stock (REQ INV-04, INV-06): record wastage; check in deliveries sent to this branch in the ERP. */
export default function StockPage() {
  const { company } = useSession();
  const [tab, setTab] = useState<"waste" | "deliveries" | "returns">("waste");
  return (
    <div className="mx-auto max-w-[1100px] pb-8">
      <PageHeader title="Stock" icon={PackageIcon} module="inv"
        description="What's thrown away, what arrives, and what goes back. Stock on hand shows on the register and Menu from the ERP."
        actions={<Segmented id="stock-tab" value={tab} onChange={setTab} options={[{ value: "waste", label: "Wastage", icon: Trash2Icon }, { value: "deliveries", label: "Deliveries", icon: TruckIcon }, { value: "returns", label: "Returns", icon: Undo2Icon }]} />} />
      {tab === "waste" ? <Wastage currency={company?.currency ?? "AED"} /> : tab === "deliveries" ? <Deliveries /> : <Returns />}
    </div>
  );
}

function Wastage({ currency }: { currency: string }) {
  const { can } = useSession();
  // The branch's staff record wastage; finance reads it (any day) and notes the FACTS document once posted there.
  const records = can("pos.sell") || can("kitchen.view");
  const finance = can("day.manage") || can("facts.post");
  const [day, setDay] = useState("");
  const list = useApi<{ date: string; wastage: Waste[]; byReason: { reason: Reason; lines: number; value: number }[]; total: number; erpLinked: boolean; factsWastage: "finance" | "draft"; approver: string | null }>(`/stock/wastage${day ? `?date=${day}` : ""}`);
  // What's moved to the wastage location in FACTS; reading it also marks lines posted (matched, or drafts finance has posted).
  const moves = useApi<Moves>("/stock/wastage/moves?days=7");
  useLiveEvent(["stock.changed"], () => moves.reload());
  const menu = useApi<Menu>(records ? "/pos/menu" : null);
  useLiveEvent(["stock.changed"], () => list.reload());
  const [q, setQ] = useState("");
  const [item, setItem] = useState<MenuItem | null>(null);
  const found = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? (menu.data?.items ?? []).filter((i) => i.name.toLowerCase().includes(t) || (i.erpItemCode ?? "").includes(t)).slice(0, 8) : [];
  }, [menu.data, q]);
  const d = list.data;

  // Finance posted it in FACTS: the document number is kept with it.
  async function posted(w: Waste) {
    const doc = window.prompt(`FACTS document for ${fmtQty(w.qty)} × ${w.name} (e.g. STV50 8114):`);
    if (!doc?.trim()) return;
    try { await api(`/stock/wastage/${w.id}/posted`, "POST", { doc: doc.trim() }); toast.success("Noted as posted in FACTS."); list.reload(); }
    catch (e) { toast.error((e as Error).message); }
  }

  async function sendNow() {
    try {
      const r = await api<{ lines: number }>("/stock/wastage/send", "POST", { date: d?.date ?? null });
      toast.success(`${r.lines} wastage ${r.lines === 1 ? "entry goes" : "entries go"} to FACTS now, in one draft transfer.`);
      list.reload();
    } catch (e) { toast.error((e as Error).message); }
  }

  async function undo(w: Waste) {
    if (!(await confirmDialog({ title: `Take off ${fmtQty(w.qty)} × ${w.name}?`, confirmLabel: "Take off" }))) return;
    try { await api(`/stock/wastage/${w.id}/void`, "POST"); list.reload(); } catch (e) { toast.error((e as Error).message); }
  }

  return (
    <div className="grid gap-4 md:grid-cols-[280px_minmax(0,1fr)] lg:grid-cols-[360px_minmax(0,1fr)] lg:gap-5">
      <section className="surface h-fit p-5" data-module="inv">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="font-heading font-semibold">{records ? "Record wastage" : "Wastage"}</h2>
          <Input type="date" aria-label="Day" value={day || d?.date || ""} onChange={(e) => setDay(e.target.value)} className="h-9 w-40" />
        </div>
        {records && <div className="relative">
          <SearchField value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find the item" className="w-full" />
          {found.length > 0 && (
            <div className="absolute inset-x-0 top-full z-10 mt-1 overflow-hidden rounded-xl border bg-popover shadow-lg">
              {found.map((i) => (
                <button key={i.id} type="button" onClick={() => { setItem(i); setQ(""); }} className="flex h-11 w-full items-center justify-between gap-3 px-4 text-left text-sm hover:bg-muted">
                  <span className="truncate">{i.name}</span>{i.erpStock !== null && <span className="shrink-0 text-xs text-muted-foreground">{fmtQty(i.erpStock)} in stock</span>}
                </button>
              ))}
            </div>
          )}
        </div>}
        <p className="mt-3 text-sm text-muted-foreground">{!d?.erpLinked ? "Kept for the day's records."
          : d.approver ? `Each entry waits for ${d.approver}'s approval. Approved, it is posted in FACTS straight away: a transfer to the wastage location, batches oldest first.`
          : d.factsWastage === "draft" ? "The day's wastage goes to FACTS as one draft transfer to the wastage location at the day's close (night); finance gives the batches and posts it there."
            : "Kept for the day's records. Finance posts it in FACTS (a transfer to the outlet's wastage location, by FIFO batch); it's matched here by itself."}</p>
        {d?.factsWastage === "draft" && finance && d.wastage.some((w) => w.erpStatus === "pending" && !w.voidedAt) && (
          <Button variant="outline" className="mt-3 h-10 w-full" onClick={() => void sendNow()}><SendIcon /> Send waiting wastage to FACTS now</Button>
        )}
        {d && d.byReason.length > 0 && (
          <div className="mt-5 border-t pt-4">
            <div className="mb-2 text-xs font-medium text-muted-foreground">{day && day !== d.date ? d.date : "This day"}</div>
            {d.byReason.map((r) => <div key={r.reason} className="flex justify-between text-sm"><span>{REASONS[r.reason]} · {r.lines}</span><span className="tabular-nums">{money(r.value)}</span></div>)}
            <div className="mt-1 flex justify-between border-t pt-1 text-sm font-semibold"><span>Total</span><span className="tabular-nums">{currency} {money(d.total)}</span></div>
          </div>
        )}
      </section>

      <section>
        <ErrorNote message={list.error} />
        {!d ? <LoadingRows rows={4} /> : d.wastage.length ? (
          <div className="surface divide-y">
            {d.wastage.map((w) => (
              <div key={w.id} className={cn("flex flex-wrap items-center gap-3 px-4 py-3", w.voidedAt && "opacity-50")}>
                <span className="w-16 font-heading font-semibold tabular-nums">{fmtQty(w.qty)}<span className="ml-1 text-xs font-normal text-muted-foreground">{w.unit?.toLowerCase()}</span></span>
                <div className="min-w-0 flex-1">
                  <div className={cn("truncate font-medium", w.voidedAt && "line-through")}>{w.name}</div>
                  <div className="truncate text-xs text-muted-foreground">{REASONS[w.reason]}{w.note ? ` · ${w.note}` : ""} · {w.recordedByName} · {timeAgo(w.recordedAt)}</div>
                  {w.approval === "rejected" && <div className="truncate text-xs text-danger">Rejected by {w.decidedByName}: {w.decisionNote}</div>}
                  {w.approval === "approved" && w.requestedQty !== null && <div className="truncate text-xs text-muted-foreground">Approved {fmtQty(w.qty)} of {fmtQty(w.requestedQty)} by {w.decidedByName}</div>}
                </div>
                {w.approval === "waiting" && !w.voidedAt && <ObjectStatus className={TONE.warn}>Waiting for approval</ObjectStatus>}
                {w.approval === "approved" && w.erpStatus === "pending" && <ObjectStatus className={TONE.open}>Approved · posting to FACTS</ObjectStatus>}
                {w.approval === "approved" && w.erpStatus === "failed" && <ObjectStatus className={TONE.danger}>Approved · FACTS posting failed</ObjectStatus>}
                {w.approval === "rejected" && <ObjectStatus className={TONE.danger}>Rejected</ObjectStatus>}
                {w.approval === "none" && w.erpStatus === "pending" && !w.voidedAt && <ObjectStatus className={TONE.draft}>{d.factsWastage === "draft" ? "To FACTS tonight" : "For finance"}</ObjectStatus>}
                {w.erpStatus === "draft" && !w.voidedAt && <ObjectStatus className={TONE.warn}>Draft in FACTS · {w.erpDoc}</ObjectStatus>}
                {w.approval === "none" && w.erpStatus === "pending" && !w.voidedAt && finance && d.factsWastage !== "draft" && (
                  <Button variant="outline" size="sm" onClick={() => void posted(w)}>Posted in FACTS…</Button>
                )}
                {w.erpStatus === "posted" && <ObjectStatus className={TONE.done}>{w.erpDoc ?? "Posted"}</ObjectStatus>}
                <span className="w-20 text-right tabular-nums text-muted-foreground">{w.costValue !== null ? money(w.costValue) : "—"}</span>
                {records && !w.voidedAt && w.approval !== "approved" && (w.erpStatus === "pending" || w.erpStatus === "none") && <Button variant="ghost" size="icon" aria-label="Take off" onClick={() => void undo(w)}><Undo2Icon /></Button>}
              </div>
            ))}
          </div>
        ) : <EmptyState icon={Trash2Icon} title="Nothing thrown away this day" module="inv">{records ? "Find an item on the left to record wastage." : "Pick another day on the left."}</EmptyState>}

        {/* What's moved to the wastage location in FACTS (last 7 days). */}
        {moves.data?.linked && (
          <div className="mt-5">
            <h3 className="mb-2 text-sm font-semibold">Moved to {moves.data.wasteLocation} in FACTS <span className="font-normal text-muted-foreground">· last 7 days</span></h3>
            {moves.data.moves.length ? (
              <div className="surface divide-y">
                {moves.data.moves.map((m) => (
                  <div key={`${m.docType}-${m.docNo}`} className="px-4 py-3">
                    <div className="flex items-center gap-2 text-sm">
                      <span className="font-medium">{m.docType} {m.docNo}</span>
                      <span className="text-muted-foreground">{new Date(m.date).toLocaleDateString("en-GB")}</span>
                      <ObjectStatus className={m.posted ? TONE.done : TONE.warn}>{m.posted ? "Posted" : "Not posted yet"}</ObjectStatus>
                    </div>
                    {m.lines.map((l) => (
                      <div key={l.line} className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
                        <span className="w-10 tabular-nums">{fmtQty(l.qty)} {l.unit?.toLowerCase()}</span>
                        <span className="min-w-0 flex-1 truncate">{l.name}</span>
                        {l.batch && <span className="font-mono">{l.batch}</span>}
                        {l.matched && <span className="text-success">matched</span>}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            ) : <p className="text-sm text-muted-foreground">Nothing moved there in the last 7 days.</p>}
          </div>
        )}
        {moves.data && !moves.data.linked && moves.data.location && (
          <p className="mt-4 text-xs text-muted-foreground">Set this branch&apos;s wastage location (Companies &amp; branches) to see what finance moved there in FACTS.</p>
        )}
      </section>

      <WasteDialog item={item} onClose={() => setItem(null)} onDone={() => { setItem(null); list.reload(); }} />
    </div>
  );
}

function WasteDialog({ item, onClose, onDone }: { item: MenuItem | null; onClose: () => void; onDone: () => void }) {
  const [qty, setQty] = useState("1");
  const [reason, setReason] = useState<Reason>("expired");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [seen, setSeen] = useState<string | null>(null);
  if ((item?.id ?? null) !== seen) { setSeen(item?.id ?? null); setQty("1"); setReason("expired"); setNote(""); }
  async function save() {
    setBusy(true);
    try { await api("/stock/wastage", "POST", { itemId: item!.id, qty: Number(qty), reason, note: note || null }); toast.success(`${qty} × ${item!.name} recorded as wastage`); onDone(); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Dialog open={!!item} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Wastage · {item?.name}</DialogTitle>
          <DialogDescription>How much was thrown away{item?.erpUnit ? `, in ${item.erpUnit.toLowerCase()}` : ""}, and why?</DialogDescription>
        </DialogHeader>
        <div className="rounded-xl border bg-muted/50 px-4 py-3 text-right font-heading text-3xl font-semibold tabular-nums">{qty || "0"}</div>
        <Numpad value={qty} onChange={setQty} decimals={item?.qtyDecimals ?? 0} max={7}
          onEnter={() => { if (!busy && Number(qty) > 0 && !(reason === "other" && !note.trim())) void save(); }} />
        <div className="flex flex-wrap gap-2">
          {(Object.keys(REASONS) as Reason[]).map((r) => (
            <button key={r} type="button" onClick={() => setReason(r)}
              className={cn("h-10 rounded-full border px-4 text-sm active:scale-[0.97]", reason === r ? "border-primary bg-primary/10 font-medium text-primary" : "bg-card hover:bg-muted")}>{REASONS[r]}</button>
          ))}
        </div>
        <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder={reason === "other" ? "What happened (needed)" : "Note (optional)"} className="h-11" />
        <DialogFooter>
          <Button variant="outline" className="h-12" onClick={onClose}>Cancel</Button>
          <Button className="h-12 min-w-36" disabled={busy || !(Number(qty) > 0) || (reason === "other" && !note.trim())} onClick={() => void save()}><Trash2Icon /> Record</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Deliveries() {
  const { can } = useSession();
  const checks = can("pos.sell") || can("kitchen.view");
  const [days, setDays] = useState<"3" | "7" | "30">("7");
  const list = useApi<{ linked: boolean; location: string | null; returnApprover: string | null; deliveries: Delivery[];
    requests: { docType: string; docNo: string; typeName: string | null; date: string; fromName: string | null; from: string; narration: string | null; totalQty: number; items: number }[] }>(`/stock/deliveries?days=${days}`);
  useLiveEvent(["stock.changed"], () => list.reload());
  const [checking, setChecking] = useState<Delivery | null>(null);
  const d = list.data;
  if (list.error) return <ErrorNote message={list.error} />;
  if (!d) return <LoadingRows rows={4} />;
  if (!d.linked) return <EmptyState icon={TruckIcon} title="No ERP stock location" module="inv">Deliveries show here once this branch has its ERP stock location (Companies &amp; branches).</EmptyState>;
  return (
    <div>
      <div className="mb-4 flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">Transfers into {d.location} in the ERP. Check each one in when it arrives.</p>
        <Segmented id="del-days" value={days} onChange={setDays} options={[{ value: "3", label: "3 days" }, { value: "7", label: "7 days" }, { value: "30", label: "30 days" }]} />
      </div>
      {d.deliveries.length ? (
        <div className="space-y-3">
          {d.deliveries.map((x) => (
            <div key={`${x.docType}-${x.docNo}`} className="surface flex flex-wrap items-center gap-4 p-4">
              <span className={cn("flex size-11 items-center justify-center rounded-xl", x.check ? (x.check.allOk ? "bg-success/12 text-success" : "bg-warning/12 text-warning") : "bg-muted text-muted-foreground")}>
                {x.check ? (x.check.allOk ? <CheckCircle2Icon className="size-5" /> : <AlertTriangleIcon className="size-5" />) : <PackageOpenIcon className="size-5" />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="font-medium">{x.docType} {x.docNo} <span className="font-normal text-muted-foreground">from {x.fromName ?? x.from}</span></div>
                <div className="text-sm text-muted-foreground">
                  {new Date(x.date).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} · {x.lines.length} item{x.lines.length === 1 ? "" : "s"} · {fmtQty(x.totalQty)} in all
                  {x.narration ? ` · ${x.narration}` : ""}
                </div>
                {x.check && <div className="text-xs text-muted-foreground">Checked by {x.check.by} {timeAgo(x.check.at)}{x.check.allOk ? " · as sent" : ` · ${x.check.differences?.length ?? 0} difference(s)`}</div>}
              </div>
              {(checks || x.check) && <Button variant={x.check ? "outline" : "default"} className="h-11" onClick={() => setChecking(x)}>{x.check ? "View" : "Check in"}</Button>}
              {x.returns.some((r) => r.source === "variance" && r.approval !== "cancelled") && (
                <div className="w-full divide-y rounded-xl border text-sm">
                  {x.returns.filter((r) => r.source === "variance" && r.approval !== "cancelled").map((r) => <ReturnLine key={r.id} r={r} />)}
                </div>
              )}
            </div>
          ))}
        </div>
      ) : <EmptyState icon={TruckIcon} title="No deliveries in these days" module="inv">Transfers into {d.location} appear here.</EmptyState>}
      {d.requests.length > 0 && (
        <details className="mt-6">
          <summary className="cursor-pointer text-sm font-medium text-muted-foreground">Orders placed ({d.requests.length} {d.requests[0].typeName?.toLowerCase() ?? "requests"}) · no stock moves until they&apos;re sent</summary>
          <div className="surface mt-2 divide-y">
            {d.requests.map((r) => (
              <div key={`${r.docType}-${r.docNo}`} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
                <span className="font-mono text-xs text-muted-foreground">{r.docType} {r.docNo}</span>
                <span className="min-w-0 flex-1 truncate">{r.narration ?? "—"}</span>
                <span className="text-muted-foreground">{r.items} items · {fmtQty(r.totalQty)}</span>
                <span className="text-muted-foreground">{new Date(r.date).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</span>
              </div>
            ))}
          </div>
        </details>
      )}
      <CheckDialog delivery={checking} approver={d.returnApprover} onClose={() => setChecking(null)} onDone={() => { setChecking(null); list.reload(); }} />
    </div>
  );
}

/** One return: how much of what goes back where, why, and where it stands. */
function ReturnLine({ r, onCancel }: { r: Return; onCancel?: () => void }) {
  return (
    <div className={cn("flex flex-wrap items-center gap-3 px-3 py-2 text-sm", (r.approval === "cancelled" || r.approval === "rejected") && "opacity-60")}>
      <Undo2Icon className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{fmtQty(r.qty)} {r.unit?.toLowerCase()} {r.itemName} <span className="font-normal text-muted-foreground">back to {r.toLocation}</span></div>
        <div className="truncate text-xs text-muted-foreground">{RETURN_REASONS[r.reason]}{r.note ? ` · ${r.note}` : ""} · {r.recordedByName} · {timeAgo(r.recordedAt)}</div>
        {r.approval === "rejected" && <div className="truncate text-xs text-danger">Rejected by {r.decidedByName}: {r.decisionNote}</div>}
        {r.approval === "approved" && r.requestedQty !== null && <div className="truncate text-xs text-muted-foreground">Approved {fmtQty(r.qty)} of {fmtQty(r.requestedQty)} by {r.decidedByName}</div>}
      </div>
      {r.approval === "waiting" && <ObjectStatus className={TONE.warn}>Waiting for approval</ObjectStatus>}
      {r.approval === "approved" && r.erpStatus === "pending" && <ObjectStatus className={TONE.open}>Approved · posting to FACTS</ObjectStatus>}
      {r.approval === "approved" && r.erpStatus === "failed" && <ObjectStatus className={TONE.danger}>Approved · FACTS posting failed</ObjectStatus>}
      {r.erpStatus === "posted" && <ObjectStatus className={TONE.done}>{r.erpDoc ?? "Posted"}</ObjectStatus>}
      {r.approval === "rejected" && <ObjectStatus className={TONE.danger}>Rejected</ObjectStatus>}
      {r.approval === "cancelled" && <ObjectStatus className={TONE.muted}>Cancelled</ObjectStatus>}
      {onCancel && r.approval === "waiting" && <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>}
    </div>
  );
}

/**
 * Check a delivery in: what was received per line, at most what was delivered. Whatever is short goes back by itself to where the
 * delivery came from, waiting for the approver.
 */
function CheckDialog({ delivery: x, approver, onClose, onDone }: { delivery: Delivery | null; approver: string | null; onClose: () => void; onDone: () => void }) {
  const { can } = useSession();
  const [got, setGot] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [seen, setSeen] = useState<string | null>(null);
  const key = x ? `${x.docType}-${x.docNo}` : null;
  if (key !== seen) {
    setSeen(key);
    // Earlier checks noted a difference by item code only: those still find their line.
    const diffs = x?.check?.differences ?? [];
    const prior = (l: Delivery["lines"][number]) => diffs.find((dd) => dd.line === l.line) ?? diffs.find((dd) => dd.line == null && dd.code === l.code);
    setGot(Object.fromEntries((x?.lines ?? []).map((l) => [l.line, String(prior(l)?.received ?? l.qty)])));
    setNote(x?.check?.note ?? "");
  }
  if (!x) return null;
  // Checked in already: a view of what was received. To count it again a manager undoes the check-in first.
  const viewing = !!x.check;
  const rec = (l: Delivery["lines"][number]) => Number(got[l.line] ?? l.qty);
  const short = x.lines.filter((l) => rec(l) < l.qty);
  const over = x.lines.find((l) => rec(l) > l.qty);
  async function save() {
    try {
      const r = await api<{ differences: number; returned: number; notReturned: string | null }>("/stock/deliveries/check", "POST", {
        docType: x!.docType, docNo: x!.docNo, allOk: short.length === 0, note: note || null,
        differences: x!.lines.map((l) => ({ line: l.line, code: l.code, name: l.name, sent: l.qty, received: rec(l) || 0, note: null })),
      });
      if (r.notReturned) toast.warning(`Checked in with ${r.differences} short. ${r.notReturned}`, { duration: 12000 });
      else toast.success(r.returned ? `Checked in. ${r.returned} short item${r.returned === 1 ? "" : "s"} go${r.returned === 1 ? "es" : ""} back to ${x!.from}${approver ? `, waiting for ${approver}` : ""}.` : "Checked in: everything as sent");
      onDone();
    } catch (e) { toast.error((e as Error).message, { duration: 10000 }); }
  }
  // Checked in by mistake: a manager undoes it (One POS's record only; FACTS is untouched) and it can be checked in again.
  async function undo() {
    const reason = window.prompt(`Undo the check-in of ${x!.docType} ${x!.docNo}? Say why (e.g. checked in by mistake):`)?.trim();
    if (!reason) return;
    try {
      await api("/stock/deliveries/uncheck", "POST", { docType: x!.docType, docNo: x!.docNo, reason });
      toast.success(`${x!.docType} ${x!.docNo} is not checked in any more`);
      onDone();
    } catch (e) { toast.error((e as Error).message); }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{x.docType} {x.docNo} · from {x.fromName ?? x.from}</DialogTitle>
          <DialogDescription>
            {viewing
              ? `Checked in by ${x.check!.by} ${timeAgo(x.check!.at)}${x.check!.allOk ? ", everything as sent." : "."}${can("day.manage") ? " To count it again, undo the check-in first." : ""}`
              : `Enter what was received. Anything short goes back to ${x.from} by itself${approver ? `, once ${approver} approves it` : ""}.`}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[50dvh] divide-y overflow-y-auto rounded-xl border">
          {x.lines.map((l) => (
            <div key={l.line} className="flex items-center gap-3 px-3 py-2">
              <div className="min-w-0 flex-1"><div className="truncate text-sm font-medium">{l.name}</div><div className="font-mono text-xs text-muted-foreground">{l.code}</div></div>
              <span className="text-xs text-muted-foreground">delivered {fmtQty(l.qty)} {l.unit?.toLowerCase()}</span>
              {viewing
                ? <span className={cn("w-24 text-right text-sm tabular-nums", rec(l) < l.qty && "font-medium text-warning")}>received {fmtQty(rec(l))}</span>
                : <Input value={got[l.line] ?? ""} onChange={(e) => setGot({ ...got, [l.line]: e.target.value.replace(/[^\d.]/g, "") })} inputMode="decimal" aria-label={`Received ${l.name}, line ${l.line}`}
                    className={cn("h-10 w-20 text-right", rec(l) > l.qty ? "border-danger text-danger" : rec(l) < l.qty && "border-warning text-warning")} />}
            </div>
          ))}
        </div>
        {over ? <p className="text-sm text-danger">{over.name}: at most the {fmtQty(over.qty)} delivered can be received.</p>
          : short.length > 0 && <p className="text-sm text-warning">{short.map((l) => `${fmtQty(l.qty - rec(l))} ${l.unit?.toLowerCase() ?? ""} ${l.name}`.replace(/\s+/g, " ")).join(", ")} {viewing ? "short: sent back" : "go back"} to {x.from}.</p>}
        {viewing
          ? x.check!.note && <p className="text-sm">Note: {x.check!.note}</p>
          : <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (e.g. two boxes damaged)" className="h-11" />}
        <DialogFooter>
          {viewing && can("day.manage") && <Button variant="outline" className="h-11 sm:mr-auto" onClick={() => void undo()}>Undo check-in</Button>}
          <Button variant={viewing ? "default" : "outline"} className="h-11" onClick={onClose}>Close</Button>
          {!viewing && <Button className="h-11 min-w-40" disabled={!!over} onClick={() => void save()}>{short.length ? `Check in · ${short.length} short` : "Check in · all as sent"}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type Returnable = { code: string; name: string; type: string | null; unit: string | null; docType: string; docNo: string; line: number; from: string; fromName: string | null; date: string };

/** Returns: an item delivered here goes back to where its latest delivery came from, once the approver approves it. */
function Returns() {
  const { can } = useSession();
  const records = can("pos.sell") || can("kitchen.view");
  const list = useApi<{ linked: boolean; location: string | null; canReturn: boolean; approver: string | null; returns: Return[] }>("/stock/returns?days=30");
  const items = useApi<Returnable[]>(records ? "/stock/returns/items" : null);
  useLiveEvent(["stock.changed"], () => list.reload());
  const [q, setQ] = useState("");
  const [item, setItem] = useState<Returnable | null>(null);
  const found = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? (items.data ?? []).filter((i) => i.name.toLowerCase().includes(t) || i.code.includes(t)).slice(0, 8) : [];
  }, [items.data, q]);
  const d = list.data;
  async function cancel(r: Return) {
    if (!(await confirmDialog({ title: `Cancel the return of ${fmtQty(r.qty)} × ${r.itemName}?`, confirmLabel: "Cancel return" }))) return;
    try { await api(`/stock/returns/${r.id}/cancel`, "POST"); list.reload(); } catch (e) { toast.error((e as Error).message); }
  }
  if (list.error) return <ErrorNote message={list.error} />;
  if (!d) return <LoadingRows rows={4} />;
  if (!d.linked) return <EmptyState icon={Undo2Icon} title="No ERP stock location" module="inv">Returns work once this branch has its ERP stock location (Companies &amp; branches).</EmptyState>;
  return (
    <div className="grid gap-4 md:grid-cols-[280px_minmax(0,1fr)] lg:grid-cols-[360px_minmax(0,1fr)] lg:gap-5">
      <section className="surface h-fit p-5" data-module="inv">
        <h2 className="mb-3 font-heading font-semibold">Return an item</h2>
        {records && d.canReturn && <div className="relative">
          <SearchField value={q} onChange={(e) => setQ(e.target.value)} placeholder={items.loading && !items.data ? "Reading deliveries from FACTS…" : "Find the item"} className="w-full" />
          {found.length > 0 && (
            <div className="absolute inset-x-0 top-full z-10 mt-1 overflow-hidden rounded-xl border bg-popover shadow-lg">
              {found.map((i) => (
                <button key={i.code} type="button" onClick={() => { setItem(i); setQ(""); }} className="flex h-11 w-full items-center justify-between gap-3 px-4 text-left text-sm hover:bg-muted">
                  <span className="truncate">{i.name}</span><span className="shrink-0 text-xs text-muted-foreground">from {i.from}</span>
                </button>
              ))}
            </div>
          )}
        </div>}
        <ErrorNote message={items.error} />
        <p className="mt-3 text-sm text-muted-foreground">{d.canReturn
          ? `An item goes back to where its latest delivery came from. It waits for ${d.approver}'s approval; approved, it is posted in FACTS straight away as a transfer, batches oldest first.`
          : "Returns need an approver: set this branch's wastage approver and their FACTS username (Companies & branches)."}</p>
        <p className="mt-2 text-xs text-muted-foreground">Short deliveries go back by themselves when a delivery is checked in (Deliveries).</p>
      </section>
      <section>
        {d.returns.length ? (
          <div className="surface divide-y">
            {d.returns.map((r) => <ReturnLine key={r.id} r={r} onCancel={records && r.source === "manual" ? () => void cancel(r) : undefined} />)}
          </div>
        ) : <EmptyState icon={Undo2Icon} title="Nothing sent back in the last 30 days" module="inv">{records ? "Find an item on the left to send it back." : "Returns appear here."}</EmptyState>}
      </section>
      <ReturnItemDialog item={item} approver={d.approver} onClose={() => setItem(null)} onDone={() => { setItem(null); list.reload(); }} />
    </div>
  );
}

function ReturnItemDialog({ item, approver, onClose, onDone }: { item: Returnable | null; approver: string | null; onClose: () => void; onDone: () => void }) {
  const [qty, setQty] = useState("1");
  const [reason, setReason] = useState<ReturnReason>("excess");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [seen, setSeen] = useState<string | null>(null);
  if ((item?.code ?? null) !== seen) { setSeen(item?.code ?? null); setQty("1"); setReason("excess"); setNote(""); }
  const ok = Number(qty) > 0 && !(reason === "other" && !note.trim());
  async function save() {
    setBusy(true);
    try {
      await api("/stock/returns", "POST", { itemCode: item!.code, qty: Number(qty), reason, note: note || null });
      toast.success(`${qty} × ${item!.name} goes back to ${item!.from}${approver ? `, waiting for ${approver}` : ""}.`);
      onDone();
    } catch (e) { toast.error((e as Error).message, { duration: 10000 }); } finally { setBusy(false); }
  }
  return (
    <Dialog open={!!item} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Return · {item?.name}</DialogTitle>
          <DialogDescription>Back to {item?.fromName ?? item?.from} ({item?.from}), where {item?.docType} {item?.docNo} came from. How much{item?.unit ? `, in ${item.unit.toLowerCase()}` : ""}, and why?</DialogDescription>
        </DialogHeader>
        <div className="rounded-xl border bg-muted/50 px-4 py-3 text-right font-heading text-3xl font-semibold tabular-nums">{qty || "0"}</div>
        <Numpad value={qty} onChange={setQty} decimals={3} max={7} onEnter={() => { if (!busy && ok) void save(); }} />
        <div className="flex flex-wrap gap-2">
          {PICK_REASONS.map((r) => (
            <button key={r} type="button" onClick={() => setReason(r)}
              className={cn("h-10 rounded-full border px-4 text-sm active:scale-[0.97]", reason === r ? "border-primary bg-primary/10 font-medium text-primary" : "bg-card hover:bg-muted")}>{RETURN_REASONS[r]}</button>
          ))}
        </div>
        <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder={reason === "other" ? "Why it goes back (needed)" : "Note (optional)"} className="h-11" />
        <DialogFooter>
          <Button variant="outline" className="h-12" onClick={onClose}>Cancel</Button>
          <Button className="h-12 min-w-40" disabled={busy || !ok} onClick={() => void save()}><Undo2Icon /> Send for approval</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
