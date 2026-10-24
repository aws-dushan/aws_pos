"use client";

import { useState } from "react";
import { ClipboardCheckIcon, CookingPotIcon, PackagePlusIcon, PlusIcon, Trash2Icon, TrendingDownIcon } from "lucide-react";
import { toast } from "sonner";
import { api, newKey, useApi } from "@/lib/api";
import { cn, timeAgo } from "@/lib/utils";
import { fmtIn } from "@/lib/num";
import { fmtQty } from "@/lib/pos";
import { useSession } from "@/components/session";
import { useLiveEvent } from "@/components/live";
import { costTone, RecipeDialog, type Ingredient, type RecipeTarget, type Unit } from "@/components/recipe-editor";
import { EmptyState, ErrorNote, Field, LoadingRows, ObjectStatus, PageHeader, SearchField, Segmented, StatTile, Switch, TablePanel, TONE } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

type Cost = { id: string; name: string; category: string; price: number; ingredients: number; cost: number; costPct: number | null };
type Move = { at: string; businessDate: string; kind: "sale" | "return" | "waste" | "receive" | "count" | "adjust"; qty: number; value: number; orderNumber: number | null; note: string | null; byName: string | null };
type UsageRow = { id: string; name: string; unit: Unit; sold: number; wasted: number; received: number; variance: number; adjusted: number; soldValue: number; wastedValue: number; receivedValue: number; varianceValue: number };
type Usage = { from: string; to: string; items: UsageRow[]; netSales: number; soldCost: number; wastedCost: number; varianceCost: number; foodCostPct: number | null };

const UNITS: Unit[] = ["kg", "g", "l", "ml", "pcs"];
const MOVE_LABEL: Record<Move["kind"], string> = { sale: "Sold", return: "Returned to stock", waste: "Thrown away", receive: "Received", count: "Count difference", adjust: "Adjusted" };
const iso = (d: Date) => d.toISOString().slice(0, 10);
const qtyFmt = fmtQty;
const low = (i: Ingredient) => i.parLevel !== null && i.onHand < i.parLevel;

