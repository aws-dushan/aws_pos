"use client";

import { useState } from "react";
import { CheckIcon, Loader2Icon, Trash2Icon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { api, useApi } from "@/lib/api";
import { cn, timeAgo } from "@/lib/utils";
import { useLiveEvent } from "@/components/live";
import { promptReason } from "@/components/confirm";
import { ErrorNote, FieldGroup } from "@/components/kit";
import { Button } from "@/components/ui/button";

type Waiting = {
  id: string; branchId: string; branchCode: string; branchName: string; businessDate: string; name: string; qty: number; unit: string | null;
  reason: string; note: string | null; costValue: number | null; recordedByName: string; recordedAt: string;
};

const REASON: Record<string, string> = { expired: "Expired", damaged: "Damaged", quality: "Quality", returned: "Returned", staff: "Staff meal", calibration: "Machine calibration", other: "Other" };

/**
 * Wastage waiting for me (the branches I approve wastage for). Approve, with a corrected quantity where needed: FACTS must hold the
 * stock, then it is posted there as a stock transfer to the wastage location. Reject: taken off with the reason, never sent.
 */
export function WastageApprovals() {
  const list = useApi<{ currency: string; isApprover: boolean; items: Waiting[] }>("/wastage/approvals");
  useLiveEvent(["stock.changed"], () => list.reload());
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [qty, setQty] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  if (!list.data?.isApprover && !list.error) return null;
  const items = list.data?.items ?? [];
  const chosen = items.filter((w) => picked.has(w.id));
  const toggle = (id: string) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  async function approve() {
    const lines = chosen.map((w) => {
      const q = qty[w.id]?.trim();
      return { id: w.id, qty: q && Number(q) !== w.qty ? Number(q) : null };
    });
    if (lines.some((l) => l.qty !== null && !(l.qty > 0))) { toast.error("A quantity must be above zero; reject it instead."); return; }
    setBusy("approve");
    try {
      const r = await api<{ approved: number; transfers: number }>("/wastage/approvals/approve", "POST", { lines, note: null });
      toast.success(`Approved ${r.approved}. Posting to FACTS now (${r.transfers} transfer${r.transfers === 1 ? "" : "s"}).`);
      setPicked(new Set()); setQty({}); list.reload();
    } catch (e) { toast.error((e as Error).message, { duration: 10000 }); } finally { setBusy(null); }
  }

  async function reject() {
    const note = await promptReason({ title: `Reject ${chosen.length} wastage ${chosen.length === 1 ? "entry" : "entries"}?`, confirmLabel: "Reject", tone: "danger", reason: { label: "Why", placeholder: "The branch sees this" } });
    if (!note) return;
    setBusy("reject");
    try {
      await api("/wastage/approvals/reject", "POST", { ids: chosen.map((w) => w.id), note });
      toast.success("Rejected. Nothing goes to FACTS.");
      setPicked(new Set()); list.reload();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(null); }
  }

  const cur = list.data?.currency ?? "";
  return (
    <FieldGroup title={`Wastage to approve${items.length ? ` (${items.length})` : ""}`} className="mb-5 p-4"
      description="Approved wastage is posted in FACTS straight away: a stock transfer to the branch's wastage location, batches oldest first. Correct a quantity before approving if needed.">
      <ErrorNote message={list.error} />
      {items.length === 0 ? <p className="text-sm text-muted-foreground">Nothing waiting.</p> : (
        <>
          <div className="divide-y rounded-xl border">
            {items.map((w) => (
              <label key={w.id} className={cn("flex cursor-pointer flex-wrap items-center gap-3 px-3 py-2.5", picked.has(w.id) && "bg-primary/5")}>
                <input type="checkbox" className="size-5 accent-[var(--primary)]" checked={picked.has(w.id)} onChange={() => toggle(w.id)} />
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-danger/10 text-danger"><Trash2Icon className="size-4" /></span>
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{w.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {w.branchName} · {REASON[w.reason] ?? w.reason}{w.note ? ` · ${w.note}` : ""} · {w.recordedByName}, {timeAgo(w.recordedAt)}
                  </div>
                </div>
                <div className="flex items-center gap-2" onClick={(e) => e.preventDefault()}>
                  <input inputMode="decimal" aria-label={`Quantity of ${w.name}`} value={qty[w.id] ?? String(w.qty)}
                    onChange={(e) => setQty({ ...qty, [w.id]: e.target.value })}
                    className="h-10 w-20 rounded-lg border border-input bg-card px-2 text-right text-sm tabular-nums" />
                  <span className="w-10 text-xs text-muted-foreground">{w.unit ?? ""}</span>
                </div>
                <div className="w-24 text-right text-sm tabular-nums">{w.costValue !== null ? `${cur} ${w.costValue.toFixed(2)}` : "–"}</div>
              </label>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button variant="outline" className="h-11" onClick={() => setPicked(picked.size === items.length ? new Set() : new Set(items.map((w) => w.id)))}>
              {picked.size === items.length ? "Clear" : "Select all"}
            </Button>
            <span className="flex-1 text-sm text-muted-foreground">{chosen.length ? `${chosen.length} selected` : "Select the wastage to decide."}</span>
            <Button variant="outline" className="h-11 text-danger" disabled={!chosen.length || !!busy} onClick={() => void reject()}>
              {busy === "reject" ? <Loader2Icon className="animate-spin" /> : <XIcon />} Reject
            </Button>
            <Button className="h-11" disabled={!chosen.length || !!busy} onClick={() => void approve()}>
              {busy === "approve" ? <Loader2Icon className="animate-spin" /> : <CheckIcon />} Approve and post to FACTS
            </Button>
          </div>
        </>
      )}
    </FieldGroup>
  );
}
