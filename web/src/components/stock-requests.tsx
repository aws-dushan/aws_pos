"use client";

import { useEffect, useState } from "react";
import { ClipboardListIcon, CopyIcon, Loader2Icon, PencilIcon, SaveIcon, SendIcon, XIcon } from "lucide-react";
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
  approval: "draft" | "waiting" | "approved" | "rejected" | "cancelled"; decidedByName: string | null; decisionNote: string | null;
  erpStatus: "none" | "pending" | "posted" | "failed"; erpDoc: string | null; remindedAt: string | null; delivery: "delivered" | "part" | "waiting" | null; lines: Line[];
};
type Item = { code: string; name: string; type: string; unit: string };
type Draft = { code: string; name: string; unit: string | null; qty: string };

const day = (d: string) => new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
const tomorrow = () => { const d = new Date(); d.setDate(d.getDate() + 1); return d.toISOString().slice(0, 10); };

/**
 * Stock requests (STR50): ask a store for any FACTS item. The request waits for the branch's request approver, who can change the
 * quantities; approved, it is posted in FACTS as an STR50 from the store to this branch, and each line then shows what the store sent.
 * A pre-approved branch skips the approver: sent, it is posted at once. A request can be saved as a draft first and sent later.
 */
export function StockRequests() {
  const { can } = useSession();
  const asks = can("pos.sell") || can("kitchen.view");
  const list = useApi<{ enabled: boolean; location: string | null; approver: string | null; preapproved: boolean; stores: { code: string; name: string }[]; requests: Request[] }>("/stock/requests?days=14");
  useLiveEvent(["stock.changed"], () => list.reload());
  const [store, setStore] = useState("");
  const [neededBy, setNeededBy] = useState(tomorrow);
  const [note, setNote] = useState("");
  const [lines, setLines] = useState<Draft[]>([]);
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  const [busy, setBusy] = useState(false);
  // The draft being changed (null: a new request).
  const [editing, setEditing] = useState<Request | null>(null);
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
    setNote(""); setNeededBy(tomorrow()); setEditing(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  // A draft back on the left, to change and save or send.
  function open(r: Request) {
    setEditing(r); setStore(r.storeCode); setNote(r.note ?? ""); setNeededBy(r.neededBy ?? tomorrow());
    setLines(r.lines.map((l) => ({ code: l.itemCode, name: l.itemName, unit: l.unit, qty: String(l.qty) })));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function clear() { setEditing(null); setLines([]); setNote(""); setNeededBy(tomorrow()); }
  const bad = lines.find((l) => !(Number(l.qty) > 0));
  async function save(draft: boolean) {
    const storeName = d?.stores.find((s) => s.code === storeCode)?.name ?? storeCode;
    const items = `${lines.length} item${lines.length === 1 ? "" : "s"}`;
    if (!draft && d?.preapproved && !(await confirmDialog({
      title: `Send ${items} to ${storeName}?`, message: "It goes to FACTS straight away as a stock transfer request (STR50) and can't be changed after.", confirmLabel: "Send request",
    }))) return;
    setBusy(true);
    try {
      const body = { storeCode, neededBy: neededBy || null, note: note.trim() || null, lines: lines.map((l) => ({ itemCode: l.code, qty: Number(l.qty) })), draft };
      const r = editing ? await api<{ number: string }>(`/stock/requests/${editing.id}`, "PUT", body) : await api<{ number: string }>("/stock/requests", "POST", body);
      toast.success(draft ? `${r.number} saved as a draft.` : d?.preapproved ? `${r.number} sent to ${storeName}; posting in FACTS.` : `${r.number} sent${d?.approver ? `, waiting for ${d.approver}` : ""}.`);
      clear(); list.reload();
    } catch (e) { toast.error((e as Error).message, { duration: 10000 }); } finally { setBusy(false); }
  }
  async function cancel(r: Request) {
    const draft = r.approval === "draft";
    if (!(await confirmDialog(draft ? { title: `Delete draft ${r.number}?`, message: "It was never sent, so nothing went to FACTS.", confirmLabel: "Delete draft" }
      : { title: `Cancel ${r.number}?`, message: "It hasn't been approved, so nothing went to FACTS.", confirmLabel: "Cancel request" }))) return;
    try { await api(`/stock/requests/${r.id}/cancel`, "POST"); if (editing?.id === r.id) clear(); list.reload(); } catch (e) { toast.error((e as Error).message); }
  }

  if (list.error) return <ErrorNote message={list.error} />;
  if (!d) return <LoadingRows rows={4} />;
  return (
    <div className="grid gap-4 md:grid-cols-[320px_minmax(0,1fr)] lg:grid-cols-[400px_minmax(0,1fr)] lg:gap-5">
      <section className="surface h-fit p-5" data-module="inv">
        <div className="mb-3 flex items-center gap-2">
          <h2 className="min-w-0 flex-1 font-heading font-semibold">{editing ? `Draft ${editing.number}` : "New request"}</h2>
          {editing && <Button variant="ghost" className="h-9" onClick={clear}>New instead</Button>}
        </div>
        {!d.enabled ? <p className="text-sm text-muted-foreground">Requests aren&apos;t set up: set this branch&apos;s request approver (or pre-approval) and the FACTS username (Companies &amp; branches).</p>
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
            <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-2">
              <Button variant="outline" className="h-12" disabled={busy || !storeCode || !lines.length || !!bad} onClick={() => void save(true)}><SaveIcon /> Save draft</Button>
              <Button className="h-12" disabled={busy || !storeCode || !lines.length || !!bad} onClick={() => void save(false)}>
                {busy ? <Loader2Icon className="animate-spin" /> : <SendIcon />} Send request{lines.length ? ` · ${lines.length} item${lines.length === 1 ? "" : "s"}` : ""}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {d.preapproved ? "Pre-approved: sent, it is posted in FACTS at once as a stock transfer request (STR50) to the store."
                : `It waits for ${d.approver}'s approval; approved, it is posted in FACTS as a stock transfer request (STR50) to the store.`}
              {" "}A draft goes nowhere until it is sent.
            </p>
          </div>
        )}
      </section>
      <section className="min-w-0">
        {d.requests.length ? (
          <div className="space-y-3">
            {d.requests.map((r) => <RequestCard key={r.id} r={r} onAgain={asks && d.enabled && r.approval !== "draft" ? () => again(r) : undefined}
                onOpen={asks && d.enabled && r.approval === "draft" ? () => open(r) : undefined}
                onCancel={asks && (r.approval === "waiting" || r.approval === "draft") ? () => void cancel(r) : undefined} />)}
          </div>
        ) : <EmptyState icon={ClipboardListIcon} title="No requests in the last 14 days" module="inv">{asks && d.enabled ? "Make one on the left." : "Requests appear here."}</EmptyState>}
      </section>
    </div>
  );
}

/** One request: where it stands, and per line what was asked, approved and (once posted) sent. */
function RequestCard({ r, onAgain, onOpen, onCancel }: { r: Request; onAgain?: () => void; onOpen?: () => void; onCancel?: () => void }) {
  // Sent at a pre-approved branch: approved by whoever sent it.
  const pre = r.approval === "approved" && r.decisionNote === "Pre-approved";
  const status = r.approval === "draft" ? <ObjectStatus className={TONE.muted}>Draft · not sent</ObjectStatus>
    : r.approval === "waiting" ? <ObjectStatus className={TONE.warn}>{r.remindedAt ? "Waiting · reminder sent" : "Waiting for approval"}</ObjectStatus>
    : r.approval === "rejected" ? <ObjectStatus className={TONE.danger}>Rejected</ObjectStatus>
    : r.approval === "cancelled" ? <ObjectStatus className={TONE.muted}>Cancelled</ObjectStatus>
    : r.erpStatus === "pending" ? <ObjectStatus className={TONE.open}>{pre ? "Sent" : "Approved"} · posting to FACTS</ObjectStatus>
    : r.erpStatus === "failed" ? <ObjectStatus className={TONE.danger}>{pre ? "Sent" : "Approved"} · FACTS posting failed</ObjectStatus>
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
          {r.approval === "approved" && r.decisionNote && !pre && <div className="text-xs text-muted-foreground">{r.decidedByName}: {r.decisionNote}</div>}
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
        {(onAgain || onOpen || onCancel) && (
          <div className="mt-3 flex flex-wrap gap-2">
            {onOpen && <Button className="h-10" onClick={onOpen}><PencilIcon /> Open draft</Button>}
            {onAgain && <Button variant="outline" className="h-10" onClick={onAgain}><CopyIcon /> Request again</Button>}
            {onCancel && <Button variant="outline" className="h-10 text-danger" onClick={onCancel}>{r.approval === "draft" ? "Delete draft" : "Cancel request"}</Button>}
          </div>
        )}
      </div>
    </details>
  );
}
