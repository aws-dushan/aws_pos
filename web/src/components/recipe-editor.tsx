"use client";

import { useState } from "react";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { api, useApi } from "@/lib/api";
import { cn } from "@/lib/utils";
import { fmtIn } from "@/lib/num";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

export type Unit = "kg" | "g" | "l" | "ml" | "pcs";
export type Ingredient = {
  id: string; name: string; unit: Unit; cost: number; parLevel: number | null; isActive: boolean; onHand: number; countedAt: string | null; recipes: number;
};
export type Recipe = { lines: { ingredientId: string; name: string; unit: Unit; qty: number; cost: number; lineCost: number }[]; cost: number; price: number | null; costPct: number | null };
export type RecipeTarget = { kind: "item" | "option"; id: string; name: string };

/** Food cost as a share of the price: green to 30%, amber to 40%, red above. */
export function costTone(pct: number | null) {
  return pct === null ? "text-muted-foreground" : pct <= 30 ? "text-success" : pct <= 40 ? "text-warning" : "text-danger";
}

/**
 * A menu item's (or option's) recipe: how much of each ingredient one uses, in the ingredient's unit. Shows the cost of one
 * against the price. A paid order takes the recipe off the branch's ingredient stock.
 */
export function RecipeDialog({ target, currency, onClose, onSaved }: { target: RecipeTarget | null; currency: string; onClose: () => void; onSaved?: (r: Recipe) => void }) {
  const recipe = useApi<Recipe>(target ? `/recipes/${target.kind}/${target.id}` : null);
  const ingredients = useApi<Ingredient[]>(target ? "/ingredients" : null);
  const [rows, setRows] = useState<{ ingredientId: string; qty: string }[] | null>(null);
  const [seen, setSeen] = useState<Recipe | null>(null);
  const [busy, setBusy] = useState(false);
  if (recipe.data && recipe.data !== seen) { setSeen(recipe.data); setRows(recipe.data.lines.map((l) => ({ ingredientId: l.ingredientId, qty: String(l.qty) }))); }
  if (!target && seen) { setSeen(null); setRows(null); }

  const byId = new Map((ingredients.data ?? []).map((i) => [i.id, i]));
  const lines = (rows ?? []).map((r) => {
    const ing = byId.get(r.ingredientId);
    return { ...r, ing, cost: ing ? Number(r.qty || 0) * ing.cost : 0 };
  });
  const cost = lines.reduce((t, l) => t + l.cost, 0);
  const price = recipe.data?.price ?? null;
  const pct = price && price > 0 && lines.length ? (cost / price) * 100 : null;
  const valid = lines.every((l) => l.ing && Number(l.qty) > 0) && new Set(lines.map((l) => l.ingredientId)).size === lines.length;

  async function save() {
    if (!target) return;
    setBusy(true);
    try {
      const r = await api<Recipe>(`/recipes/${target.kind}/${target.id}`, "PUT", { lines: lines.map((l) => ({ ingredientId: l.ingredientId, qty: Number(l.qty) })) });
      toast.success(`Recipe of ${target.name} saved.`);
      onSaved?.(r);
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const set = (i: number, patch: Partial<{ ingredientId: string; qty: string }>) => setRows((rows ?? []).map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const active = (ingredients.data ?? []).filter((i) => i.isActive);
  return (
    <Dialog open={!!target} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[calc(100dvh-1rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Recipe · {target?.name}</DialogTitle>
          <DialogDescription>What one {target?.kind === "option" ? "choice of this option adds" : "of it uses"}. Each sale takes it off the branch&apos;s ingredient stock.</DialogDescription>
        </DialogHeader>
        {!rows || !ingredients.data ? <div className="h-32 rounded-xl skeleton-shimmer" /> : !ingredients.data.length ? (
          <p className="rounded-xl bg-muted/50 px-4 py-3 text-sm text-muted-foreground">No ingredients yet. Add them on the Ingredients screen first.</p>
        ) : (
          <div className="space-y-2">
            {lines.map((l, i) => (
              <div key={i} className="grid grid-cols-[1fr_7.5rem_5.5rem_auto] items-center gap-2">
                <select aria-label="Ingredient" value={l.ingredientId} onChange={(e) => set(i, { ingredientId: e.target.value })}
                  className="h-9 min-w-0 rounded-lg border border-input bg-card px-2 text-sm dark:bg-input/30">
                  <option value="">Choose…</option>
                  {active.concat(l.ing && !l.ing.isActive ? [l.ing] : []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </select>
                <div className="relative">
                  <Input value={l.qty} inputMode="decimal" aria-label="Amount" className="h-9 pr-10 text-right tabular-nums" onChange={(e) => set(i, { qty: e.target.value })} />
                  <span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-xs text-muted-foreground">{l.ing?.unit ?? ""}</span>
                </div>
                <span className="text-right text-sm tabular-nums text-muted-foreground">{fmtIn(l.cost, 2)}</span>
                <Button type="button" variant="ghost" size="icon" aria-label="Remove" onClick={() => setRows((rows ?? []).filter((_, j) => j !== i))}><Trash2Icon /></Button>
              </div>
            ))}
            <Button type="button" variant="outline" onClick={() => setRows([...(rows ?? []), { ingredientId: "", qty: "" }])}><PlusIcon /> Add ingredient</Button>
            <div className="mt-3 flex items-center justify-between rounded-xl bg-muted/50 px-4 py-3">
              <span className="text-sm text-muted-foreground">Cost of one{price !== null ? ` · price ${currency} ${fmtIn(price, 2)}` : ""}</span>
              <span className="font-heading text-lg font-semibold tabular-nums">
                {currency} {fmtIn(cost, 2)}{pct !== null && <span className={cn("ml-2 text-sm", costTone(pct))}>{pct.toFixed(1)}%</span>}
              </span>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={busy || !rows || !valid} onClick={() => void save()}>Save recipe</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
