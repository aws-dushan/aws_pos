"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ArmchairIcon, BookmarkIcon, BookmarkXIcon, ClockIcon, LayoutGridIcon, LockIcon, ShoppingBagIcon, UsersRoundIcon } from "lucide-react";
import { toast } from "sonner";
import { api, useApi } from "@/lib/api";
import { minutesSince } from "@/lib/utils";
import { fmtIn } from "@/lib/num";
import { useNow } from "@/lib/hooks";
import type { FloorData, FloorTable, OrderDetail } from "@/lib/pos";
import { useSession } from "@/components/session";
import { useLiveEvent } from "@/components/live";
import { EmptyState, ObjectStatus, PageHeader, Segmented, TONE } from "@/components/kit";
import { FloorCanvas, FloorLegend, type TableInfo, type TableState } from "@/components/floor-canvas";
import { Stagger, StaggerItem } from "@/components/motion";
import { ModuleIcon } from "@/components/modules";
import { Numpad } from "@/components/numpad";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const money = (n: number) => fmtIn(n, 2);

/** The room (REQ TBL-04, TBL-05): every table and its state, live on every till. Tap a free table to seat guests; a busy one opens its order. */
export default function FloorPage() {
  const router = useRouter();
  const { can } = useSession();
  const floor = useApi<FloorData>("/floor");
  const timer = useRef<number | undefined>(undefined);
  useLiveEvent(["floor.changed", "order.changed"], () => { window.clearTimeout(timer.current); timer.current = window.setTimeout(() => floor.reload(), 250); });
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useNow(30000);   // minutes seated tick along
  const [floorId, setFloorId] = useState<string | null>(null);
  const [seat, setSeat] = useState<FloorTable | null>(null);
  const d = floor.data;
  const current = d?.floors.find((f) => f.id === floorId) ?? d?.floors[0];

  if (floor.loading && !d) return <div className="pt-4"><div className="h-[60vh] rounded-[1.25rem] skeleton-shimmer" /></div>;
  if (!d || !current) {
    return (
      <div>
        <PageHeader title="Floor" icon={ArmchairIcon} module="sales" />
        <EmptyState icon={LayoutGridIcon} title="No floor plan yet" module="sales"
          action={can("tables.manage") && <Button size="lg" nativeButton={false} render={<Link href="/tables" />}><LayoutGridIcon /> Draw the floor plan</Button>}>
          Draw the dining room once in Tables &amp; floors; then every till seats guests here.
        </EmptyState>
      </div>
    );
  }

  const info = (t: FloorTable): TableInfo => ({
    state: t.state, guests: t.guests ?? undefined, total: t.total ?? undefined, since: t.openedAt ?? undefined, number: t.orderNumber ?? undefined, lockedBy: t.lockLabel,
    booking: t.bookingAt ? new Date(t.bookingAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : undefined,
  });
  const onFloor = d.tables.filter((t) => t.floorId === current.id);
  const counts = { free: 0, seated: 0, bill: 0, reserved: 0 } as Record<TableState, number>;
  onFloor.forEach((t) => counts[t.state]++);
  const seated = d.tables.filter((t) => t.orderId);
  const guests = seated.reduce((n, t) => n + (t.guests ?? 0), 0);
  // A joined order shows once in the list (on its main table).
  const orders = [...new Map(onFloor.filter((t) => t.orderId).map((t) => [t.orderId!, t])).values()].sort((a, b) => (a.openedAt ?? "").localeCompare(b.openedAt ?? ""));

  function open(t: FloorTable) {
    if (t.orderId) return router.push(`/register?order=${t.orderId}`);
    setSeat(t);
  }

  return (
    <div className="pb-4">
      <PageHeader title="Floor" icon={ArmchairIcon} module="sales"
        description={`${new Set(seated.map((t) => t.orderId)).size} order${seated.length === 1 ? "" : "s"} on ${seated.length} of ${d.tables.length} tables · ${guests} guest${guests === 1 ? "" : "s"}`}
        actions={<>
          {can("tables.manage") && <Button variant="outline" className="h-11" nativeButton={false} render={<Link href="/tables" />}><LayoutGridIcon /> Edit layout</Button>}
          <Button variant="outline" className="h-11" onClick={() => api<OrderDetail>("/orders", "POST", { type: "takeaway" }).then((o) => router.push(`/register?order=${o.order.id}`)).catch((e: Error) => toast.error(e.message))}>
            <ShoppingBagIcon /> Takeaway
          </Button>
        </>} />

      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        {d.floors.length > 1 ? (
          <Segmented id="floor-tabs" value={current.id} onChange={setFloorId} size="md"
            options={d.floors.map((f) => {
              const busy = d.tables.filter((t) => t.floorId === f.id && t.orderId).length;
              return { value: f.id, label: <>{f.name}{busy > 0 && <span className="ml-1.5 rounded-full bg-primary/12 px-1.5 text-[0.65rem] font-semibold text-primary tabular-nums">{busy}</span>}</> };
            })} />
        ) : <span className="font-heading font-semibold">{current.name}</span>}
        <FloorLegend counts={counts} />
      </div>

      {/* Below 1280 px the plan takes the full width (tables stay big enough to read on a till) and the seated list goes under it. */}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_280px] 2xl:grid-cols-[minmax(0,1fr)_320px] 2xl:gap-5">
        {/* The plan is as wide as the screen allows while the whole room still fits the screen's height. */}
        <div className="animate-rise-in mx-auto w-full max-w-[calc((100dvh-14rem)*24/14)] 2xl:max-w-none">
          <div className="relative">
            <FloorCanvas grid={{ cols: d.cols, rows: d.rows }} floorId={current.id} tables={d.tables} mode="service" info={(t) => info(t as FloorTable)} onSelect={(t) => open(t as FloorTable)} />
            {!d.tables.some((t) => t.floorId === current.id) && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center">
                <LayoutGridIcon className="size-8 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">No tables on {current.name} yet.{can("tables.manage") ? " Place them in Tables & floors." : " A manager places them in Tables & floors."}</p>
                {can("tables.manage") && <Button size="lg" nativeButton={false} render={<Link href="/tables" />}><LayoutGridIcon /> Place tables</Button>}
              </div>
            )}
          </div>
        </div>
        <aside>
          <section className="surface" aria-label="Seated">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <h2 className="font-heading text-[0.9rem] font-semibold">Seated on {current.name}</h2>
              <span className="text-xs text-muted-foreground">Longest first</span>
            </div>
            {orders.length ? (
              <Stagger className="divide-y">
                {orders.map((t) => (
                  <StaggerItem key={t.orderId}>
                    <Link href={`/register?order=${t.orderId}`} className="group flex min-h-16 items-center gap-3 px-4 py-2.5 transition-colors hover:bg-muted/60">
                      <ModuleIcon module={t.state === "bill" ? "inv" : "fin"} icon={ArmchairIcon} size="sm" solid className="hover-hop" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 text-sm font-medium">
                          {d.tables.filter((x) => x.orderId === t.orderId).map((x) => x.name).join(" + ")}
                          {t.state === "bill" && <ObjectStatus className={TONE.warn}>Bill</ObjectStatus>}
                        </div>
                        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <UsersRoundIcon className="size-3" />{t.guests ?? "–"} <ClockIcon className="ml-1 size-3" />{minutesSince(t.openedAt)} min
                          {t.lockLabel && <span className="ml-1 inline-flex items-center gap-0.5"><LockIcon className="size-3" />{t.lockLabel}</span>}
                        </div>
                      </div>
                      <span className="text-sm font-medium tabular-nums">{money(t.total ?? 0)}</span>
                    </Link>
                  </StaggerItem>
                ))}
              </Stagger>
            ) : <p className="px-4 py-6 text-center text-sm text-muted-foreground">Nobody seated here yet. Tap a table to seat guests.</p>}
          </section>
        </aside>
      </div>

      <SeatDialog table={seat} onClose={() => setSeat(null)}
        onSeated={(id) => { setSeat(null); router.push(`/register?order=${id}`); }} onReserved={() => { setSeat(null); floor.reload(); }} />
    </div>
  );
}

