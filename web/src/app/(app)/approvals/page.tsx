"use client";

import { useState } from "react";
import { BadgePercentIcon, BanknoteIcon, CheckIcon, RotateCcwIcon, ShieldCheckIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { api, useApi } from "@/lib/api";
import { cn, timeAgo } from "@/lib/utils";
import { useSession } from "@/components/session";
import { useLiveEvent } from "@/components/live";
import { promptReason } from "@/components/confirm";
import { EmptyState, ErrorNote, LoadingRows, ObjectStatus, PageHeader, Segmented, TONE } from "@/components/kit";
import { Stagger, StaggerItem } from "@/components/motion";
import { ModuleIcon } from "@/components/modules";
import type { Approval } from "@/components/approval";
import { Button } from "@/components/ui/button";
import { WastageApprovals } from "@/components/wastage-approvals";
import { ReturnsApprovals } from "@/components/returns-approvals";
import { RequestsApprovals } from "@/components/requests-approvals";

const KIND = {
  discount: { label: "Discount", icon: BadgePercentIcon, module: "sales" as const },
  refund: { label: "Refund", icon: RotateCcwIcon, module: "bank" as const },
  cash_out: { label: "Cash out", icon: BanknoteIcon, module: "fin" as const },
};
const STATUS: Record<Approval["status"], { label: string; tone: string }> = {
  pending: { label: "Waiting", tone: TONE.warn }, approved: { label: "Approved", tone: TONE.done }, used: { label: "Approved · used", tone: TONE.done },
  rejected: { label: "Rejected", tone: TONE.danger }, cancelled: { label: "Cancelled", tone: TONE.muted },
};

/** Requests from the tills waiting for a manager (REQ APR-02): approve or reject from anywhere, live. */
export default function ApprovalsPage() {
  const { me } = useSession();
  const [where, setWhere] = useState<"branch" | "all">("all");
  const pending = useApi<Approval[]>(`/approvals${where === "all" ? "?all=true" : ""}`);
  const recent = useApi<Approval[]>(`/approvals?status=all${where === "all" ? "&all=true" : ""}`);
  useLiveEvent(["approvals.changed"], () => { pending.reload(); recent.reload(); });
  const [busy, setBusy] = useState<string | null>(null);

  async function decide(a: Approval, approve: boolean) {
    let note: string | null = null;
    if (!approve) {
      note = await promptReason({ title: `Reject ${a.requestedByName}'s request?`, confirmLabel: "Reject", tone: "danger", reason: { label: "Why", placeholder: "Shown on the till" } });
      if (!note) return;
    }
    setBusy(a.id);
    try {
      await api(`/approvals/${a.id}/decide`, "POST", { approve, note });
      toast.success(approve ? "Approved. The till carries on." : "Rejected.");
      pending.reload(); recent.reload();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(null); }
  }

  const done = (recent.data ?? []).filter((a) => a.status !== "pending").slice(0, 20);

  return (
    <div className="mx-auto max-w-[980px] pb-8">
      <PageHeader title="Approvals" icon={ShieldCheckIcon} module="appr" count={pending.data?.length}
        description="Wastage, returns to the factory and stock requests waiting for their approver, and discounts, refunds and cash out above a cashier's limit. Approving here acts at once."
        actions={<Segmented id="appr-where" value={where} onChange={setWhere} options={[{ value: "all", label: "All my branches" }, { value: "branch", label: "This branch" }]} />} />
      <WastageApprovals />
      <ReturnsApprovals />
      <RequestsApprovals />
      <ErrorNote message={pending.error} />
      {!pending.data ? <LoadingRows rows={3} /> : pending.data.length === 0 ? (
        <EmptyState icon={ShieldCheckIcon} title="Nothing waiting" module="appr">New requests appear here the moment a till sends them.</EmptyState>
      ) : (
        <Stagger className="space-y-3">
          {pending.data.map((a) => {
            const k = KIND[a.kind];
            const own = a.requestedByName === me.user.displayName;
            return (
              <StaggerItem key={a.id}>
                <div className="surface flex flex-wrap items-center gap-4 p-4 animate-rise-in">
                  <ModuleIcon module={k.module} icon={k.icon} size="lg" solid />
                  <div className="min-w-0 flex-1">
                    <div className="font-heading text-[1.05rem] font-semibold">{a.summary}</div>
                    <div className="text-sm text-muted-foreground">
                      {a.requestedByName} · {a.branchCode}{a.registerName ? ` · ${a.registerName}` : ""}{a.orderNumber ? ` · order #${a.orderNumber}` : ""} · {timeAgo(a.requestedAt)}
                    </div>
                    {a.reason && <div className="mt-1 text-sm">“{a.reason}”</div>}
                  </div>
                  <div className="flex gap-2">
                    <Button variant="outline" className="h-12 min-w-24" disabled={busy === a.id || own} onClick={() => void decide(a, false)}><XIcon /> Reject</Button>
                    <Button className="h-12 min-w-28" disabled={busy === a.id || own} onClick={() => void decide(a, true)}><CheckIcon /> Approve</Button>
                  </div>
                </div>
              </StaggerItem>
            );
          })}
        </Stagger>
      )}

      <h2 className="mt-8 mb-2 font-heading font-semibold">Answered in the last two days</h2>
      {done.length ? (
        <div className="surface divide-y">
          {done.map((a) => (
            <div key={a.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
              <span className="min-w-0 flex-1">
                <span className="font-medium">{a.summary}</span>
                <span className="text-muted-foreground"> · {a.requestedByName} · {a.branchCode}</span>
              </span>
              <span className="text-muted-foreground">{a.decidedByName ? `${a.via === "code" ? "Code emailed to " : ""}${a.decidedByName}${a.via === "pin" ? " (PIN at the till)" : ""}` : ""}</span>
              <ObjectStatus className={cn(STATUS[a.status].tone)}>{STATUS[a.status].label}</ObjectStatus>
            </div>
          ))}
        </div>
      ) : <p className="surface px-5 py-6 text-center text-sm text-muted-foreground">No answered requests yet.</p>}
    </div>
  );
}
