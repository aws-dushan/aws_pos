"use client";

import { useState } from "react";
import { BikeIcon, PlusIcon } from "lucide-react";
import { toast } from "sonner";
import { api, useApi } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useSession } from "@/components/session";
import { useLiveEvent } from "@/components/live";
import { PlatformDialog, type Platform } from "@/components/platform-dialog";
import { EmptyState, ErrorNote, LoadingRows, PageHeader, Switch } from "@/components/kit";
import { Button } from "@/components/ui/button";

const SUGGESTED = ["Talabat", "Deliveroo", "Careem", "Noon Food", "Keeta", "Smiles"];

/** Delivery platforms (Administration): the company's list with each one's commission; the register offers the active ones on a delivery. */
export default function PlatformsAdminPage() {
  const { can, company } = useSession();
  const branchName = new Map((company?.branches ?? []).map((b) => [b.id, b.name]));
  const list = useApi<Platform[]>("/platforms");
  useLiveEvent(["platforms.changed"], () => list.reload());
  const [edit, setEdit] = useState<Platform | "new" | null>(null);
  const manage = can("branch.manage");
  // Branches with FACTS payment methods: there a platform needs one chosen for its bills to post.
  const payModes = useApi<{ branchId: string }[]>(manage ? "/platforms/payment-modes" : null);
  const factsBranches = new Set((payModes.data ?? []).map((m) => m.branchId));
  const settings = useApi<{ payoutsEnabled: boolean }>("/platforms/settings");
  async function setPayouts(on: boolean) {
    try {
      await api("/platforms/settings", "PUT", { payoutsEnabled: on });
      toast.success(on ? "Payouts are tracked here now: record them on the Delivery platform report." : "Payouts are managed elsewhere.");
      settings.reload();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  const missing = SUGGESTED.filter((n) => !(list.data ?? []).some((p) => p.name.toLowerCase() === n.toLowerCase()));

  async function quickAdd(name: string) {
    try {
      await api("/platforms", "POST", { name, commissionPct: 0 });
      toast.success(`${name} added. Set its commission.`);
      list.reload();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <div>
      <PageHeader title="Delivery platforms" icon={BikeIcon} module="bank" count={list.data?.length}
        description="The platforms the outlets take orders from, the branches each one is on at, and the commission it takes. Their sales and what they owe are in the Delivery platform report."
        actions={manage && <Button size="lg" onClick={() => setEdit("new")}><PlusIcon /> Add platform</Button>} />
      <ErrorNote message={list.error} />
      {list.loading && !list.data ? <LoadingRows rows={3} /> : list.data?.length ? (
        <div className="mb-6 flex flex-wrap gap-2">
          {list.data.map((p) => (
            <button key={p.id} type="button" disabled={!manage} onClick={() => setEdit(p)}
              className={cn("surface flex items-center gap-3 px-4 py-3 text-left transition-transform active:scale-[0.98] disabled:active:scale-100", (!p.isActive || !p.here) && "opacity-55")}>
              <BikeIcon className="size-5 text-mod-bank" />
              <span>
                <span className="block font-medium">{p.name}</span>
                <span className="block text-xs text-muted-foreground">{p.orderType === "dine_in" ? "Dine-in · " : p.orderType === "takeaway" ? "Takeaway · " : ""}{p.commissionPct}% commission{p.bankFeePct ? ` + ${p.bankFeePct}% bank fee` : ""}{p.factsCustomer ? ` · FACTS ${p.factsCustomer} prices (${p.factsPriced})` : " · outlet prices"}{!p.isActive ? " · not in use" : ""}</span>
                <span className="block text-xs text-muted-foreground">
                  {p.branchIds.length ? `On at: ${p.branchIds.map((id) => branchName.get(id)).filter(Boolean).join(", ")}` : "Not on at any branch"}
                  {p.branchIds.some((id) => !p.paymentModes?.[id] && factsBranches.has(id)) && <span className="text-danger"> · FACTS payment method not chosen</span>}
                </span>
              </span>
            </button>
          ))}
        </div>
      ) : (
        <EmptyState icon={BikeIcon} title="No delivery platforms yet" module="bank" compact>
          Add the platforms the outlets take orders from, and the branches each one is on at. The register there then offers them on a delivery.
        </EmptyState>
      )}
      {manage && missing.length > 0 && (
        <div className="mb-6 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">Add quickly:</span>
          {missing.map((n) => <Button key={n} variant="outline" size="sm" onClick={() => void quickAdd(n)}><PlusIcon /> {n}</Button>)}
        </div>
      )}
      <div className="surface flex items-start justify-between gap-4 p-5">
        <div>
          <div className="font-medium">Track platform payouts in ONE POS</div>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            {settings.data?.payoutsEnabled
              ? "On: record each payout as it arrives (amount, the commission kept, its statement). The report shows what each platform still owes."
              : "Off: payouts are reconciled elsewhere (e.g. in the ERP or accounts). The report still shows what each platform owes and the expected payout."}
          </p>
        </div>
        <Switch size="lg" on={!!settings.data?.payoutsEnabled} disabled={!manage || !settings.data} onChange={(v) => void setPayouts(v)} label="Track platform payouts" />
      </div>
      <PlatformDialog value={edit} onClose={() => setEdit(null)} onSaved={() => list.reload()} />
    </div>
  );
}