/** Recipes and ingredient stock (REQ INV-01 … INV-03): what's on hand at this branch, receiving, waste, counts, food cost and usage. */
export default function IngredientsPage() {
  const { company, branch, can } = useSession();
  const cur = company?.currency ?? "AED";
  const [tab, setTab] = useState<"stock" | "costs" | "usage">("stock");
  const list = useApi<Ingredient[]>("/ingredients");
  useLiveEvent(["stock.changed", "order.changed"], () => list.reload());
  const [q, setQ] = useState("");
  const [edit, setEdit] = useState<Ingredient | "new" | null>(null);
  const [move, setMove] = useState<"receive" | "waste" | null>(null);
  const [count, setCount] = useState<Record<string, string> | null>(null);
  const [busy, setBusy] = useState(false);
  const canEdit = can("menu.manage");
  const canCount = can("day.manage");
  const rows = (list.data ?? []).filter((i) => !q.trim() || i.name.toLowerCase().includes(q.trim().toLowerCase()));
  const value = (list.data ?? []).reduce((t, i) => t + Math.max(0, i.onHand) * i.cost, 0);
  const lowCount = (list.data ?? []).filter((i) => i.isActive && low(i)).length;

  async function saveCount() {
    if (!count) return;
    const lines = Object.entries(count).filter(([, v]) => v.trim() !== "").map(([ingredientId, v]) => ({ ingredientId, counted: Number(v) }));
    if (!lines.length) { toast.error("Type what's on the shelf for at least one ingredient."); return; }
    setBusy(true);
    try {
      const r = await api<{ counted: number; variance: number }>("/ingredients/count", "POST", { lines }, { key: newKey() });
      toast.success(`${r.counted} counted. Difference ${r.variance < 0 ? "−" : "+"}${cur} ${fmtIn(Math.abs(r.variance), 2)}.`);
      setCount(null);
      list.reload();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader title="Ingredients" icon={CookingPotIcon} module="inv" count={list.data?.length}
        description={`Recipes take ingredients off ${branch?.name ?? "the branch"}'s stock as orders are paid. Receive deliveries, record waste, count the shelves.`}
        actions={tab === "stock" && (count ? <>
          <Button size="lg" variant="outline" onClick={() => setCount(null)}>Cancel count</Button>
          <Button size="lg" disabled={busy} onClick={() => void saveCount()}><ClipboardCheckIcon /> Save count</Button>
        </> : <>
          <Button size="lg" variant="outline" onClick={() => setMove("waste")}><TrendingDownIcon /> Waste</Button>
          {canCount && <Button size="lg" variant="outline" onClick={() => setCount({})}><ClipboardCheckIcon /> Count</Button>}
          <Button size="lg" variant={canEdit ? "outline" : "default"} onClick={() => setMove("receive")}><PackagePlusIcon /> Receive</Button>
          {canEdit && <Button size="lg" onClick={() => setEdit("new")}><PlusIcon /> New ingredient</Button>}
        </>)} />
      <Segmented id="ing-tab" value={tab} onChange={setTab} className="mb-5 w-full max-w-md"
        options={[{ value: "stock", label: "Stock" }, { value: "costs", label: "Food cost" }, { value: "usage", label: "Usage" }]} />
      {tab === "stock" && <>
        <div className="mb-5 grid gap-3 sm:grid-cols-3">
          <StatTile label="Ingredients" value={list.data?.filter((i) => i.isActive).length ?? "…"} icon={CookingPotIcon} module="inv" hint={`${list.data?.filter((i) => i.recipes > 0).length ?? 0} used in recipes`} />
          <StatTile label="Stock value" value={list.data ? `${cur} ${fmtIn(value, 2)}` : "…"} icon={PackagePlusIcon} module="inv" hint="On hand × cost per unit" />
          <StatTile label="Running low" value={list.data ? lowCount : "…"} icon={TrendingDownIcon} module="inv" tone={lowCount ? "danger" : "default"} hint="Below their low-stock level" />
        </div>
        {count && <p className="mb-3 rounded-xl bg-primary/8 px-4 py-2.5 text-sm text-primary">Type what&apos;s on the shelf. Leave a row empty to skip it. Saving makes the count what&apos;s on hand; the difference is kept as the count&apos;s variance.</p>}
        <SearchField value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search ingredients" className="mb-4 w-80 max-w-full" />
        <ErrorNote message={list.error} />
        {list.loading && !list.data ? <LoadingRows /> : rows.length ? (
          <TablePanel>
            <Table>
              <TableHeader><TableRow>
                <TableHead className="pl-5">Ingredient</TableHead><TableHead className="text-right">On hand</TableHead>
                {count && <TableHead className="w-44">Counted</TableHead>}
                <TableHead className="text-right">Cost / unit</TableHead><TableHead className="text-right">Value</TableHead>
                <TableHead className="text-right">Recipes</TableHead><TableHead className="pr-5">Last count</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {rows.map((i) => (
                  <TableRow key={i.id} className={cn(!count && "cursor-pointer", !i.isActive && "opacity-55")} onClick={() => !count && setEdit(i)}>
                    <TableCell className="pl-5">
                      <span className="font-medium">{i.name}</span>{" "}
                      {!i.isActive ? <ObjectStatus className={TONE.muted}>Not in use</ObjectStatus> : i.onHand < 0 ? <ObjectStatus className={TONE.danger}>Below zero</ObjectStatus> : low(i) && <ObjectStatus className={TONE.warn}>Low</ObjectStatus>}
                    </TableCell>
                    <TableCell className={cn("text-right font-medium tabular-nums", i.onHand < 0 && "text-danger")}>{qtyFmt(i.onHand)} <span className="text-xs font-normal text-muted-foreground">{i.unit}</span></TableCell>
                    {count && (
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <div className="relative">
                          <Input inputMode="decimal" value={count[i.id] ?? ""} placeholder={qtyFmt(i.onHand)} className="h-9 pr-10 text-right tabular-nums"
                            onChange={(e) => setCount({ ...count, [i.id]: e.target.value })} aria-label={`Counted ${i.name}`} />
                          <span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-xs text-muted-foreground">{i.unit}</span>
                        </div>
                      </TableCell>
                    )}
                    <TableCell className="text-right tabular-nums text-muted-foreground">{fmtIn(i.cost, i.cost < 1 ? 3 : 2)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtIn(Math.max(0, i.onHand) * i.cost, 2)}</TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">{i.recipes || "—"}</TableCell>
                    <TableCell className="pr-5 text-muted-foreground">{i.countedAt ? timeAgo(i.countedAt) : "Never"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TablePanel>
        ) : (
          <EmptyState icon={CookingPotIcon} title={q ? "No ingredient matches" : "No ingredients yet"} module="inv"
            action={canEdit && !q && <Button size="lg" onClick={() => setEdit("new")}><PlusIcon /> New ingredient</Button>}>
            {q ? `Nothing called “${q}”.` : "Add what the kitchen uses (with its unit and cost), then give menu items their recipes."}
          </EmptyState>
        )}
      </>}
      {tab === "costs" && <CostsTab currency={cur} />}
      {tab === "usage" && <UsageTab currency={cur} />}
      <IngredientDialog value={edit} currency={cur} canEdit={canEdit} onClose={() => setEdit(null)} onSaved={() => list.reload()} />
      <MoveDialog kind={move} ingredients={(list.data ?? []).filter((i) => i.isActive)} currency={cur} onClose={() => setMove(null)} onDone={() => list.reload()} />
    </div>
  );
}

/** Each menu item's recipe cost against its price at this branch. */
function CostsTab({ currency }: { currency: string }) {
  const costs = useApi<Cost[]>("/recipes/costs");
  const [recipeFor, setRecipeFor] = useState<RecipeTarget | null>(null);
  const { can } = useSession();
  const withRecipe = (costs.data ?? []).filter((c) => c.ingredients > 0);
  const avg = withRecipe.length ? withRecipe.reduce((t, c) => t + (c.costPct ?? 0), 0) / withRecipe.length : null;
  return <>
    <div className="mb-5 grid gap-3 sm:grid-cols-3">
      <StatTile label="Items with a recipe" value={costs.data ? `${withRecipe.length} of ${costs.data.length}` : "…"} icon={CookingPotIcon} module="inv" />
      <StatTile label="Average food cost" value={avg === null ? "—" : `${avg.toFixed(1)}%`} icon={TrendingDownIcon} module="inv" hint="Recipe cost ÷ price, items with a recipe" />
      <StatTile label="Above 35%" value={costs.data ? withRecipe.filter((c) => (c.costPct ?? 0) > 35).length : "…"} icon={TrendingDownIcon} module="inv" hint="Worth a look at the price or the recipe" />
    </div>
    <ErrorNote message={costs.error} />
    {costs.loading && !costs.data ? <LoadingRows /> : (
      <TablePanel>
        <Table>
          <TableHeader><TableRow>
            <TableHead className="pl-5">Item</TableHead><TableHead>Category</TableHead><TableHead className="text-right">Price</TableHead>
            <TableHead className="text-right">Recipe cost</TableHead><TableHead className="pr-5 text-right">Food cost</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {(costs.data ?? []).map((c) => (
              <TableRow key={c.id} className={cn(can("menu.manage") && "cursor-pointer")} onClick={() => can("menu.manage") && setRecipeFor({ kind: "item", id: c.id, name: c.name })}>
                <TableCell className="pl-5 font-medium">{c.name}</TableCell>
                <TableCell className="text-muted-foreground">{c.category}</TableCell>
                <TableCell className="text-right tabular-nums">{fmtIn(c.price, 2)}</TableCell>
                <TableCell className="text-right tabular-nums">{c.ingredients ? fmtIn(c.cost, 2) : <ObjectStatus className={TONE.muted}>No recipe</ObjectStatus>}</TableCell>
                <TableCell className={cn("pr-5 text-right font-medium tabular-nums", costTone(c.costPct))}>{c.costPct === null ? "—" : `${c.costPct.toFixed(1)}%`}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TablePanel>
    )}
    <RecipeDialog target={recipeFor} currency={currency} onClose={() => setRecipeFor(null)} onSaved={() => costs.reload()} />
  </>;
}

/** Usage over business days: what sales took by their recipes, waste, deliveries and the counts' differences. */
function UsageTab({ currency }: { currency: string }) {
  const today = iso(new Date());
  const [from, setFrom] = useState(() => { const d = new Date(); d.setDate(d.getDate() - 6); return iso(d); });
  const [to, setTo] = useState(today);
  const u = useApi<Usage>(`/ingredients/usage?from=${from}&to=${to}`);
  const d = u.data;
  return <>
    <div className="mb-5 flex flex-wrap items-end gap-3">
      <label className="grid gap-1 text-xs font-medium text-muted-foreground">From<Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className="h-10 w-40" /></label>
      <label className="grid gap-1 text-xs font-medium text-muted-foreground">To<Input type="date" value={to} min={from} max={today} onChange={(e) => setTo(e.target.value)} className="h-10 w-40" /></label>
    </div>
    <div className="mb-5 grid gap-3 sm:grid-cols-2 md:grid-cols-4">
      <StatTile label="Cost of what sold" value={d ? `${currency} ${fmtIn(d.soldCost, 2)}` : "…"} icon={CookingPotIcon} module="inv" hint="By the recipes, less returns to stock" />
      <StatTile label="Food cost" value={d?.foodCostPct === null || !d ? "—" : `${d.foodCostPct}%`} icon={TrendingDownIcon} module="inv" hint={d ? `Of ${currency} ${fmtIn(d.netSales, 2)} sales of items with a recipe (before VAT)` : undefined} />
      <StatTile label="Thrown away" value={d ? `${currency} ${fmtIn(d.wastedCost, 2)}` : "…"} icon={Trash2Icon} module="inv" />
      <StatTile label="Count differences" value={d ? `${d.varianceCost < 0 ? "−" : ""}${currency} ${fmtIn(Math.abs(d.varianceCost), 2)}` : "…"} icon={ClipboardCheckIcon} module="inv"
        tone={d && d.varianceCost < 0 ? "danger" : "default"} hint="Shelf counts against the books" />
    </div>
    <ErrorNote message={u.error} />
    {u.loading && !d ? <LoadingRows /> : d?.items.length ? (
      <TablePanel>
        <Table>
          <TableHeader><TableRow>
            <TableHead className="pl-5">Ingredient</TableHead><TableHead className="text-right">Sold</TableHead><TableHead className="text-right">Thrown away</TableHead>
            <TableHead className="text-right">Received</TableHead><TableHead className="text-right">Count difference</TableHead><TableHead className="pr-5 text-right">Cost of what sold</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {d.items.map((i) => (
              <TableRow key={i.id}>
                <TableCell className="pl-5 font-medium">{i.name}</TableCell>
                <TableCell className="text-right tabular-nums">{qtyFmt(i.sold)} <span className="text-xs text-muted-foreground">{i.unit}</span></TableCell>
                <TableCell className="text-right tabular-nums">{i.wasted ? qtyFmt(i.wasted) : "—"}</TableCell>
                <TableCell className="text-right tabular-nums">{i.received ? qtyFmt(i.received) : "—"}</TableCell>
                <TableCell className={cn("text-right tabular-nums", i.variance < 0 && "text-danger")}>{i.variance ? `${i.variance > 0 ? "+" : ""}${qtyFmt(i.variance)}` : "—"}</TableCell>
                <TableCell className="pr-5 text-right tabular-nums">{fmtIn(i.soldValue, 2)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TablePanel>
    ) : <EmptyState icon={CookingPotIcon} title="Nothing used in these days" module="inv" compact>Usage shows once items with recipes are sold, or ingredients come in or are counted.</EmptyState>}
  </>;
}

function IngredientDialog({ value, currency, canEdit, onClose, onSaved }: { value: Ingredient | "new" | null; currency: string; canEdit: boolean; onClose: () => void; onSaved: () => void }) {
  const existing = value && value !== "new" ? value : null;
  const [f, setF] = useState({ name: "", unit: "kg" as Unit, cost: "", parLevel: "", isActive: true });
  const [seen, setSeen] = useState<typeof value>(null);
  const [busy, setBusy] = useState(false);
  if (value !== seen) {
    setSeen(value);
    setF(existing ? { name: existing.name, unit: existing.unit, cost: String(existing.cost), parLevel: existing.parLevel === null ? "" : String(existing.parLevel), isActive: existing.isActive }
      : { name: "", unit: "kg", cost: "", parLevel: "", isActive: true });
  }
  const moves = useApi<Move[]>(existing ? `/ingredients/${existing.id}/moves?days=30` : null);

  async function save() {
    setBusy(true);
    try {
      const body = { name: f.name, unit: f.unit, cost: Number(f.cost || 0), parLevel: f.parLevel === "" ? null : Number(f.parLevel), isActive: f.isActive };
      if (existing) await api(`/ingredients/${existing.id}`, "PUT", body); else await api("/ingredients", "POST", body);
      toast.success(existing ? "Ingredient saved." : `${f.name} added.`);
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
      <DialogContent className="max-h-[calc(100dvh-1rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{existing ? existing.name : "New ingredient"}</DialogTitle>
          <DialogDescription>{existing ? `${qtyFmt(existing.onHand)} ${existing.unit} on hand · in ${existing.recipes} recipe${existing.recipes === 1 ? "" : "s"}` : "Recipes use it in its unit, e.g. 0.15 kg of chicken, 1 pcs of bread."}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" required span><Input value={f.name} disabled={!canEdit} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus={!existing} /></Field>
          <Field label="Unit" span hint={existing?.recipes ? "Fixed once it's in a recipe or has stock moves." : undefined}>
            <Segmented id="ing-unit" value={f.unit} onChange={(v) => canEdit && setF({ ...f, unit: v })} className="w-full" options={UNITS.map((u) => ({ value: u, label: u }))} />
          </Field>
          <Field label={`Cost per ${f.unit} (${currency})`}><Input inputMode="decimal" disabled={!canEdit} value={f.cost} onChange={(e) => setF({ ...f, cost: e.target.value })} /></Field>
          <Field label={`Low below (${f.unit})`} hint="Shows as low under this."><Input inputMode="decimal" disabled={!canEdit} value={f.parLevel} onChange={(e) => setF({ ...f, parLevel: e.target.value })} /></Field>
        </div>
        {existing && canEdit && (
          <div className="flex items-center justify-between rounded-xl border px-3 py-2.5">
            <span className="text-sm">In use <span className="text-muted-foreground">· off hides it from new recipes and deliveries</span></span>
            <Switch on={f.isActive} onChange={(v) => setF({ ...f, isActive: v })} label="In use" />
          </div>
        )}
        {existing && (
          <div>
            <div className="mb-2 text-[0.8rem] font-medium text-foreground/80">Last 30 days</div>
            <div className="max-h-64 divide-y overflow-y-auto rounded-xl border">
              {(moves.data ?? []).map((m, i) => (
                <div key={i} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{MOVE_LABEL[m.kind]}{m.orderNumber ? ` · order #${m.orderNumber}` : ""}{m.note ? ` · ${m.note}` : ""}</div>
                    <div className="text-xs text-muted-foreground">{new Date(m.at).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}{m.byName ? ` · ${m.byName}` : ""}</div>
                  </div>
                  <span className={cn("font-medium tabular-nums", m.qty < 0 ? "text-danger" : "text-success")}>{m.qty > 0 ? "+" : "−"}{qtyFmt(Math.abs(m.qty))}</span>
                </div>
              ))}
              {moves.data && !moves.data.length && <p className="px-3 py-4 text-sm text-muted-foreground">Nothing in or out yet.</p>}
              {!moves.data && <div className="h-20 skeleton-shimmer" />}
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{canEdit ? "Cancel" : "Close"}</Button>
          {canEdit && <Button disabled={busy || !f.name.trim()} onClick={() => void save()}>{existing ? "Save" : "Add ingredient"}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A delivery in (with its cost per unit, which becomes the ingredient's cost) or ingredients thrown away (with why). */
function MoveDialog({ kind, ingredients, currency, onClose, onDone }: { kind: "receive" | "waste" | null; ingredients: Ingredient[]; currency: string; onClose: () => void; onDone: () => void }) {
  const [rows, setRows] = useState<{ ingredientId: string; qty: string; cost: string }[]>([]);
  const [note, setNote] = useState("");
  const [was, setWas] = useState(kind);
  const [busy, setBusy] = useState(false);
  if (kind !== was) { setWas(kind); if (kind) { setRows([{ ingredientId: "", qty: "", cost: "" }]); setNote(""); } }
  const byId = new Map(ingredients.map((i) => [i.id, i]));
  const receive = kind === "receive";
  const ready = rows.length > 0 && rows.every((r) => byId.has(r.ingredientId) && Number(r.qty) > 0) && (receive || note.trim());
  const total = rows.reduce((t, r) => t + Number(r.qty || 0) * (r.cost !== "" ? Number(r.cost) : byId.get(r.ingredientId)?.cost ?? 0), 0);

  async function go() {
    setBusy(true);
    try {
      await api("/ingredients/moves", "POST", {
        kind, note: note.trim() || null,
        lines: rows.map((r) => ({ ingredientId: r.ingredientId, qty: Number(r.qty), cost: receive && r.cost !== "" ? Number(r.cost) : null })),
      }, { key: newKey() });
      toast.success(receive ? `${rows.length} ingredient${rows.length === 1 ? "" : "s"} received.` : "Waste recorded.");
      onDone();
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const set = (i: number, patch: Partial<{ ingredientId: string; qty: string; cost: string }>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <Dialog open={!!kind} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[calc(100dvh-1rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{receive ? "Receive ingredients" : "Ingredients thrown away"}</DialogTitle>
          <DialogDescription>{receive ? "What came in. A new cost per unit replaces the ingredient's cost." : "Spoilt, spilt or dropped ingredients. Wasted menu items go on the Stock screen."}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          {rows.map((r, i) => {
            const ing = byId.get(r.ingredientId);
            return (
              <div key={i} className={cn("grid items-center gap-2", receive ? "grid-cols-[1fr_7rem_7rem_auto]" : "grid-cols-[1fr_8rem_auto]")}>
                <select aria-label="Ingredient" value={r.ingredientId} onChange={(e) => set(i, { ingredientId: e.target.value })}
                  className="h-9 min-w-0 rounded-lg border border-input bg-card px-2 text-sm dark:bg-input/30">
                  <option value="">Choose…</option>
                  {ingredients.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </select>
                <div className="relative">
                  <Input value={r.qty} inputMode="decimal" aria-label="Amount" className="h-9 pr-10 text-right tabular-nums" onChange={(e) => set(i, { qty: e.target.value })} />
                  <span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-xs text-muted-foreground">{ing?.unit ?? ""}</span>
                </div>
                {receive && <Input value={r.cost} inputMode="decimal" aria-label="Cost per unit" placeholder={ing ? `${fmtIn(ing.cost, 2)}/${ing.unit}` : "Cost"} className="h-9 text-right tabular-nums" onChange={(e) => set(i, { cost: e.target.value })} />}
                <Button type="button" variant="ghost" size="icon" aria-label="Remove" disabled={rows.length === 1} onClick={() => setRows(rows.filter((_, j) => j !== i))}><Trash2Icon /></Button>
              </div>
            );
          })}
          <Button type="button" variant="outline" onClick={() => setRows([...rows, { ingredientId: "", qty: "", cost: "" }])}><PlusIcon /> Add a line</Button>
        </div>
        <Field label={receive ? "Supplier / note" : "Why"} required={!receive}>
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder={receive ? "e.g. Al Rawabi, invoice 4471" : "e.g. spoilt in the chiller"} />
        </Field>
        <DialogFooter>
          <span className="mr-auto self-center text-sm text-muted-foreground">{currency} {fmtIn(total, 2)}</span>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={busy || !ready} className={cn(!receive && "bg-danger text-white hover:bg-danger/90")} onClick={() => void go()}>
            {receive ? <><PackagePlusIcon /> Receive</> : <><TrendingDownIcon /> Record waste</>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
