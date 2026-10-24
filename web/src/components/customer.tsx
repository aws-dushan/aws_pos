"use client";

import { useEffect, useState } from "react";
import { HeartIcon, UserRoundCheckIcon, UserRoundIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { api, useApi } from "@/lib/api";
import { cn, timeAgo } from "@/lib/utils";
import { fmtIn } from "@/lib/num";
import { fmtQty, TYPE_LABEL, type Order, type OrderType } from "@/lib/pos";
import { Field, ObjectStatus, TONE } from "@/components/kit";
import { useSession } from "@/components/session";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

/*
 * Customers (REQ CUS-01 … CUS-04): optional on every order. At the register a phone number (or name) finds a regular, attached
 * with one tap; a new number with a name becomes a customer when the order is paid.
 */

export type Customer = {
  id: string; name: string; phone: string | null; email: string | null; address: string | null; notes: string | null; isActive: boolean; points: number;
  createdAt: string; visits: number; spend: number; lastVisit: string | null;
  preapprovedPct: number | null; preapprovedReason: string | null; preapprovedUntil: string | null; preapprovedByName: string | null; preapprovedAt: string | null;
};

/** Why a customer's discount is pre-approved (the till and FACTS show this with their name). */
export const PREAPPROVED_REASONS: Record<string, string> = {
  complimentary: "Complimentary", owner: "Owner", guest: "Owner guest", staff: "Staff meal", company: "Company VIP",
};
type Profile = {
  customer: Customer;
  orders: { id: string; number: number; invoiceNo: string | null; closedAt: string | null; branch: string; type: OrderType; total: number; refunded: number; status: string; items: number }[];
  favourites: { name: string; qty: number }[];
};

const money = (n: number) => fmtIn(n, 2);

/** Debounces a value (search as you type without a request per key). */
function useDebounced<T>(value: T, ms = 250) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = window.setTimeout(() => setV(value), ms); return () => window.clearTimeout(t); }, [value, ms]);
  return v;
}

/**
 * The customer part of the order panel. Attached: who it is, their visits and spend, remove. Not attached: as the phone or
 * name is typed, matching customers to attach; whatever is typed stays on the order either way (customer is optional).
 */
export function CustomerBox({ order: o, typed, currency, onAttach }: { order: Order; typed: string; currency: string; onAttach: (customerId: string | null) => void }) {
  const term = useDebounced(typed.trim());
  const search = useApi<Customer[]>(!o.customerId && term.replace(/\D/g, "").length >= 4 || (!o.customerId && /[a-z]{3,}/i.test(term)) ? `/customers?q=${encodeURIComponent(term)}` : null);
  const mine = useApi<Profile>(o.customerId ? `/customers/${o.customerId}` : null);

  const { company } = useSession();
  if (o.customerId && mine.data) {
    const c = mine.data.customer;
    return (
      <div className="flex items-center gap-3 rounded-xl border border-primary/25 bg-primary/5 px-3 py-2 animate-rise-in">
        <UserRoundCheckIcon className="size-5 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{c.name}</div>
          <div className="truncate text-xs text-muted-foreground">
            {c.visits ? `${c.visits} visit${c.visits === 1 ? "" : "s"} · ${currency} ${money(c.spend)}${c.lastVisit ? ` · last ${timeAgo(c.lastVisit)}` : ""}` : "First visit"}
            {company?.loyaltyEnabled && <> · <span className="font-medium text-primary">{c.points.toLocaleString()} pts</span></>}
            {mine.data.favourites[0] && <> · <HeartIcon className="inline size-3 align-[-1px]" /> {mine.data.favourites[0].name}</>}
          </div>
          {c.notes && <div className="truncate text-xs text-warning">{c.notes}</div>}
        </div>
        <Button variant="ghost" size="icon" aria-label="Remove the customer" onClick={() => onAttach(null)}><XIcon /></Button>
      </div>
    );
  }
  const hits = (search.data ?? []).slice(0, 4);
  if (!hits.length) return null;
  return (
    <div className="space-y-1 animate-rise-in">
      {hits.map((c) => (
        <button key={c.id} type="button" onClick={() => onAttach(c.id)}
          className="flex h-11 w-full items-center gap-3 rounded-xl border bg-card px-3 text-left text-sm transition-colors hover:bg-muted active:scale-[0.99]">
          <UserRoundIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate"><span className="font-medium">{c.name}</span>{c.phone && <span className="text-muted-foreground"> · {c.phone}</span>}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{c.visits ? `${c.visits} visits` : "new"}</span>
        </button>
      ))}
    </div>
  );
}

