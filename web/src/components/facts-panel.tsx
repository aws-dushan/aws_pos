"use client";

import { useState } from "react";
import { DatabaseIcon, Loader2Icon, PackageCheckIcon, RefreshCwIcon, TagIcon, WarehouseIcon } from "lucide-react";
import { toast } from "sonner";
import { api, useApi } from "@/lib/api";
import { cn, timeAgo } from "@/lib/utils";
import { useLiveEvent } from "@/components/live";
import { confirmDialog } from "@/components/confirm";
import { Button } from "@/components/ui/button";

type Run = { startedAt: string; finishedAt: string | null; ok: boolean | null; summary: Record<string, number> | null; message: string | null } | null;
type Status = {
  connector: string; configured: boolean; division: string | null; itemType: string; itemMaster: string | null; location: string | null; priceType: string | null; pricesIncludeVat: boolean;
  items: Run; stock: Run; enableSold: Run; prices: Run;
  counts: { catalogue: number; new: number; needsPrice: number; onHere: number };
};

function RunLine({ label, run }: { label: string; run: Run }) {
  if (!run) return <span className="text-muted-foreground">{label}: not yet</span>;
  return (
    <span className={cn(run.ok === false ? "text-danger" : "text-muted-foreground")} title={run.message ?? undefined}>
      {label}: {run.ok === false ? `failed ${timeAgo(run.startedAt)}` : run.finishedAt ? timeAgo(run.finishedAt) : "running…"}
    </span>
  );
}

/**
 * FACTS on the Menu screen (REQ ERP-02 … ERP-05): what comes from FACTS and when it last synced (items hourly, stock every
 * 5 minutes, prices from the branch's FACTS price type every 5 minutes), with buttons to sync now and to switch on the items this branch's location sold lately.
 */
export function FactsPanel({ branchName, onChanged }: { branchName: string | undefined; onChanged: () => void }) {
  const s = useApi<Status>("/erp/status");
  useLiveEvent(["menu.changed"], () => s.reload());
  const [busy, setBusy] = useState<string | null>(null);
  const d = s.data;
  if (!d || d.connector !== "facts") return null;

  async function run(key: string, path: string, body: unknown, done: (r: Record<string, number>) => string) {
    setBusy(key);
    try { const r = await api<Record<string, number>>(path, "POST", body); toast.success(done(r)); s.reload(); onChanged(); }
    catch (e) { toast.error((e as Error).message); s.reload(); } finally { setBusy(null); }
  }
  async function enableSold() {
    if (!(await confirmDialog({ title: `Switch on what sold at ${branchName}?`, confirmLabel: "Switch on",
      message: `Items that ${d!.location} sold in FACTS over the last 14 days are switched on here. Items already on stay on.` }))) return;
    await run("enable", "/erp/enable-sold", { days: 14 }, (r) => `${r.switchedOn} items switched on (${r.notInCatalogue} sold items aren't in the catalogue).`);
  }

  return (
    <div data-module="inv" className="surface mb-5 flex flex-wrap items-center gap-x-6 gap-y-3 p-4">
      <div className="flex items-center gap-3">
        <span className="flex size-10 items-center justify-center rounded-xl bg-mod-grad text-white shadow-[0_6px_16px_-6px_var(--mod)]"><DatabaseIcon className="size-5" /></span>
        <div>
          <div className="font-medium">Items from FACTS</div>
          <div className="text-xs text-muted-foreground">
            {d.itemMaster ? `${d.itemMaster} ` : ""}{d.itemType} items{d.division ? `, division ${d.division}` : ""} · {d.counts.catalogue} in the catalogue · {d.counts.onHere} on here
            {d.location ? ` · stock from ${d.location}` : " · no stock location set for this branch"}
            {d.priceType ? ` · prices from ${d.priceType}${d.pricesIncludeVat ? "" : " + VAT"}` : " · prices set in One POS"}
          </div>
        </div>
      </div>
      <div className="flex flex-col text-xs">
        <RunLine label="Items" run={d.items} />
        <RunLine label="Stock" run={d.stock} />
        {d.priceType && <RunLine label="Prices" run={d.prices} />}
      </div>
      {(d.counts.new > 0 || d.counts.needsPrice > 0) && (
        <div className="flex gap-2 text-xs">
          {d.counts.new > 0 && <span className="rounded-full bg-sky-500/10 px-2.5 py-1 font-medium text-sky-700 dark:text-sky-300">{d.counts.new} new from FACTS</span>}
          {d.counts.needsPrice > 0 && <span className="rounded-full bg-warning/10 px-2.5 py-1 font-medium text-warning">{d.counts.needsPrice} on here without a price</span>}
        </div>
      )}
      <div className="ml-auto flex flex-wrap gap-2">
        {!d.configured ? <span className="text-sm text-warning">No FACTS connection saved for this company.</span> : <>
          <Button variant="outline" className="h-10" disabled={!!busy} onClick={() => void run("items", "/erp/sync/items", undefined, (r) => `Items synced: ${r.added} new, ${r.updated} changed, ${r.removed} switched off.`)}>
            {busy === "items" ? <Loader2Icon className="animate-spin" /> : <RefreshCwIcon />} Sync items
          </Button>
          <Button variant="outline" className="h-10" disabled={!!busy || !d.location} onClick={() => void run("stock", "/erp/sync/stock", undefined, (r) => `Stock read for ${r.items} items.`)}>
            {busy === "stock" ? <Loader2Icon className="animate-spin" /> : <WarehouseIcon />} Sync stock
          </Button>
          {d.priceType && (
            <Button variant="outline" className="h-10" disabled={!!busy} onClick={() => void run("prices", "/erp/sync/prices", undefined, (r) => `Prices read: ${r.priced} items priced, ${r.changed} changed.`)}>
              {busy === "prices" ? <Loader2Icon className="animate-spin" /> : <TagIcon />} Sync prices
            </Button>
          )}
          <Button variant="outline" className="h-10" disabled={!!busy || !d.location} onClick={() => void enableSold()}>
            {busy === "enable" ? <Loader2Icon className="animate-spin" /> : <PackageCheckIcon />} Switch on what sold here
          </Button>
        </>}
      </div>
    </div>
  );
}
