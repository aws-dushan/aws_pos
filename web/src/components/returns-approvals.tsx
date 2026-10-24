"use client";

import { useState } from "react";
import { CheckIcon, Loader2Icon, Undo2Icon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { api, useApi } from "@/lib/api";
import { cn, timeAgo } from "@/lib/utils";
import { useLiveEvent } from "@/components/live";
import { promptReason } from "@/components/confirm";
import { ErrorNote, FieldGroup } from "@/components/kit";
import { Button } from "@/components/ui/button";

type Waiting = {
  id: string; branchName: string; deliveryDocType: string; deliveryDocNo: string; toLocation: string; itemCode: string; itemName: string;
  qty: number; unit: string | null; reason: string; note: string | null; recordedByName: string; recordedAt: string;
};

const REASON: Record<string, string> = { short: "Short delivered", excess: "Not needed", damaged: "Damaged", wrong: "Wrong item", quality: "Quality", expiry: "Near expiry", other: "Other" };

/**
 * Returns to the factory waiting for me (the branches I approve wastage for). Approve, lowering a quantity where needed: FACTS must
 * hold the stock, then it is posted there as a stock transfer back to where the delivery came from. Reject: it stays at the branch.
 */
export function ReturnsApprovals() {
  const list = useApi<{ isApprover: boolean; items: Waiting[] }>("/returns/approvals");
  useLiveEvent(["stock.changed"], () => list.reload());
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [qty, setQty] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const items = list.data?.items ?? [];
  // Only shown when something waits (or it failed to load), so an approver's page doesn't fill with empty sections.
  if ((!list.data?.isApprover || items.length === 0) && !list.error) return null;
  const chosen = items.filter((r) => picked.has(r.id));
  const toggle = (id: string) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  async function approve() {
    const lines = chosen.map((r) => {
      const q = qty[r.id]?.trim();
      return { id: r.id, qty: q && Number(q) !== r.qty ? Number(q) : null };
    });
    if (lines.some((l) => l.qty !== null && !(l.qty > 0))) { toast.error("A quantity must be above zero; reject it instead."); return; }
    setBusy("approve");
    try {
      const r = await api<{ approved: number; transfers: number }>("/returns/approvals/approve", "POST", { lines, note: null });
      toast.success(`Approved ${r.approved}. Posting to FACTS now (${r.transfers} transfer${r.transfers === 1 ? "" : "s"}).`);
      setPicked(new Set()); setQty({}); list.reload();
    } catch (e) { toast.error((e as Error).message, { duration: 10000 }); } finally { setBusy(null); }
  }

  async function reject() {
    const note = await promptReason({ title: `Reject ${chosen.length} return${chosen.length === 1 ? "" : "s"}?`, confirmLabel: "Reject", tone: "danger", reason: { label: "Why", placeholder: "The branch sees this" } });
    if (!note) return;
    setBusy("reject");
    try {
      await api("/returns/approvals/reject", "POST", { ids: chosen.map((r) => r.id), note });
      toast.success("Rejected. Nothing goes to FACTS.");
      setPicked(new Set()); list.reload();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(null); }
  }

  return (
    <FieldGroup title={`Returns to approve (${items.length})`} className="mb-5 p-4"
      description="What a branch sends back to where it was delivered from: a delivery's shortfall (by itself at check-in), or an item from the Returns tab. Approved, it is posted in FACTS straight away: a stock transfer back to where the delivery came from, batches oldest first.">
      <ErrorNote message={list.error} />
      <div className="divide-y rounded-xl border">
        {items.map((r) => (
          <label key={r.id} className={cn("flex cursor-pointer flex-wrap items-center gap-3 px-3 py-2.5", picked.has(r.id) && "bg-primary/5")}>
            <input type="checkbox" className="size-5 accent-[var(--primary)]" checked={picked.has(r.id)} onChange={() => toggle(r.id)} />
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><Undo2Icon className="size-4" /></span>
            <div className="min-w-0 flex-1">
              <div className="font-medium">{r.itemName} <span className="font-normal text-muted-foreground">back to {r.toLocation}</span></div>
              <div className="text-xs text-muted-foreground">
                {r.branchName} · {r.deliveryDocType} {r.deliveryDocNo} · {REASON[r.reason] ?? r.reason}{r.note ? ` · ${r.note}` : ""} · {r.recordedByName}, {timeAgo(r.recordedAt)}
              </div>
            </div>
            <div className="flex items-center gap-2" onClick={(e) => e.preventDefault()}>
              <input inputMode="decimal" aria-label={`Quantity of ${r.itemName}`} value={qty[r.id] ?? String(r.qty)}
                onChange={(e) => setQty({ ...qty, [r.id]: e.target.value })}
                className="h-10 w-20 rounded-lg border border-input bg-card px-2 text-right text-sm tabular-nums" />
              <span className="w-10 text-xs text-muted-foreground">{r.unit ?? ""}</span>
            </div>
          </label>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="outline" className="h-11" onClick={() => setPicked(picked.size === items.length ? new Set() : new Set(items.map((r) => r.id)))}>
          {picked.size === items.length ? "Clear" : "Select all"}
        </Button>
        <span className="flex-1 text-sm text-muted-foreground">{chosen.length ? `${chosen.length} selected` : "Select the returns to decide."}</span>
        <Button variant="outline" className="h-11 text-danger" disabled={!chosen.length || !!busy} onClick={() => void reject()}>
          {busy === "reject" ? <Loader2Icon className="animate-spin" /> : <XIcon />} Reject
        </Button>
        <Button className="h-11" disabled={!chosen.length || !!busy} onClick={() => void approve()}>
          {busy === "approve" ? <Loader2Icon className="animate-spin" /> : <CheckIcon />} Approve and post to FACTS
        </Button>
      </div>
    </FieldGroup>
  );
}