/** A customer's profile: details (editable), favourites and order history. "new" to add one. */
export function CustomerDialog({ value, currency, onClose, onSaved }: { value: string | "new" | null; currency: string; onClose: () => void; onSaved: () => void }) {
  const { company } = useSession();
  const p = useApi<Profile>(value && value !== "new" ? `/customers/${value}` : null);
  const [f, setF] = useState({ name: "", phone: "", email: "", address: "", notes: "" });
  const [seen, setSeen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const key = value === "new" ? "new" : p.data?.customer.id ?? null;
  if (key !== seen && (value === "new" || p.data)) {
    setSeen(key);
    const c = value === "new" ? null : p.data!.customer;
    setF({ name: c?.name ?? "", phone: c?.phone ?? "", email: c?.email ?? "", address: c?.address ?? "", notes: c?.notes ?? "" });
  }
  async function save() {
    setBusy(true);
    try {
      await api(value === "new" ? "/customers" : `/customers/${value}`, value === "new" ? "POST" : "PUT", f);
      toast.success(value === "new" ? `${f.name} added` : "Customer saved");
      onSaved(); onClose(); setSeen(null);
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  const c = p.data?.customer;
  return (
    <Dialog open={!!value} onOpenChange={(o) => { if (!o) { onClose(); setSeen(null); } }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{value === "new" ? "New customer" : c?.name ?? "Customer"}</DialogTitle>
          <DialogDescription>
            {value === "new" ? "Name and phone are enough; the register finds them by phone next time."
              : c ? `${c.visits} visit${c.visits === 1 ? "" : "s"} · ${currency} ${money(c.spend)} spent${company?.loyaltyEnabled ? ` · ${c.points.toLocaleString()} points` : ""} · customer since ${new Date(c.createdAt).toLocaleDateString("en-GB", { month: "short", year: "numeric" })}` : "Loading…"}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" required><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} className="h-11" /></Field>
          <Field label="Phone"><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} inputMode="tel" className="h-11" /></Field>
          <Field label="Email"><Input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} inputMode="email" className="h-11" /></Field>
          <Field label="Delivery address"><Input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} className="h-11" /></Field>
          <Field label="Notes" hint="Shown at the register, e.g. allergies or preferences." span><Textarea rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
        </div>
        {p.data && (
          <div className="grid gap-4 sm:grid-cols-[1fr_2fr]">
            <div>
              <div className="mb-1.5 text-xs font-medium text-muted-foreground">Favourites</div>
              {p.data.favourites.length ? p.data.favourites.map((x) => (
                <div key={x.name} className="flex justify-between text-sm"><span className="truncate">{x.name}</span><span className="tabular-nums text-muted-foreground">{fmtQty(x.qty)}</span></div>
              )) : <div className="text-sm text-muted-foreground">None yet</div>}
            </div>
            <div>
              <div className="mb-1.5 text-xs font-medium text-muted-foreground">Orders</div>
              <div className="max-h-48 divide-y overflow-y-auto rounded-xl border">
                {p.data.orders.length ? p.data.orders.map((o) => (
                  <div key={o.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                    <span className="w-24 shrink-0 text-muted-foreground">{o.closedAt ? new Date(o.closedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "open"}</span>
                    <span className="min-w-0 flex-1 truncate">{o.branch} · {TYPE_LABEL[o.type]} · {o.items} item{o.items === 1 ? "" : "s"}</span>
                    {o.status === "refunded" && <ObjectStatus className={TONE.violet}>Refunded</ObjectStatus>}
                    <span className={cn("tabular-nums", o.refunded > 0 && "text-muted-foreground")}>{money(o.total)}</span>
                  </div>
                )) : <div className="px-3 py-4 text-center text-sm text-muted-foreground">No orders yet</div>}
              </div>
            </div>
          </div>
        )}
        {c && <PreapprovedBox customer={c} onSaved={() => { p.reload(); onSaved(); }} />}
        <DialogFooter>
          {c && <Button variant="ghost" className="mr-auto" onClick={() => void api(`/customers/${c.id}`, "PUT", { ...f, isActive: !c.isActive }).then(() => { toast.success(c.isActive ? "Customer archived" : "Customer restored"); onSaved(); onClose(); setSeen(null); }, (e: Error) => toast.error(e.message))}>
            {c.isActive ? "Archive" : "Restore"}
          </Button>}
          <Button variant="outline" onClick={() => { onClose(); setSeen(null); }}>Cancel</Button>
          <Button disabled={busy || !f.name.trim()} onClick={() => void save()}>{value === "new" ? "Add customer" : "Save"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A customer's pre-approved discount (e.g. 100 % complimentary for the owner): set once by a manager allowed to; attaching the
 * customer to a bill then gives it on the whole bill with no approval request. No cap; an end date is optional.
 */
function PreapprovedBox({ customer: c, onSaved }: { customer: Customer; onSaved: () => void }) {
  const { can } = useSession();
  const allowed = can("customers.preapprove");
  const [f, setF] = useState({ pct: c.preapprovedPct ? String(c.preapprovedPct) : "100", reason: c.preapprovedReason ?? "complimentary", until: c.preapprovedUntil ?? "" });
  const [busy, setBusy] = useState(false);
  async function save(off = false) {
    setBusy(true);
    try {
      await api(`/customers/${c.id}/preapproved`, "PUT", off ? { pct: null } : { pct: Number(f.pct), reason: f.reason, until: f.until || null });
      toast.success(off ? "Pre-approved discount taken off." : `${c.name} gets ${f.pct}% at the till, no approval needed.`);
      onSaved();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  if (!allowed && !c.preapprovedPct) return null;
  return (
    <div className="rounded-xl border p-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        <UserRoundCheckIcon className="size-4 text-mod-sales" /> Pre-approved discount
        {c.preapprovedPct ? <ObjectStatus className={TONE.done}>{c.preapprovedPct}% · {PREAPPROVED_REASONS[c.preapprovedReason ?? ""] ?? c.preapprovedReason}</ObjectStatus>
          : <ObjectStatus className={TONE.muted}>None</ObjectStatus>}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {c.preapprovedPct
          ? `Given on the whole bill when ${c.name} is attached, no approval needed${c.preapprovedUntil ? `, until ${c.preapprovedUntil}` : ""}. Approved by ${c.preapprovedByName ?? "a manager"}${c.preapprovedAt ? `, ${timeAgo(c.preapprovedAt)}` : ""}.`
          : "Set it once: the till then gives it on the whole bill with no approval request."}
      </p>
      {allowed && (
        <>
          <div className="mt-2 grid gap-3 sm:grid-cols-3">
            <Field label="Discount %"><Input value={f.pct} inputMode="decimal" onChange={(e) => setF({ ...f, pct: e.target.value })} className="h-10" /></Field>
            <Field label="Reason">
              <select value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} className="h-10 w-full rounded-xl border border-input bg-card px-3 text-sm dark:bg-input/30">
                {Object.entries(PREAPPROVED_REASONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </Field>
            <Field label="Until (optional)"><Input type="date" value={f.until} onChange={(e) => setF({ ...f, until: e.target.value })} className="h-10" /></Field>
          </div>
          <div className="mt-2 flex gap-2">
            <Button className="h-10" disabled={busy || !(Number(f.pct) > 0 && Number(f.pct) <= 100)} onClick={() => void save()}>{c.preapprovedPct ? "Save" : "Pre-approve"}</Button>
            {c.preapprovedPct && <Button variant="outline" className="h-10" disabled={busy} onClick={() => void save(true)}>Take off</Button>}
          </div>
        </>
      )}
    </div>
  );
}
