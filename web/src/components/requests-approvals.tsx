"use client";

import { useState } from "react";
import { CheckIcon, ClipboardListIcon, Loader2Icon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { api, useApi } from "@/lib/api";
import { timeAgo } from "@/lib/utils";
import { fmtQty } from "@/lib/pos";
import { useLiveEvent } from "@/components/live";
import { promptReason } from "@/components/confirm";
import { ErrorNote, FieldGroup } from "@/components/kit";
import { Button } from "@/components/ui/button";

type Waiting = {
  id: string; number: string; branchName: string; storeCode: string; storeName: string; neededBy: string | null; note: string | null; requestedByName: string; requestedAt: string;
  lines: { id: string; itemCode: string; itemName: string; unit: string | null; qty: number; atOutlet: number | null; atStore: number | null }[];
};

/**
 * Stock requests waiting for me (the branches I approve requests for). Quantities can be changed (0 takes a line off); approved, the
 * request is posted in FACTS at once as an STR50 from the store to the branch. Rejected: nothing goes to FACTS.
 */
export function RequestsApprovals() {
  const list = useApi<{ isApprover: boolean; items: Waiting[] }>("/requests/approvals");
  useLiveEvent(["stock.changed"], () => list.reload());
  const items = list.data?.items ?? [];
  if ((!list.data?.isApprover || items.length === 0) && !list.error) return null;
  return (
    <FieldGroup title={`Stock requests to approve (${items.length})`} className="mb-5 p-4"
      description="What a branch asks a store for. Change a quantity where needed (0 takes the line off). Approved, it is posted in FACTS straight away as a stock transfer request (STR50) to the store.">
      <ErrorNote message={list.error} />
      <div className="space-y-3">
        {items.map((r) => <RequestToDecide key={r.id} r={r} onDone={() => list.reload()} />)}
      </div>
    </FieldGroup>
  );
}

function RequestToDecide({ r, onDone }: { r: Waiting; onDone: () => void }) {
  const [qty, setQty] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const q = (l: Waiting["lines"][number]) => qty[l.id] ?? String(l.qty);
  const bad = r.lines.some((l) => q(l).trim() === "" || !(Number(q(l)) >= 0));
  const kept = r.lines.filter((l) => Number(q(l)) > 0).length;

  async function approve() {
    setBusy("approve");
    try {
      await api(`/requests/approvals/${r.id}/approve`, "POST", { lines: r.lines.map((l) => ({ id: l.id, qty: Number(q(l)) })), note: null });
      toast.success(`${r.number} approved. Posting to FACTS now.`);
      onDone();
    } catch (e) { toast.error((e as Error).message, { duration: 10000 }); } finally { setBusy(null); }
  }
  async function reject() {
    const note = await promptReason({ title: `Reject ${r.number}?`, confirmLabel: "Reject", tone: "danger", reason: { label: "Why", placeholder: "The branch sees this" } });
    if (!note) return;
    setBusy("reject");
    try {
      await api(`/requests/approvals/${r.id}/reject`, "POST", { note });
      toast.success("Rejected. Nothing goes to FACTS.");
      onDone();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(null); }
  }

  return (
    <div className="rounded-xl border">
      <div className="flex flex-wrap items-center gap-3 border-b px-3 py-2.5">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><ClipboardListIcon className="size-4" /></span>
        <div className="min-w-0 flex-1">
          <div className="font-medium">{r.number} · {r.branchName} <span className="font-normal text-muted-foreground">from {r.storeName} ({r.storeCode})</span></div>
          <div className="text-xs text-muted-foreground">
            {r.requestedByName}, {timeAgo(r.requestedAt)}{r.neededBy ? ` · needed by ${new Date(r.neededBy).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}` : ""}{r.note ? ` · ${r.note}` : ""}
          </div>
        </div>
      </div>
      <div className="divide-y">
        <div className="hidden gap-3 px-3 py-1.5 text-xs text-muted-foreground sm:flex">
          <span className="flex-1">Item</span><span className="w-20 text-right">At branch</span><span className="w-20 text-right">At store</span><span className="w-[7.5rem] text-right">Quantity</span>
        </div>
        {r.lines.map((l) => (
          <div key={l.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
            <div className="min-w-0 flex-1"><div className="truncate text-sm font-medium">{l.itemName}</div><div className="font-mono text-xs text-muted-foreground">{l.itemCode}</div></div>
            <span className="w-20 text-right text-xs tabular-nums text-muted-foreground">{l.atOutlet === null ? "—" : fmtQty(l.atOutlet)}</span>
            <span className="w-20 text-right text-xs tabular-nums text-muted-foreground">{l.atStore === null ? "—" : fmtQty(l.atStore)}</span>
            <div className="flex w-[7.5rem] items-center justify-end gap-2">
              <input inputMode="decimal" aria-label={`Quantity of ${l.itemName}`} value={q(l)} onChange={(e) => setQty({ ...qty, [l.id]: e.target.value.replace(/[^\d.]/g, "") })}
                className="h-10 w-20 rounded-lg border border-input bg-card px-2 text-right text-sm tabular-nums" />
              <span className="w-8 text-xs text-muted-foreground">{l.unit?.toLowerCase()}</span>
            </div>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t px-3 py-2.5">
        <span className="flex-1 text-sm text-muted-foreground">{kept === r.lines.length ? `${kept} item${kept === 1 ? "" : "s"}` : `${kept} of ${r.lines.length} items (0 takes a line off)`}</span>
        <Button variant="outline" className="h-11 text-danger" disabled={!!busy} onClick={() => void reject()}>
          {busy === "reject" ? <Loader2Icon className="animate-spin" /> : <XIcon />} Reject
        </Button>
        <Button className="h-11" disabled={!!busy || bad || kept === 0} onClick={() => void approve()}>
          {busy === "approve" ? <Loader2Icon className="animate-spin" /> : <CheckIcon />} Approve and post to FACTS
        </Button>
      </div>
    </div>
  );
}