/** Seat guests at a free table: how many (number pad), or hold it for a reservation. */
function SeatDialog({ table, onClose, onSeated, onReserved }: { table: FloorTable | null; onClose: () => void; onSeated: (orderId: string) => void; onReserved: () => void }) {
  const [guests, setGuests] = useState("2");
  const [seen, setSeen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if ((table?.id ?? null) !== seen) { setSeen(table?.id ?? null); setGuests(String(Math.min(2, table?.seats ?? 2))); }
  const n = Number(guests || 0);
  async function seatIt() {
    if (!table || !n) return;
    setBusy(true);
    try {
      const o = await api<OrderDetail>("/orders", "POST", { type: "dine_in", tableId: table.id, guests: n });
      onSeated(o.order.id);
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  // A booking on this table soon: seat it (its guests, name and customer go on the order).
  async function seatBooking() {
    if (!table?.bookingId) return;
    setBusy(true);
    try { const o = await api<OrderDetail>(`/reservations/${table.bookingId}/seat`, "POST", {}); onSeated(o.order.id); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  async function reserve() {
    if (!table) return;
    try { await api(`/tables/${table.id}/reserved`, "PUT", { reserved: !table.reserved }); toast.success(table.reserved ? `${table.name} released.` : `${table.name} held for a reservation.`); onReserved(); }
    catch (e) { toast.error((e as Error).message); }
  }
  return (
    <Dialog open={!!table} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-sm">
        {table && <>
          <DialogHeader>
            <DialogTitle>Seat table {table.name}</DialogTitle>
            <DialogDescription>{table.seats} seats{table.reserved ? " · reserved" : ""}. How many guests?</DialogDescription>
          </DialogHeader>
          {table.bookingId && (
            <div data-module="appr" className="flex items-center gap-3 rounded-xl border border-mod/30 bg-mod/8 px-3 py-2.5">
              <BookmarkIcon className="size-5 shrink-0 text-mod" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">Booked: {table.bookingName}</div>
                <div className="text-xs text-muted-foreground">{new Date(table.bookingAt!).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })} · {table.bookingGuests} guests</div>
              </div>
              <Button className="h-10" disabled={busy} onClick={seatBooking}>Seat booking</Button>
            </div>
          )}
          <div className="flex h-16 items-center justify-center rounded-xl border bg-muted/40 font-heading text-4xl font-semibold tabular-nums">{guests || "–"}</div>
          <Numpad value={guests} onChange={setGuests} decimals={0} max={2} onEnter={() => { if (!busy && n) seatIt(); }} />
          {n > table.seats && <p className="text-sm text-warning">More guests than seats: bring extra chairs, or join a table.</p>}
          <DialogFooter>
            <Button variant="ghost" className="h-12" onClick={reserve}>{table.reserved ? <><BookmarkXIcon /> Release</> : <><BookmarkIcon /> Reserve</>}</Button>
            <Button className="h-12 min-w-40" disabled={busy || !n} onClick={seatIt}><UsersRoundIcon /> Seat {n || ""} &amp; order</Button>
          </DialogFooter>
        </>}
      </DialogContent>
    </Dialog>
  );
}
