"use client";

import { useEffect, useState } from "react";
import { ClipboardListIcon, CopyIcon, Loader2Icon, SendIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { api, useApi } from "@/lib/api";
import { cn, timeAgo } from "@/lib/utils";
import { fmtQty } from "@/lib/pos";
import { useSession } from "@/components/session";
import { useLiveEvent } from "@/components/live";
import { confirmDialog } from "@/components/confirm";
import { EmptyState, ErrorNote, LoadingRows, ObjectStatus, SearchField, TONE } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Line = { id: string; itemCode: string; itemName: string; unit: string | null; qty: number; requestedQty: number | null; delivered: number | null };
type Request = {
  id: string; number: string; storeCode: string; storeName: string; neededBy: string | null; note: string | null; requestedByName: string; requestedAt: string;
  approval: "waiting" | "approved" | "rejected" | "cancelled"; decidedByName: string | null; decisionNote: string | null;
  erpStatus: "none" | "pending" | "posted" | "failed"; erpDoc: string | null; delivery: "delivered" | "part" | "waiting" | null; lines: Line[];
};
type Item = { code: string; name: string; type: string; unit: string };
type Draft = { code: string; name: string; unit: string | null; qty: string };

const day = (d: string) => new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
const tomorrow = () => { const d = new Date(); d.setDate(d.getDate() + 1); return d.toISOString().slice(0, 10); };

/**
 * Stock requests (STR50): ask a store for any FACTS item. The request waits for the branch's request approver, who can change the
 * quantities; approved, it is posted in FACTS as an STR50 from the store to this branch, and each line then shows what the store sent.
 */
export function StockRequests() {
  const { can } = useSession();
  const asks = can("pos.sell") || can("kitchen.view");
  const list = useApi<{ enabled: boolean; location: string | null; approver: string | null; stores: { code: string; name: string }[]; requests: Request[] }>("/stock/requests?days=14");
  useLiveEvent(["stock.changed"], () => list.reload());
  const [store, setStore] = useState("");
  const [neededBy, setNeededBy] = useState(tomorrow);
  const [note, setNote] = useState("");
  const [lines, setLines] = useState<Draft[]>([]);
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  const [busy, setBusy] = useState(false);
  // Searches FACTS once typing pauses.
  useEffect(() => { const t = window.setTimeout(() => setTerm(q.trim()), 300); return () => window.clearTimeout(t); }, [q]);
  const found = useApi<Item[]>(term.length >= 2 ? `/stock/requests/items?q=${encodeURIComponent(term)}` : null);
  const d = list.data;
  const storeCode = store || (d?.stores.length === 1 ? d.stores[0].code : "");

  function add(i: Item) {
    setQ(""); setTerm("");
    if (lines.some((l) => l.code === i.code)) { toast.info(`${i.name} is already on the request.`); return; }
    setLines([...lines, { code: i.code, name: i.name, unit: i.unit, qty: "1" }]);
  }
  // Request again: the same store, items and quantities as an earlier request.
  function again(r: Request) {
    setStore(r.storeCode);
    setLines(r.lines.map((l) => ({ code: l.itemCode, name: l.itemName, unit: l.unit, qty: String(l.requestedQty ?? l.qty) })));
    setNote(""); setNeededBy(tomorrow());
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  const bad = lines.find((l) => !(Number(l.qty) > 0));
  async function send() {
    setBusy(true);
    try {
      const r = await api<{ number: string }>("/stock/requests", "POST", {
        storeCode, neededBy: neededBy || null, note: note.trim() || null, lines: lines.map((l) => ({ itemCode: l.code, qty: Number(l.qty) })),
      });
      toast.success(`${r.number} sent${d?.approver ? `, waiting for ${d.approver}` : ""}.`);
      setLines([]); setNote(""); list.reload();
    } catch (e) { toast.error((e as Error).message, { duration: 10000 }); } finally { setBusy(false); }
  }
  async function cancel(r: Request) {
    if (!(await confirmDialog({ title: `Cancel ${r.number}?`, message: "It hasn't been approved, so nothing went to FACTS.", confirmLabel: "Cancel request" }))) return;
    try { await api(`/stock/requests/${r.id}/cancel`, "POST"); list.reload(); } catch (e) { toast.error((e as Error).message); }
  }

  if (list.error) return <ErrorNote message={list.error} />;
  if (!d) return <LoadingRows rows={4} />;
  return (
    <div className="grid gap-4 md:grid-cols-[320px_minmax(0,1fr)] lg:grid-cols-[400px_minmax(0,1fr)] lg:gap-5">
      <section className="surface h-fit p-5" data-module="inv">
        <h2 className="mb-3 font-heading font-semibold">New request</h2>
        {!d.enabled ? <p className="text-sm text-muted-foreground">Requests need an approver: set this branch&apos;s request approver and their FACTS username (Companies &amp; branches).</p>
          : !d.stores.length ? <p className="text-sm text-muted-foreground">No stores to ask yet: an administrator adds them (Companies &amp; branches → the company → Request stores).</p>
          : !asks ? <p className="text-sm text-muted-foreground">Requests are made by the branch&apos;s staff.</p> : (
          <div className="grid gap-3">
            <label className="grid gap-1 text-xs font-medium text-muted-foreground">Store
              <select value={storeCode} onChange={(e) => setStore(e.target.value)} className="h-11 w-full rounded-xl border border-input bg-card px-3 text-sm text-foreground dark:bg-input/30">
                <option value="">Choose the store</option>
                {d.stores.map((s) => <option key={s.code} value={s.code}>{s.name} ({s.code})</option>)}
              </select>
            </label>
            <label className="grid gap-1 text-xs font-medium text-muted-foreground">Needed by
              <Input type="date" value={neededBy} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setNeededBy(e.target.value)} className="h-11" />
            </label>
            <div className="relative">
              <SearchField value={q} onChange={(e) => setQ(e.target.value)} placeholder="Add an item: code or name" className="w-full" />
              {term.length >= 2 && (found.data?.length || found.loading) ? (
                <div className="absolute inset-x-0 top-full z-10 mt-1 max-h-72 overflow-y-auto rounded-xl border bg-popover shadow-lg">
                  {found.loading && !found.data ? <div className="flex h-11 items-center gap-2 px-4 text-sm text-muted-foreground"><Loader2Icon className="size-4 animate-spin" /> Searching FACTS…</div>
                    : found.data!.map((i) => (
                      <button key={i.code} type="button" onClick={() => add(i)} className="flex min-h-11 w-full items-center justify-between gap-3 px-4 py-1.5 text-left text-sm hover:bg-muted">
                        <span className="min-w-0"><span className="block truncate">{i.name}</span><span className="font-mono text-xs text-muted-foreground">{i.code}</span></span>
                        <span className="shrink-0 text-xs text-muted-foreground">{i.unit}</span>
                      </button>
                    ))}
                </div>
              ) : null}
              <ErrorNote message={found.error} />
            </div>
            {lines.length > 0 && (
              <div className="max-h-[45dvh] divide-y overflow-y-auto rounded-xl border">
                {lines.map((l, i) => (
                  <div key={l.code} className="flex items-center gap-2 px-3 py-2">
                    <div className="min-w-0 flex-1"><div className="truncate text-sm font-medium">{l.name}</div><div className="font-mono text-xs text-muted-foreground">{l.code}</div></div>
                    <Input value={l.qty} inputMode="decimal" aria-label={`Quantity of ${l.name}`} onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, qty: e.target.value.replace(/[^\d.]/g, "") } : x))}
                      className={cn("h-10 w-20 text-right", !(Number(l.qty) > 0) && "border-danger")} />
                    <span className="w-9 text-xs text-muted-foreground">{l.unit?.toLowerCase()}</span>
                    <Button variant="ghost" size="icon" aria-label={`Take ${l.name} off`} onClick={() => setLines(lines.filter((_, j) => j !== i))}><XIcon /></Button>
                  </div>
                ))}
              </div>
            )}
            <Input value={note} maxLength={150} onChange={(e) => setNote(e.target.value)} placeholder="Note for the store (optional)" className="h-11" />
            <Button className="h-12" disabled={busy || !storeCode || !lines.length || !!bad} onClick={() => void send()}>
              {busy ? <Loader2Icon className="animate-spin" /> : <SendIcon />} Send for approval{lines.length ? ` · ${lines.length} item${lines.length === 1 ? "" : "s"}` : ""}
            </Button>
            <p className="text-xs text-muted-foreground">It waits for {d.approver}&apos;s approval; approved, it is posted in FACTS as a stock transfer request (STR50) to the store.</p>
          </div>
        )}
      </section>
      <section className="min-w-0">
        {d.requests.length ? (
          <div className="space-y-3">
            {d.requests.map((r) => <RequestCard key={r.id} r={r} onAgain={asks && d.enabled ? () => again(r) : undefined} onCancel={asks && r.approval === "waiting" ? () => void cancel(r) : undefined} />)}
          </div>
        ) : <EmptyState icon={ClipboardListIcon} title="No requests in the last 14 days" module="inv">{asks && d.enabled ? "Make one on the left." : "Requests appear here."}</EmptyState>}
      </section>
    </div>
  );
}

