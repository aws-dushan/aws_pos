"use client";

import { useState } from "react";
import { CheckIcon, ClipboardListIcon, Loader2Icon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { api, useApi } from "@/lib/api";
import { cn, timeAgo } from "@/lib/utils";
import { fmtQty } from "@/lib/pos";
import { useLiveEvent } from "@/components/live";
import { promptReason } from "@/components/confirm";
import { ErrorNote, FieldGroup } from "@/components/kit";
import { Button } from "@/components/ui/button";

type Waiting = {
  id: string; number: string; branchName: string; storeCode: string; storeName: string; neededBy: string | null; note: string | null; requestedByName: string; requestedAt: string;
  lines: { id: string; itemCode: string; itemName: string; unit: string | null; qty: number; atOutlet: number | null; atStore: number | null }[];
};
type Line = Waiting["lines"][number];

/** Waiting past 12 hours (when reminders go to the approver): how long, in red. */
const hoursSince = (at: string) => Math.floor((Date.now() - new Date(at).getTime()) / 3_600_000);
export function Overdue({ at }: { at: string }) {
  const h = hoursSince(at);
  return h >= 12 ? <span className="font-medium text-danger"> · waiting {h} h</span> : null;
}

/**
 * Stock requests waiting for me (the branches I approve requests for), chosen like wastage: tick the requests, then approve or
 * reject them together. Quantities can be changed first (0 takes a line off); approved, each request is posted in FACTS at once as
 * an STR50 from the store to the branch. Rejected: nothing goes to FACTS.
 */
export function RequestsApprovals() {
  const list = useApi<{ isApprover: boolean; items: Waiting[] }>("/requests/approvals");
  useLiveEvent(["stock.changed"], () => list.reload());
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [qty, setQty] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const items = list.data?.items ?? [];
  if ((!list.data?.isApprover || items.length === 0) && !list.error) return null;
  const chosen = items.filter((r) => picked.has(r.id));
  const toggle = (id: string) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const q = (l: Line) => qty[l.id] ?? String(l.qty);
  const bad = chosen.find((r) => r.lines.some((l) => q(l).trim() === "" || !(Number(q(l)) >= 0)) || r.lines.every((l) => !(Number(q(l)) > 0)));

  // All together: those of the same branch and store go to FACTS as one STR50 (their lines one after another).
  async function approve() {
    setBusy("approve");
    try {
      await api("/requests/approvals/approve", "POST", { requests: chosen.map((r) => ({ id: r.id, lines: r.lines.map((l) => ({ id: l.id, qty: Number(q(l)) })) })), note: null });
      const strs = new Set(chosen.map((r) => `${r.branchName}|${r.storeCode}`)).size;
      toast.success(`Approved ${chosen.length}. Posting to FACTS now as ${strs} stock transfer request${strs === 1 ? "" : "s"} (STR50).`);
      setPicked(new Set()); setQty({}); list.reload();
    } catch (e) { toast.error((e as Error).message, { duration: 12000 }); } finally { setBusy(null); }
  }
  async function reject() {
    const note = await promptReason({ title: `Reject ${chosen.length} request${chosen.length === 1 ? "" : "s"}?`, confirmLabel: "Reject", tone: "danger", reason: { label: "Why", placeholder: "The branch sees this" } });
    if (!note) return;
    setBusy("reject");
    const failed: string[] = [];
    for (const r of chosen)
      try { await api(`/requests/approvals/${r.id}/reject`, "POST", { note }); }
      catch (e) { failed.push(`${r.number}: ${(e as Error).message}`); }
    if (chosen.length > failed.length) toast.success("Rejected. Nothing goes to FACTS.");
    if (failed.length) toast.error(failed.join("\n"), { duration: 12000 });
    setPicked(new Set()); setBusy(null); list.reload();
  }

  return (
    <FieldGroup title={`Stock requests to approve (${items.length})`} className="mb-5 p-4"
      description="What a branch asks a store for. Tick the requests, change a quantity where needed (0 takes the line off), then approve or reject them together. Approved, they are posted in FACTS straight away: one stock transfer request (STR50) per branch and store, with all their lines.">
      <ErrorNote message={list.error} />
      <div className="space-y-3">
        {items.map((r) => (
          <div key={r.id} className={cn("rounded-xl border", picked.has(r.id) && "border-primary/40 bg-primary/5")}>
            <label className="flex cursor-pointer flex-wrap items-center gap-3 border-b px-3 py-2.5">
              <input type="checkbox" className="size-5 accent-[var(--primary)]" checked={picked.has(r.id)} onChange={() => toggle(r.id)} />
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><ClipboardListIcon className="size-4" /></span>
              <div className="min-w-0 flex-1">
                <div className="font-medium">{r.number} · {r.branchName} <span className="font-normal text-muted-foreground">from {r.storeName} ({r.storeCode})</span></div>
                <div className="text-xs text-muted-foreground">
                  {r.requestedByName}, {timeAgo(r.requestedAt)}<Overdue at={r.requestedAt} />{r.neededBy ? ` · needed by ${new Date(r.neededBy).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}` : ""}{r.note ? ` · ${r.note}` : ""}
                </div>
              </div>
              <span className="text-xs text-muted-foreground">{r.lines.length} item{r.lines.length === 1 ? "" : "s"}</span>
            </label>
            <div className="divide-y">
              <div className="hidden gap-3 px-3 py-1.5 text-xs text-muted-foreground sm:flex">
                <span className="flex-1">Item</span><span className="w-20 text-right">At branch</span><span className="w-20 text-right">At store</span><span className="w-30 text-right">Quantity</span>
              </div>
              {r.lines.map((l) => (
                <div key={l.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                  <div className="min-w-0 flex-1"><div className="truncate text-sm font-medium">{l.itemName}</div><div className="font-mono text-xs text-muted-foreground">{l.itemCode}</div></div>
                  <span className="w-20 text-right text-xs tabular-nums text-muted-foreground">{l.atOutlet === null ? "—" : fmtQty(l.atOutlet)}</span>
                  <span className="w-20 text-right text-xs tabular-nums text-muted-foreground">{l.atStore === null ? "—" : fmtQty(l.atStore)}</span>
                  <div className="flex w-30 items-center justify-end gap-2">
                    <input inputMode="decimal" aria-label={`Quantity of ${l.itemName}`} value={q(l)} onChange={(e) => setQty({ ...qty, [l.id]: e.target.value.replace(/[^\d.]/g, "") })}
                      className={cn("h-10 w-20 rounded-lg border border-input bg-card px-2 text-right text-sm tabular-nums", Number(q(l)) !== l.qty && "border-warning")} />
                    <span className="w-8 text-xs text-muted-foreground">{l.unit?.toLowerCase()}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="outline" className="h-11" onClick={() => setPicked(picked.size === items.length ? new Set() : new Set(items.map((r) => r.id)))}>
          {picked.size === items.length ? "Clear" : "Select all"}
        </Button>
        <span className="flex-1 text-sm text-muted-foreground">
          {bad ? `${bad.number}: every quantity needs a number, and at least one above 0 (or reject it).` : chosen.length ? `${chosen.length} selected` : "Select the requests to decide."}
        </span>
        <Button variant="outline" className="h-11 text-danger" disabled={!chosen.length || !!busy} onClick={() => void reject()}>
          {busy === "reject" ? <Loader2Icon className="animate-spin" /> : <XIcon />} Reject
        </Button>
        <Button className="h-11" disabled={!chosen.length || !!busy || !!bad} onClick={() => void approve()}>
          {busy === "approve" ? <Loader2Icon className="animate-spin" /> : <CheckIcon />} Approve and post to FACTS
        </Button>
      </div>
    </FieldGroup>
  );
}
