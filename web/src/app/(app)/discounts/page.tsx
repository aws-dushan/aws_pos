"use client";

import { useState } from "react";
import { PencilIcon, PercentIcon, PlusIcon } from "lucide-react";
import { toast } from "sonner";
import { api, useApi } from "@/lib/api";
import { cn } from "@/lib/utils";
import { fmtIn } from "@/lib/num";
import type { Menu } from "@/lib/pos";
import { useSession } from "@/components/session";
import { EmptyState, ErrorNote, Field, LoadingRows, PageHeader, Pill, SearchField, Segmented, Switch, TablePanel, TONE } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

type Kind = "promotion" | "cashier";
type Discount = {
  id: string; kind: Kind; name: string; type: "pct" | "amount" | "price"; value: number;
  appliesTo: "all" | "categories" | "items"; categoryIds: string[]; itemIds: string[];
  target: "bill" | "item"; roleIds: string[]; needsNote: boolean;
  validFrom: string; validTo: string | null; days: number[]; timeFrom: string | null; timeTo: string | null;
  branchIds: string[]; channel: "all" | "instore" | "platforms" | "platform"; platformId: string | null; isActive: boolean;
};
type Role = { id: string; name: string };
type Platform = { id: string; name: string; isActive: boolean };

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const money = (n: number) => fmtIn(n, 2);
const day = (d: string) => new Date(d + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
const hm = (t: string | null) => (t ? t.slice(0, 5) : null);

/** What it gives, in words: "20% off", "AED 5 off each", "Fixed price AED 15". */
function what(d: Pick<Discount, "type" | "value" | "kind" | "target">, cur: string) {
  if (d.type === "pct") return `${d.value}% off`;
  if (d.type === "price") return `Fixed price ${cur} ${money(d.value)}`;
  return `${cur} ${money(d.value)} off${d.kind === "promotion" || d.target === "item" ? " each" : ""}`;
}

/** Running now, starts later, ended or switched off. */
function status(d: Discount, today: string): { label: string; tone: string } {
  if (!d.isActive) return { label: "Off", tone: TONE.muted };
  if (d.kind === "promotion" && d.validFrom > today) return { label: `Starts ${day(d.validFrom)}`, tone: TONE.open };
  if (d.kind === "promotion" && d.validTo && d.validTo < today) return { label: "Ended", tone: TONE.muted };
  return { label: d.kind === "promotion" ? "Running" : "In use", tone: TONE.done };
}

/**
 * Discounts (approved 19-10-2026): promotions the till applies by itself, and the ready-made cashier discounts. Changes apply to
 * items added from now on; bills already rung keep what they got. Shows the header branch's (its own and every-branch ones), or all.
 */
export default function DiscountsPage() {
  const { company, me, branch } = useSession();
  const [scope, setScope] = useState<"branch" | "all">("branch");
  const cur = company?.currency ?? "AED";
  const [tab, setTab] = useState<Kind>("promotion");
  const [q, setQ] = useState("");
  const list = useApi<{ discounts: Discount[]; today: string }>(`/discounts${scope === "all" ? "?all=true" : ""}`);
  const menu = useApi<Menu>("/menu");
  const roles = useApi<Role[]>(company ? `/companies/${company.id}/roles` : null);
  const platforms = useApi<Platform[]>("/platforms");
  const [edit, setEdit] = useState<Discount | Kind | null>(null);
  const today = list.data?.today ?? new Date().toISOString().slice(0, 10);
  const branches = company?.branches ?? [];
  const cats = new Map((menu.data?.categories ?? []).map((c) => [c.id, c.name]));
  const items = new Map((menu.data?.items ?? []).map((i) => [i.id, i.name]));
  const rows = (list.data?.discounts ?? []).filter((d) => d.kind === tab && (!q || d.name.toLowerCase().includes(q.toLowerCase())));

  function on(d: Discount): string {
    if (d.kind === "cashier") return d.target === "bill" ? "Whole bill" : "One item";
    if (d.appliesTo === "all") return "All items";
    const names = d.appliesTo === "categories" ? d.categoryIds.map((id) => cats.get(id) ?? "?") : d.itemIds.map((id) => items.get(id) ?? "?");
    return names.length > 3 ? `${names.slice(0, 3).join(", ")} +${names.length - 3}` : names.join(", ");
  }
  function when(d: Discount): string {
    const parts = [d.validTo ? `${day(d.validFrom)} – ${day(d.validTo)}` : `From ${day(d.validFrom)}, no end date`];
    if (d.days.length) parts.push(d.days.map((x) => DAYS[x - 1]).join(" "));
    if (d.timeFrom || d.timeTo) parts.push(`${hm(d.timeFrom) ?? "open"}–${hm(d.timeTo) ?? "close"}`);
    if (d.branchIds.length) parts.push(d.branchIds.map((id) => branches.find((b) => b.id === id)?.name ?? "?").join(", "));
    if (d.channel !== "all") parts.push(d.channel === "instore" ? "In store" : d.channel === "platforms" ? "Delivery platforms" : (platforms.data ?? []).find((p) => p.id === d.platformId)?.name ?? "A platform");
    return parts.join(" · ");
  }

  return (
    <div className="mx-auto max-w-[1180px] pb-6">
      <PageHeader title="Discounts" icon={PercentIcon} count={list.data?.discounts.length ?? null}
        description="Promotions the till applies by itself, and the ready-made discounts cashiers can give. An item never gets two discounts: it gets the bigger one."
        actions={<Button className="h-11" onClick={() => setEdit(tab)}><PlusIcon /> {tab === "promotion" ? "New promotion" : "New cashier discount"}</Button>} />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Segmented id="disc-tab" value={tab} onChange={setTab} options={[{ value: "promotion", label: "Promotions" }, { value: "cashier", label: "Cashier discounts" }]} />
        <Segmented id="disc-scope" value={scope} onChange={setScope} options={[{ value: "branch", label: "This branch" }, { value: "all", label: "All branches" }]} />
        <SearchField placeholder="Search by name" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-xs flex-1" />
      </div>
      {list.error ? <ErrorNote message={list.error} /> : list.loading && !list.data ? <LoadingRows /> : rows.length === 0 ? (
        <EmptyState icon={PercentIcon} title={q ? "Nothing matches" : tab === "promotion" ? "No promotions yet" : "No cashier discounts yet"} module="sales"
          action={!q ? <Button size="lg" onClick={() => setEdit(tab)}><PlusIcon /> {tab === "promotion" ? "New promotion" : "New cashier discount"}</Button> : undefined}>
          {tab === "promotion" ? "A promotion applies by itself on the till, e.g. Beverages 20% off every day 3–6 pm." : "Ready-made discounts cashiers pick on the till, e.g. Staff 20% or Damaged item AED 5."}
        </EmptyState>
      ) : (
        <TablePanel>
          <Table>
            <TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Gives</TableHead><TableHead>{tab === "promotion" ? "On" : "For"}</TableHead>
              <TableHead>{tab === "promotion" ? "When and where" : "Who can give it"}</TableHead><TableHead>Status</TableHead><TableHead className="w-0" /></TableRow></TableHeader>
            <TableBody>
              {rows.map((d) => {
                const s = status(d, today);
                return (
                  <TableRow key={d.id}>
                    <TableCell className="font-medium whitespace-normal">{d.name}</TableCell>
                    <TableCell className="whitespace-nowrap">{what(d, cur)}</TableCell>
                    <TableCell className="whitespace-normal text-sm">{on(d)}</TableCell>
                    <TableCell className="whitespace-normal text-sm text-muted-foreground">
                      {d.kind === "promotion" ? when(d) : (d.roleIds.length ? d.roleIds.map((id) => (roles.data ?? []).find((r) => r.id === id)?.name ?? "?").join(", ") : "Anyone who may discount (within their limit)") + (d.needsNote ? " · name/reason needed" : "")}
                    </TableCell>
                    <TableCell><Pill className={s.tone} dot>{s.label}</Pill></TableCell>
                    <TableCell><Button size="sm" variant="outline" onClick={() => setEdit(d)}><PencilIcon /> Edit</Button></TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TablePanel>
      )}
      {edit && <DiscountForm value={edit} today={today} branchId={branch?.id ?? null} currency={cur} menu={menu.data ?? null} roles={roles.data ?? []} platforms={(platforms.data ?? []).filter((p) => p.isActive)}
        branches={branches.map((b) => ({ id: b.id, name: b.name }))} isAdmin={me.user.isAdmin}
        onClose={() => setEdit(null)} onSaved={() => { setEdit(null); list.reload(); }} />}
    </div>
  );
}

function Chips<T extends string | number>({ options, value, onChange }: { options: { value: T; label: string }[]; value: T[]; onChange: (v: T[]) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const sel = value.includes(o.value);
        return (
          <button key={String(o.value)} type="button" aria-pressed={sel} onClick={() => onChange(sel ? value.filter((x) => x !== o.value) : [...value, o.value])}
            className={cn("h-9 rounded-lg border px-3 text-sm transition-[background-color,transform] active:scale-[0.97]", sel ? "border-primary bg-primary/10 font-medium text-primary" : "bg-card hover:bg-muted")}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** One form for a promotion or a cashier discount: plain choices, the optional ones optional. */
function DiscountForm({ value, today, branchId, currency, menu, roles, platforms, branches, onClose, onSaved }: {
  value: Discount | Kind; today: string; branchId: string | null; currency: string; menu: Menu | null; roles: Role[]; platforms: Platform[]; branches: { id: string; name: string }[];
  isAdmin: boolean; onClose: () => void; onSaved: () => void;
}) {
  const existing = typeof value === "string" ? null : value;
  const kind: Kind = existing?.kind ?? (value as Kind);
  const [f, setF] = useState<Omit<Discount, "id">>(existing ?? {
    kind, name: "", type: "pct", value: 0, appliesTo: "all", categoryIds: [], itemIds: [], target: "bill", roleIds: [], needsNote: false,
    validFrom: today, validTo: null, days: [], timeFrom: null, timeTo: null, branchIds: branchId ? [branchId] : [], channel: "all", platformId: null, isActive: true,
  });
  const [valueText, setValueText] = useState(existing ? String(existing.value) : "");
  const [itemQ, setItemQ] = useState("");
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const promo = kind === "promotion";

  async function save() {
    setBusy(true);
    try {
      const body = { ...f, value: Number(valueText || 0), timeFrom: f.timeFrom || null, timeTo: f.timeTo || null, validTo: f.validTo || null };
      if (existing) await api(`/discounts/${existing.id}`, "PUT", body); else await api("/discounts", "POST", body);
      toast.success(`${promo ? "Promotion" : "Cashier discount"} "${f.name}" saved.`);
      onSaved();
    } catch (e) { toast.error((e as Error).message); setBusy(false); }
  }

  const itemMatches = itemQ.trim().length >= 2 ? (menu?.items ?? []).filter((i) => i.isActive && !f.itemIds.includes(i.id) && i.name.toLowerCase().includes(itemQ.trim().toLowerCase())).slice(0, 8) : [];

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[calc(100dvh-1rem)] sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{existing ? `Edit · ${existing.name}` : promo ? "New promotion" : "New cashier discount"}</DialogTitle>
          <DialogDescription>{promo ? "The till applies it by itself to the items below, when and where you choose." : "Cashiers pick it from the list on the till."} Changes apply to items added from now on.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" hint="Shown on the bill and receipt." span><Input value={f.name} onChange={(e) => set("name", e.target.value)} placeholder={promo ? "e.g. Happy hour" : "e.g. Staff 20%"} /></Field>
          <Field label="Gives" span>
            <Segmented id="d-type" value={f.type} onChange={(v) => set("type", v)} className="w-full"
              options={promo ? [{ value: "pct", label: "% off" }, { value: "amount", label: `${currency} off each` }, { value: "price", label: "Fixed price" }]
                : [{ value: "pct", label: "% off" }, { value: "amount", label: `${currency} off` }]} />
          </Field>
          <Field label={f.type === "pct" ? "Percent" : f.type === "price" ? `Price (${currency})` : `Amount (${currency})`}>
            <Input inputMode="decimal" value={valueText} onChange={(e) => setValueText(e.target.value.replace(",", "."))} placeholder={f.type === "pct" ? "e.g. 20" : "e.g. 5"} />
          </Field>
          {!promo && (
            <Field label="For">
              <Segmented id="d-target" value={f.target} onChange={(v) => set("target", v)} className="w-full" options={[{ value: "bill", label: "Whole bill" }, { value: "item", label: "One item" }]} />
            </Field>
          )}
          {promo && (
            <>
              <Field label="On" span>
                <Segmented id="d-applies" value={f.appliesTo} onChange={(v) => set("appliesTo", v)} className="w-full"
                  options={[{ value: "all", label: "All items" }, { value: "categories", label: "Categories" }, { value: "items", label: "Chosen items" }]} />
              </Field>
              {f.appliesTo === "categories" && (
                <Field label="Categories" span><Chips options={(menu?.categories ?? []).map((c) => ({ value: c.id, label: c.name }))} value={f.categoryIds} onChange={(v) => set("categoryIds", v)} /></Field>
              )}
              {f.appliesTo === "items" && (
                <Field label="Items" span>
                  <div className="space-y-2">
                    <div className="flex flex-wrap gap-1.5">
                      {f.itemIds.map((id) => (
                        <button key={id} type="button" onClick={() => set("itemIds", f.itemIds.filter((x) => x !== id))} className="h-9 rounded-lg border border-primary bg-primary/10 px-3 text-sm font-medium text-primary">
                          {(menu?.items ?? []).find((i) => i.id === id)?.name ?? "?"} ✕
                        </button>
                      ))}
                    </div>
                    <div className="relative">
                      <SearchField placeholder="Add an item: type its name" value={itemQ} onChange={(e) => setItemQ(e.target.value)} />
                      {itemMatches.length > 0 && (
                        <div className="absolute inset-x-0 top-full z-30 mt-1 max-h-56 overflow-y-auto rounded-xl border bg-popover p-1 shadow-pop">
                          {itemMatches.map((i) => (
                            <button key={i.id} type="button" className="flex w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-muted" onClick={() => { set("itemIds", [...f.itemIds, i.id]); setItemQ(""); }}>{i.name}</button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </Field>
              )}
              <Field label="From"><Input type="date" value={f.validFrom} onChange={(e) => set("validFrom", e.target.value)} /></Field>
              <Field label="To" hint="Leave empty: no end date.">
                <div className="flex gap-2">
                  <Input type="date" value={f.validTo ?? ""} onChange={(e) => set("validTo", e.target.value || null)} />
                  {f.validTo && <Button variant="ghost" className="h-11" onClick={() => set("validTo", null)}>No end</Button>}
                </div>
              </Field>
              <Field label="Days" hint="None chosen: every day." span><Chips options={DAYS.map((d, i) => ({ value: i + 1, label: d }))} value={f.days} onChange={(v) => set("days", v)} /></Field>
              <Field label="From time" hint="Optional, e.g. 15:00."><Input type="time" value={hm(f.timeFrom) ?? ""} onChange={(e) => set("timeFrom", e.target.value || null)} /></Field>
              <Field label="To time" hint="Optional, e.g. 18:00."><Input type="time" value={hm(f.timeTo) ?? ""} onChange={(e) => set("timeTo", e.target.value || null)} /></Field>
              {branches.length > 1 && (
                <Field label="Branches" hint="None chosen: every branch." span><Chips options={branches.map((b) => ({ value: b.id, label: b.name }))} value={f.branchIds} onChange={(v) => set("branchIds", v)} /></Field>
              )}
              <Field label="Orders" span>
                <Segmented id="d-channel" value={f.channel} onChange={(v) => set("channel", v)} className="w-full"
                  options={[{ value: "all", label: "All" }, { value: "instore", label: "In store" }, { value: "platforms", label: "Delivery platforms" }, ...(platforms.length ? [{ value: "platform" as const, label: "One platform" }] : [])]} />
              </Field>
              {f.channel === "platform" && (
                <Field label="Platform" span><Chips options={platforms.map((p) => ({ value: p.id, label: p.name }))} value={f.platformId ? [f.platformId] : []} onChange={(v) => set("platformId", v.at(-1) ?? null)} /></Field>
              )}
            </>
          )}
          {!promo && (
            <>
              <Field label="Who can give it" hint="None chosen: anyone allowed to discount, within their limit." span>
                <Chips options={roles.map((r) => ({ value: r.id, label: r.name }))} value={f.roleIds} onChange={(v) => set("roleIds", v)} />
              </Field>
              <div className="flex items-center justify-between gap-3 rounded-xl border px-4 py-3 sm:col-span-2">
                <span className="text-sm"><span className="font-medium">Name or reason needed</span> <span className="text-muted-foreground">· e.g. the staff member for a staff discount</span></span>
                <Switch on={f.needsNote} onChange={(v) => set("needsNote", v)} label="Name or reason needed" />
              </div>
            </>
          )}
          <div className="flex items-center justify-between gap-3 rounded-xl border px-4 py-3 sm:col-span-2">
            <span className="text-sm font-medium">{f.isActive ? "On" : "Off"}</span>
            <Switch on={f.isActive} onChange={(v) => set("isActive", v)} label="On" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" className="h-11" onClick={onClose}>Cancel</Button>
          <Button className="h-11 min-w-36" disabled={busy || !f.name.trim() || !(Number(valueText) > 0 || (f.type === "price" && valueText !== ""))} onClick={() => void save()}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