/** One request: where it stands, and per line what was asked, approved and (once posted) sent. */
function RequestCard({ r, onAgain, onCancel }: { r: Request; onAgain?: () => void; onCancel?: () => void }) {
  const status = r.approval === "waiting" ? <ObjectStatus className={TONE.warn}>Waiting for approval</ObjectStatus>
    : r.approval === "rejected" ? <ObjectStatus className={TONE.danger}>Rejected</ObjectStatus>
    : r.approval === "cancelled" ? <ObjectStatus className={TONE.muted}>Cancelled</ObjectStatus>
    : r.erpStatus === "pending" ? <ObjectStatus className={TONE.open}>Approved · posting to FACTS</ObjectStatus>
    : r.erpStatus === "failed" ? <ObjectStatus className={TONE.danger}>Approved · FACTS posting failed</ObjectStatus>
    : r.delivery === "delivered" ? <ObjectStatus className={TONE.done}>{r.erpDoc} · delivered</ObjectStatus>
    : r.delivery === "part" ? <ObjectStatus className={TONE.open}>{r.erpDoc} · part delivered</ObjectStatus>
    : <ObjectStatus className={TONE.done}>{r.erpDoc ?? "Posted"}</ObjectStatus>;
  return (
    <details className={cn("surface group", (r.approval === "cancelled" || r.approval === "rejected") && "opacity-70")}>
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-3 p-4">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground"><ClipboardListIcon className="size-5" /></span>
        <div className="min-w-0 flex-1">
          <div className="font-medium">{r.number} <span className="font-normal text-muted-foreground">from {r.storeName}</span></div>
          <div className="text-sm text-muted-foreground">
            {r.lines.length} item{r.lines.length === 1 ? "" : "s"}{r.neededBy ? ` · needed by ${day(r.neededBy)}` : ""} · {r.requestedByName}, {timeAgo(r.requestedAt)}{r.note ? ` · ${r.note}` : ""}
          </div>
          {r.approval === "rejected" && <div className="text-xs text-danger">Rejected by {r.decidedByName}: {r.decisionNote}</div>}
          {r.approval === "approved" && r.decisionNote && <div className="text-xs text-muted-foreground">{r.decidedByName}: {r.decisionNote}</div>}
        </div>
        {status}
      </summary>
      <div className="border-t px-4 pb-4 pt-2">
        <div className="divide-y text-sm">
          {r.lines.map((l) => (
            <div key={l.id} className="flex flex-wrap items-center gap-3 py-2">
              <div className="min-w-0 flex-1"><div className="truncate">{l.itemName}</div><div className="font-mono text-xs text-muted-foreground">{l.itemCode}</div></div>
              <span className="tabular-nums">{fmtQty(l.qty)} {l.unit?.toLowerCase()}</span>
              {l.requestedQty !== null && <span className="text-xs text-muted-foreground">asked {fmtQty(l.requestedQty)}</span>}
              {l.delivered !== null && <span className={cn("w-28 text-right text-xs tabular-nums", l.delivered >= l.qty ? "text-success" : l.delivered > 0 ? "text-warning" : "text-muted-foreground")}>sent {fmtQty(l.delivered)}</span>}
            </div>
          ))}
        </div>
        {(onAgain || onCancel) && (
          <div className="mt-3 flex flex-wrap gap-2">
            {onAgain && <Button variant="outline" className="h-10" onClick={onAgain}><CopyIcon /> Request again</Button>}
            {onCancel && <Button variant="outline" className="h-10 text-danger" onClick={onCancel}>Cancel request</Button>}
          </div>
        )}
      </div>
    </details>
  );
}
