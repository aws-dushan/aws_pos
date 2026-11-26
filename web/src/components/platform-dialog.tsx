"use client";

import { useState } from "react";
import { Loader2Icon, SearchIcon } from "lucide-react";
import { toast } from "sonner";
import { api, useApi } from "@/lib/api";
import { cn, timeAgo } from "@/lib/utils";
import { useSession } from "@/components/session";
import { Field, ObjectStatus, Segmented, Switch, TONE, selectClass } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

export type Platform = { id: string; name: string; commissionPct: number; bankFeePct: number; isActive: boolean; sort: number;
  /** The branches it is on at; here = on at the header branch. */
  branchIds: string[]; here: boolean;
  /** The order type its orders are (Talabat Kitchen Dine In: dine-in). */
  orderType: "dine_in" | "takeaway" | "delivery";
  /** Branch → the FACTS payment method (code) its bills post with there. */
  paymentModes: Record<string, string>;
  factsCustomer: string | null; factsCustomerName: string | null; factsPriceType: string | null; factsPriceAt: string | null; factsPriced: number };

type PayMode = { branchId: string; code: string; name: string; kind: "card" | "platform"; label: string };

/** The FACTS payment method that looks like the platform's (its first word in the method's name), as the starting choice. */
function suggest(modes: PayMode[], branchId: string, name: string) {
  const word = name.trim().split(/\s+/)[0]?.toLowerCase();
  return word ? modes.find((m) => m.branchId === branchId && m.kind === "platform" && m.label.toLowerCase().includes(word))?.code ?? "" : "";
}

/** Adds or edits a delivery platform, its commission, the branches it is on at and the FACTS payment method at each (Administration). */
export function PlatformDialog({ value, onClose, onSaved }: { value: Platform | "new" | null; onClose: () => void; onSaved: () => void }) {
  const existing = value && value !== "new" ? value : null;
  const { company, branch } = useSession();
  const branches = company?.branches ?? [];
  const payModes = useApi<PayMode[]>(value ? "/platforms/payment-modes" : null);
  const modes = payModes.data ?? [];
  // A branch's choice; one not touched yet shows (and saves) the method that looks like the platform's.
  const [f, setF] = useState({ name: "", commissionPct: "", bankFeePct: "", isActive: true, branchIds: [] as string[], paymentModes: {} as Record<string, string>, orderType: "delivery" as Platform["orderType"] });
  const modeOf = (branchId: string) => f.paymentModes[branchId] ?? suggest(modes, branchId, f.name);
  const [seen, setSeen] = useState<typeof value>(null);
  const [busy, setBusy] = useState(false);
  if (value !== seen) {
    setSeen(value);
    setF(existing ? { name: existing.name, commissionPct: String(existing.commissionPct), bankFeePct: String(existing.bankFeePct ?? 0), isActive: existing.isActive, branchIds: existing.branchIds ?? [], paymentModes: existing.paymentModes ?? {}, orderType: existing.orderType ?? "delivery" }
      : { name: "", commissionPct: "", bankFeePct: "", isActive: true, branchIds: branch ? [branch.id] : [], paymentModes: {}, orderType: "delivery" });
  }
  async function save() {
    setBusy(true);
    try {
      const body = { name: f.name, commissionPct: Number(f.commissionPct || 0), bankFeePct: Number(f.bankFeePct || 0), isActive: f.isActive, branchIds: f.branchIds, orderType: f.orderType,
        // Only once the methods are read, so a slow list never wipes the choice.
        ...(payModes.data ? { paymentModes: Object.fromEntries(f.branchIds.map((id) => [id, modeOf(id) || null])) } : {}) };
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
        <Field label="Its orders are" hint={f.orderType === "dine_in" ? "Eaten in: the order gets its table, at this platform's commission." : f.orderType === "takeaway" ? "Collected at the counter by the customer." : "Delivered by the platform."}>
          <Segmented id="platform-type" value={f.orderType} onChange={(v) => setF({ ...f, orderType: v })} className="w-full"
            options={[{ value: "dine_in", label: "Dine-in" }, { value: "takeaway", label: "Takeaway" }, { value: "delivery", label: "Delivery" }]} />
        </Field>
        {branches.length > 0 && (
          <Field label="On at these branches" hint="Only these branches see it at the register and on Prices.">
            <div className="flex flex-wrap gap-1.5">
              {branches.map((b) => {
                const sel = f.branchIds.includes(b.id);
                return (
                  <button key={b.id} type="button" aria-pressed={sel} onClick={() => setF({ ...f, branchIds: sel ? f.branchIds.filter((x) => x !== b.id) : [...f.branchIds, b.id] })}
                    className={cn("h-9 rounded-lg border px-3 text-sm transition-[background-color,transform] active:scale-[0.97]", sel ? "border-primary bg-primary/10 font-medium text-primary" : "bg-card hover:bg-muted")}>
                    {b.name}
                  </button>
                );
              })}
            </div>
          </Field>
        )}
        {f.branchIds.some((id) => modes.some((m) => m.branchId === id)) && (
          <Field label="FACTS payment method" hint="What its bills are paid by in FACTS at each branch.">
            <div className="grid gap-2">
              {branches.filter((b) => f.branchIds.includes(b.id) && modes.some((m) => m.branchId === b.id)).map((b) => (
                <label key={b.id} className="grid grid-cols-[minmax(0,10rem)_1fr] items-center gap-2 text-sm">
                  <span className="truncate">{b.name}</span>
                  <select className={cn(selectClass, "h-9", !modeOf(b.id) && "border-danger text-danger")} value={modeOf(b.id)} aria-label={`FACTS payment method at ${b.name}`}
                    onChange={(e) => setF({ ...f, paymentModes: { ...f.paymentModes, [b.id]: e.target.value } })}>
                    <option value="">Not chosen: its bills can&apos;t post</option>
                    {modes.filter((m) => m.branchId === b.id).map((m) => <option key={m.code} value={m.code}>{m.name}</option>)}
                  </select>
                </label>
              ))}
            </div>
          </Field>
        )}
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
