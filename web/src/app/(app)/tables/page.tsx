"use client";

import { useState } from "react";
import { CircleIcon, LayoutGridIcon, PencilIcon, PlusIcon, RectangleHorizontalIcon, SquareIcon, Trash2Icon, UsersRoundIcon } from "lucide-react";
import { toast } from "sonner";
import { api, useApi } from "@/lib/api";
import type { FloorData, FloorTable } from "@/lib/pos";
import { useSession } from "@/components/session";
import { useLiveEvent } from "@/components/live";
import { EmptyState, Field, PageHeader, Segmented } from "@/components/kit";
import { FloorCanvas, type Table } from "@/components/floor-canvas";
import { confirmDialog } from "@/components/confirm";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const SIZE = { round: { w: 2, h: 2 }, square: { w: 2, h: 2 }, rect: { w: 4, h: 2 } } as const;
type Shape = keyof typeof SIZE;

/**
 * The floor-plan designer (REQ TBL-01 … TBL-03): floors, and tables dragged onto a snap grid (they can't overlap), with name,
 * seats and shape. Changes show on every till's floor at once.
 */
export default function TablesPage() {
  const { branch } = useSession();
  const floor = useApi<FloorData>("/floor");
  useLiveEvent(["floor.changed"], () => floor.reload());
  const [floorId, setFloorId] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [floorDialog, setFloorDialog] = useState<{ id?: string; name: string } | null>(null);
  const d = floor.data;
  const current = d?.floors.find((f) => f.id === floorId) ?? d?.floors[0];
  const sel = d?.tables.find((t) => t.id === selected) ?? null;

  async function save(t: FloorTable, patch: Partial<FloorTable>) {
    const n = { ...t, ...patch };
    try { await api(`/tables/${t.id}`, "PUT", { floorId: n.floorId, name: n.name, seats: n.seats, shape: n.shape, x: n.x, y: n.y, w: n.w, h: n.h }); floor.reload(); return true; }
    catch (e) { toast.error((e as Error).message); floor.reload(); return false; }
  }

  async function addTable(shape: Shape) {
    if (!d || !current) return;
    const { w, h } = SIZE[shape];
    const on = d.tables.filter((t) => t.floorId === current.id);
    // The first free spot, scanning row by row, with a cell of space around tables.
    let spot: { x: number; y: number } | null = null;
    for (let y = 1; y + h <= d.rows - 1 && !spot; y++)
      for (let x = 1; x + w <= d.cols - 1 && !spot; x++)
        if (!on.some((t) => t.x < x + w + 1 && x - 1 < t.x + t.w && t.y < y + h + 1 && y - 1 < t.y + t.h)) spot = { x, y };
    if (!spot) return toast.error("This floor is full. Move tables closer or add another floor.");
    const used = new Set(d.tables.map((t) => t.name));
    let k = d.tables.length + 1;
    while (used.has(`T${k}`)) k++;
    try {
      const r = await api<{ id: string }>("/tables", "POST", { floorId: current.id, name: `T${k}`, seats: shape === "rect" ? 6 : shape === "round" ? 2 : 4, shape, ...spot, w, h });
      floor.reload(); setSelected(r.id);
    } catch (e) { toast.error((e as Error).message); }
  }

  async function saveFloor() {
    if (!floorDialog) return;
    try {
      if (floorDialog.id) await api(`/floors/${floorDialog.id}`, "PUT", { name: floorDialog.name });
      else { const r = await api<{ id: string }>("/floors", "POST", { name: floorDialog.name }); setFloorId(r.id); }
      setFloorDialog(null); floor.reload();
    } catch (e) { toast.error((e as Error).message); }
  }

  async function removeFloor() {
    if (!current || !(await confirmDialog({ title: `Remove ${current.name}?`, message: "Its tables go too. Tables with open orders block this.", confirmLabel: "Remove floor", tone: "danger" }))) return;
    try { await api(`/floors/${current.id}`, "DELETE"); setFloorId(null); floor.reload(); } catch (e) { toast.error((e as Error).message); }
  }

  if (floor.loading && !d) return <div className="pt-4"><div className="h-[60vh] rounded-[1.25rem] skeleton-shimmer" /></div>;
  if (!d) return null;

  return (
    <div className="pb-4">
      <PageHeader title="Tables & floors" icon={LayoutGridIcon} module="sales"
        description={`${branch?.name}: ${d.tables.length} tables, ${d.tables.reduce((n, t) => n + t.seats, 0)} seats on ${d.floors.length} floor${d.floors.length === 1 ? "" : "s"}. Drag tables to arrange them.`}
        actions={<Button variant="outline" className="h-11" onClick={() => setFloorDialog({ name: "" })}><PlusIcon /> New floor</Button>} />
      {!current ? (
        <EmptyState icon={LayoutGridIcon} title="Start with a floor" module="sales" action={<Button size="lg" onClick={() => setFloorDialog({ name: "Main hall" })}><PlusIcon /> Add a floor</Button>}>
          A floor is an area of the restaurant: Main hall, Terrace, Family section.
        </EmptyState>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Segmented id="design-floors" value={current.id} onChange={(v) => { setFloorId(v); setSelected(null); }} options={d.floors.map((f) => ({ value: f.id, label: f.name }))} />
              <Button variant="ghost" size="icon" aria-label="Rename floor" onClick={() => setFloorDialog({ id: current.id, name: current.name })}><PencilIcon /></Button>
              {d.floors.length > 1 && <Button variant="ghost" size="icon" aria-label="Remove floor" onClick={removeFloor}><Trash2Icon /></Button>}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">Add</span>
              <Button variant="outline" className="h-11" onClick={() => addTable("round")}><CircleIcon /> Round</Button>
              <Button variant="outline" className="h-11" onClick={() => addTable("square")}><SquareIcon /> Square</Button>
              <Button variant="outline" className="h-11" onClick={() => addTable("rect")}><RectangleHorizontalIcon /> Long</Button>
            </div>
          </div>
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_280px] xl:gap-5">
            <FloorCanvas grid={{ cols: d.cols, rows: d.rows }} floorId={current.id} tables={d.tables} mode="design" selectedId={selected}
              onSelect={(t) => setSelected(t.id)} onMove={(t: Table, x, y) => { void save(t as FloorTable, { x, y }); }} />
            <aside className="surface h-fit p-4">
              {sel ? <TableEditor key={sel.id} table={sel} floors={d.floors} onSave={(p) => save(sel, p)}
                onDelete={async () => {
                  if (!(await confirmDialog({ title: `Remove table ${sel.name}?`, confirmLabel: "Remove", tone: "danger" }))) return;
                  try { await api(`/tables/${sel.id}`, "DELETE"); setSelected(null); floor.reload(); } catch (e) { toast.error((e as Error).message); }
                }} />
                : <div className="py-8 text-center text-sm text-muted-foreground">Tap a table to edit it, or drag it to move it.</div>}
            </aside>
          </div>
        </>
      )}
      <Dialog open={!!floorDialog} onOpenChange={(o) => { if (!o) setFloorDialog(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>{floorDialog?.id ? "Rename floor" : "New floor"}</DialogTitle></DialogHeader>
          <Field label="Name"><Input autoFocus value={floorDialog?.name ?? ""} onChange={(e) => setFloorDialog((f) => f && { ...f, name: e.target.value })} placeholder="e.g. Terrace" /></Field>
          <DialogFooter><Button variant="outline" onClick={() => setFloorDialog(null)}>Cancel</Button><Button disabled={!floorDialog?.name.trim()} onClick={saveFloor}>Save</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function TableEditor({ table, floors, onSave, onDelete }: {
  table: FloorTable; floors: FloorData["floors"]; onSave: (p: Partial<FloorTable>) => Promise<boolean>; onDelete: () => void;
}) {
  const [name, setName] = useState(table.name);
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-heading text-base font-semibold">Table {table.name}</h2>
        {table.orderId && <span className="text-xs text-warning">Has an open order</span>}
      </div>
      <Field label="Name">
        <Input value={name} onChange={(e) => setName(e.target.value.toUpperCase())} onBlur={() => { if (name.trim() && name !== table.name) void onSave({ name: name.trim() }); }} />
      </Field>
      <Field label="Seats">
        <div className="flex h-12 items-center rounded-xl border bg-card">
          <button type="button" aria-label="One seat fewer" className="flex size-12 items-center justify-center text-lg text-muted-foreground" onClick={() => void onSave({ seats: Math.max(1, table.seats - 1) })}>−</button>
          <span className="flex flex-1 items-center justify-center gap-1.5 font-heading text-lg font-semibold tabular-nums"><UsersRoundIcon className="size-4 text-muted-foreground" />{table.seats}</span>
          <button type="button" aria-label="One seat more" className="flex size-12 items-center justify-center text-lg text-muted-foreground" onClick={() => void onSave({ seats: Math.min(40, table.seats + 1) })}>+</button>
        </div>
      </Field>
      <Field label="Shape">
        <Segmented id="shape" value={table.shape} className="w-full" onChange={(v) => void onSave({ shape: v, ...SIZE[v] })}
          options={[{ value: "round", label: "Round", icon: CircleIcon }, { value: "square", label: "Square", icon: SquareIcon }, { value: "rect", label: "Long", icon: RectangleHorizontalIcon }]} />
      </Field>
      {floors.length > 1 && (
        <Field label="Floor">
          <select className="h-11 w-full rounded-xl border border-input bg-card px-3 text-sm dark:bg-input/30" value={table.floorId}
            onChange={(e) => void onSave({ floorId: e.target.value, x: 0, y: 0 })}>
            {floors.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </Field>
      )}
      <Button variant="destructive" className="h-11 w-full" disabled={!!table.orderId} onClick={onDelete}><Trash2Icon /> Remove table</Button>
    </div>
  );
}
