"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ArmchairIcon, BikeIcon, BookmarkIcon, BookmarkXIcon, LayoutGridIcon, MinusIcon, PlusIcon, ShoppingBagIcon, UsersRoundIcon } from "lucide-react";
import { minutesSince } from "@/lib/utils";
import { openOrderOn, usePos, usePosState } from "@/prototype/store";
import { money, orderTotals } from "@/prototype/totals";
import { attempt, EmptyState, ObjectStatus, PageHeader, Segmented, TONE } from "@/components/kit";
import { FloorCanvas, FloorLegend, type TableInfo, type TableState } from "@/prototype/floor-canvas";
import { Stagger, StaggerItem } from "@/components/motion";
import { ModuleIcon } from "@/components/modules";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { Table } from "@/prototype/types";

/** The room: every table and its state; a click seats a free table or opens the order on a busy one. */
export default function FloorPage() {
  const s = usePosState();
  const pos = usePos();
  const router = useRouter();
  const [floorId, setFloorId] = useState(s.floors[0]?.id ?? "");
  const [seat, setSeat] = useState<Table | null>(null);
  const [, tick] = useState(0);
  useEffect(() => { const t = window.setInterval(() => tick((n) => n + 1), 30000); return () => window.clearInterval(t); }, []);
  const floor = s.floors.find((f) => f.id === floorId) ?? s.floors[0];

  if (!floor) {
    return (
      <>
        <PageHeader title="Floor" icon={ArmchairIcon} />
        <EmptyState icon={LayoutGridIcon} title="No floors yet" action={<Button render={<Link href="/settings/tables" />}>Set up tables</Button>}>
          Draw your dining room once in Tables &amp; floors, then seat guests here.
        </EmptyState>
      </>
    );
  }

  const info = (t: Table): TableInfo => {
    const o = openOrderOn(s, t.id);
    if (o) return { state: o.billRequested ? "bill" : "seated", guests: o.guests, total: orderTotals(o, s.settings).total, since: o.createdAt, number: o.number };
    return { state: t.reserved ? "reserved" : "free" };
  };
  const counts = { free: 0, seated: 0, bill: 0, reserved: 0 } as Record<TableState, number>;
  s.tables.filter((t) => t.floorId === floor.id).forEach((t) => counts[info(t).state]++);
  const guests = s.orders.filter((o) => o.status === "open" && o.type === "dine-in").reduce((n, o) => n + (o.guests ?? 0), 0);

  function open(t: Table) {
    const o = openOrderOn(s, t.id);
    if (o) return router.push(`/register?order=${o.id}`);
    if (s.settings.askGuests) return setSeat(t);
    start(t, undefined);
  }
  function start(t: Table, guests: number | undefined) {
    let id = "";
    if (attempt(() => { id = pos.openOrder("dine-in", { tableId: t.id, guests }); })) router.push(`/register?order=${id}`);
  }

  const seatedHere = s.orders.filter((o) => o.status === "open" && o.type === "dine-in" && s.tables.find((t) => t.id === o.tableId)?.floorId === floor.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const quick = s.orders.filter((o) => o.status === "open" && o.type !== "dine-in");

  return (
    <div className="pb-4">
      <PageHeader title="Floor" icon={ArmchairIcon}
        description={`${s.orders.filter((o) => o.status === "open" && o.type === "dine-in").length} of ${s.tables.length} tables seated · ${guests} guest${guests === 1 ? "" : "s"}`}
        actions={<>
          <Button variant="outline" size="lg" render={<Link href="/settings/tables" />}><LayoutGridIcon /> Edit layout</Button>
          <Button variant="outline" size="lg" render={<Link href="/register?new=takeaway" />}><ShoppingBagIcon /> Takeaway</Button>
        </>} />

      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <Segmented id="floor-tabs" value={floor.id} onChange={setFloorId}
          options={s.floors.map((f) => {
            const busy = s.tables.filter((t) => t.floorId === f.id && openOrderOn(s, t.id)).length;
            return { value: f.id, label: <>{f.name}{busy > 0 && <span className="ml-1.5 rounded-full bg-primary/12 px-1.5 text-[0.65rem] font-semibold text-primary tabular-nums">{busy}</span>}</> };
          })} />
        <FloorLegend counts={counts} />
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="animate-rise-in">
          <FloorCanvas floorId={floor.id} tables={s.tables} mode="service" info={info} onSelect={open} currency={s.settings.currency} />
        </div>

        <aside className="space-y-5">
          <section className="surface" aria-label="Seated">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <h2 className="font-heading text-[0.9rem] font-semibold">Seated on {floor.name}</h2>
              <span className="text-xs text-muted-foreground">Longest first</span>
            </div>
            {seatedHere.length ? (
              <Stagger className="divide-y">
                {seatedHere.map((o) => {
                  const t = s.tables.find((x) => x.id === o.tableId)!;
                  const m = minutesSince(o.createdAt);
                  return (
                    <StaggerItem key={o.id}>
                      <Link href={`/register?order=${o.id}`} className="group flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-muted/60">
                        <ModuleIcon module={o.billRequested ? "inv" : "fin"} icon={ArmchairIcon} size="sm" solid className="hover-hop" />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 text-sm font-medium">
                            {t.name}
                            {o.billRequested && <ObjectStatus className={TONE.warn}>Bill</ObjectStatus>}
                          </div>
                          <div className="flex items-center gap-1 text-xs text-muted-foreground"><UsersRoundIcon className="size-3" />{o.guests ?? "–"} · {m} min</div>
                        </div>
                        <span className="text-sm font-medium tabular-nums">{money(orderTotals(o, s.settings).total)}</span>
                      </Link>
                    </StaggerItem>
                  );
                })}
              </Stagger>
            ) : <p className="px-4 py-6 text-center text-sm text-muted-foreground">Nobody seated here yet. Tap a table to seat guests.</p>}
          </section>

          <section className="surface" aria-label="Takeaway and delivery">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <h2 className="font-heading text-[0.9rem] font-semibold">Takeaway &amp; delivery</h2>
              <span className="text-xs text-muted-foreground tabular-nums">{quick.length} open</span>
            </div>
            {quick.length ? (
              <div className="divide-y">
                {quick.map((o) => (
                  <Link key={o.id} href={`/register?order=${o.id}`} className="flex items-center gap-3 px-4 py-2.5 text-sm transition-colors hover:bg-muted/60">
                    {o.type === "delivery" ? <BikeIcon className="size-4 text-mod-bank" /> : <ShoppingBagIcon className="size-4 text-primary" />}
                    <span className="flex-1 font-medium">{o.customerName || `#${o.number}`}</span>
                    <span className="tabular-nums">{money(orderTotals(o, s.settings).total)}</span>
                  </Link>
                ))}
              </div>
            ) : <p className="px-4 py-6 text-center text-sm text-muted-foreground">None open.</p>}
          </section>
        </aside>
      </div>

      <SeatDialog table={seat} onClose={() => setSeat(null)}
        onSeat={(t, g) => { setSeat(null); start(t, g); }}
        onReserve={(t) => { pos.updateTable(t.id, { reserved: !t.reserved }); setSeat(null); }} />
    </div>
  );
}

/** Seat guests at a free table: how many (1 … seats+4), or hold the table for a reservation. */
function SeatDialog({ table, onClose, onSeat, onReserve }: {
  table: Table | null; onClose: () => void; onSeat: (t: Table, guests: number) => void; onReserve: (t: Table) => void;
}) {
  const [guests, setGuests] = useState(2);
  const [shown, setShown] = useState<Table | null>(null);
  if (table && table !== shown) { setShown(table); setGuests(Math.min(2, table.seats)); }
  const t = table ?? shown;
  return (
    <Dialog open={!!table} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-sm">
        {t && <>
          <DialogHeader>
            <DialogTitle>Seat table {t.name}</DialogTitle>
            <DialogDescription>{t.seats} seats{t.reserved ? " · reserved" : ""}. How many guests?</DialogDescription>
          </DialogHeader>
          <div className="flex items-center justify-center gap-5 py-2">
            <Button variant="outline" size="icon-lg" className="size-12 rounded-full" aria-label="One fewer" onClick={() => setGuests((g) => Math.max(1, g - 1))}><MinusIcon /></Button>
            <span key={guests} className="animate-rise-in w-16 text-center font-heading text-5xl font-semibold tabular-nums">{guests}</span>
            <Button variant="outline" size="icon-lg" className="size-12 rounded-full" aria-label="One more" onClick={() => setGuests((g) => Math.min(t.seats + 4, g + 1))}><PlusIcon /></Button>
          </div>
          <div className="grid grid-cols-6 gap-1.5">
            {Array.from({ length: Math.min(12, t.seats + 2) }, (_, i) => i + 1).map((n) => (
              <button key={n} type="button" onClick={() => setGuests(n)}
                className={`h-9 rounded-lg border text-sm font-medium tabular-nums transition-colors ${n === guests ? "border-primary bg-primary text-primary-foreground" : "hover:bg-muted"}`}>{n}</button>
            ))}
          </div>
          {guests > t.seats && <p className="text-xs text-warning">More guests than seats: bring extra chairs.</p>}
          <DialogFooter>
            <Button variant="ghost" onClick={() => onReserve(t)}>{t.reserved ? <><BookmarkXIcon /> Release reservation</> : <><BookmarkIcon /> Mark reserved</>}</Button>
            <Button size="lg" onClick={() => onSeat(t, guests)}><UsersRoundIcon /> Seat {guests} &amp; order</Button>
          </DialogFooter>
        </>}
      </DialogContent>
    </Dialog>
  );
}
