"use client";

import { useState } from "react";
import { Loader2Icon, SearchIcon } from "lucide-react";
import { toast } from "sonner";
import { api, useApi } from "@/lib/api";
import { timeAgo } from "@/lib/utils";
import { Field, ObjectStatus, Switch, TONE } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

export type Platform = { id: string; name: string; commissionPct: number; bankFeePct: number; isActive: boolean; sort: number;
  factsCustomer: string | null; factsCustomerName: string | null; factsPriceType: string | null; factsPriceAt: string | null; factsPriced: number };

/** Adds or edits a delivery platform and its commission (Administration). */
export function PlatformDialog({ value, onClose, onSaved }: { value: Platform | "new" | null; onClose: () => void; onSaved: () => void }) {
  const existing = value && value !== "new" ? value : null;
  const [f, setF] = useState({ name: "", commissionPct: "", bankFeePct: "", isActive: true });
  const [seen, setSeen] = useState<typeof value>(null);
  const [busy, setBusy] = useState(false);
  if (value !== seen) {
    setSeen(value);
    setF(existing ? { name: existing.name, commissionPct: String(existing.commissionPct), bankFeePct: String(existing.bankFeePct ?? 0), isActive: existing.isActive } : { name: "", commissionPct: "", bankFeePct: "", isActive: true });
  }
  async function save() {
    setBusy(true);
    try {
      const body = { name: f.name, commissionPct: Number(f.commissionPct || 0), bankFeePct: Number(f.bankFeePct || 0), isActive: f.isActive };
      if (existing) await api(`/platforms/${existing.id}`, "PUT", body); else await api("/platforms", "POST", body);
      toast.success(existing ? "Platform saved." : `${f.name} added.`);
      onSaved();
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={!!value} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{existing ? existing.name : "Add a delivery platform"}</DialogTitle>
          <DialogDescription>New rates apply to orders tagged from now on; earlier orders keep theirs. Commission and bank fee both come off what the platform pays.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" required><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Talabat" autoFocus={!existing} /></Field>
          <Field label="Commission (%)"><Input value={f.commissionPct} inputMode="decimal" onChange={(e) => setF({ ...f, commissionPct: e.target.value })} placeholder="e.g. 25" /></Field>
          <Field label="Bank fee (%)" hint="Card / online payment fee it keeps."><Input value={f.bankFeePct} inputMode="decimal" onChange={(e) => setF({ ...f, bankFeePct: e.target.value })} placeholder="e.g. 2.5" /></Field>
        </div>
        {existing && (
          <div className="flex items-center justify-between rounded-xl border px-3 py-2.5">
            <span className="text-sm">In use <span className="text-muted-foreground">· off hides it at the register</span></span>
            <Switch on={f.isActive} onChange={(v) => setF({ ...f, isActive: v })} label="In use" />
          </div>
        )}
        {existing && !f.isActive && <ObjectStatus className={TONE.muted}>Its past orders stay in the report.</ObjectStatus>}
        {existing && <FactsCustomer platform={existing} onSaved={onSaved} />}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={busy || !f.name.trim()} onClick={() => void save()}>{existing ? "Save" : "Add"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type FactsCust = { code: string; name: string; priceType: string | null };

/**
 * The platform's FACTS customer (e.g. AR-D0005 for Talabat): a delivery bill for this platform is rung up at that customer's FACTS
 * prices (the price type on its account), read with the regular price sync; FACTS items without a price there can't be sold on it.
 */
function FactsCustomer({ platform, onSaved }: { platform: Platform; onSaved: () => void }) {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const found = useApi<FactsCust[]>(q.trim().length >= 2 ? `/platforms/facts-customers?q=${encodeURIComponent(q.trim())}` : null);
  async function link(code: string | null) {
    setBusy(true);
    try {
      await api(`/platforms/${platform.id}/facts-customer`, "PUT", { customer: code });
      toast.success(code ? `${platform.name} takes ${code}'s FACTS prices now.` : `${platform.name} sells at the outlet prices again.`);
      setQ(""); onSaved();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <div className="rounded-xl border p-3">
      <div className="text-sm font-medium">Prices from FACTS</div>
      {platform.factsCustomer ? (
        <div className="mt-1 text-sm">
          <div><span className="font-mono">{platform.factsCustomer}</span> {platform.factsCustomerName}</div>
          <div className="text-xs text-muted-foreground">
            Customer price list (CPL50) · {platform.factsPriced} item price{platform.factsPriced === 1 ? "" : "s"}
            {platform.factsPriceAt ? ` · read ${timeAgo(platform.factsPriceAt)}` : ""}
          </div>
          <Button variant="ghost" size="sm" className="mt-1 h-8 px-2 text-danger" disabled={busy} onClick={() => void link(null)}>Unlink (use outlet prices)</Button>
        </div>
      ) : (
        <p className="mt-1 text-xs text-muted-foreground">Not linked: its bills use the outlet prices. Link its FACTS customer to sell at that customer&apos;s FACTS prices.</p>
      )}
      <div className="relative mt-2">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={platform.factsCustomer ? "Link another FACTS customer…" : "Find the FACTS customer, e.g. talabat"} className="pl-9" />
      </div>
      {found.loading && <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground"><Loader2Icon className="size-3.5 animate-spin" /> Looking in FACTS…</div>}
      {found.error && <p className="mt-2 text-xs text-danger">{found.error}</p>}
      {!!found.data?.length && (
        <div className="mt-2 max-h-48 divide-y overflow-y-auto rounded-lg border">
          {found.data.map((c) => (
            <button key={c.code} type="button" disabled={busy} onClick={() => void link(c.code)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted">
              <span className="font-mono text-xs">{c.code}</span><span className="min-w-0 flex-1 truncate">{c.name}</span>
              <span className="text-xs text-muted-foreground">{c.priceType ?? "no price type"}</span>
            </button>
          ))}
        </div>
      )}
      {found.data && found.data.length === 0 && <p className="mt-2 text-xs text-muted-foreground">No FACTS customer matches.</p>}
    </div>
  );
}
