"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArmchairIcon, BanIcon, CalendarDaysIcon, ChevronLeftIcon, ChevronRightIcon, PencilIcon, PhoneIcon, PlusIcon, StickyNoteIcon, UserXIcon, UsersRoundIcon } from "lucide-react";
import { toast } from "sonner";
import { api, useApi } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { FloorData, OrderDetail } from "@/lib/pos";
import { useLiveEvent } from "@/components/live";
import { confirmDialog } from "@/components/confirm";
import { EmptyState, ErrorNote, Field, LoadingRows, ObjectStatus, PageHeader, TONE } from "@/components/kit";
import { Stagger, StaggerItem } from "@/components/motion";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

type Booking = {
  id: string; customerId: string | null; name: string; phone: string | null; guests: number; startsAt: string; endsAt: string;
  status: "booked" | "seated" | "cancelled" | "no_show"; note: string | null; orderId: string | null; createdByName: string | null;
  tableIds: string[]; tableNames: string | null; customerVisits: number | null;
};
const STATUS = {
  booked: { label: "Booked", tone: TONE.open }, seated: { label: "Seated", tone: TONE.done },
  cancelled: { label: "Cancelled", tone: TONE.struck }, no_show: { label: "No-show", tone: TONE.danger },
};

/** A local date as yyyy-mm-dd. */
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const time = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

/** Table bookings by day (REQ TBL-07): book, change, cancel, no-show, and seat the guests when they arrive. */
export default function ReservationsPage() {
  const router = useRouter();
  const [day, setDay] = useState(() => ymd(new Date()));
  const list = useApi<{ date: string; reservations: Booking[] }>(`/reservations?date=${day}`);
  const floor = useApi<FloorData>("/floor");
  useLiveEvent(["floor.changed"], () => list.reload());
  const [editing, setEditing] = useState<Booking | "new" | null>(null);
  const isToday = day === ymd(new Date());

  function shift(days: number) { const d = new Date(`${day}T12:00:00`); d.setDate(d.getDate() + days); setDay(ymd(d)); }
  async function status(b: Booking, s: "cancelled" | "no_show" | "booked") {
    if (s !== "booked" && !(await confirmDialog({ title: s === "cancelled" ? `Cancel ${b.name}'s booking?` : `Mark ${b.name} as a no-show?`, confirmLabel: s === "cancelled" ? "Cancel booking" : "No-show", tone: "danger" }))) return;
    try { await api(`/reservations/${b.id}/status`, "POST", { status: s }); list.reload(); } catch (e) { toast.error((e as Error).message); }
  }
  async function seat(b: Booking) {
    try { const o = await api<OrderDetail>(`/reservations/${b.id}/seat`, "POST", {}); router.push(`/register?order=${o.order.id}`); }
    catch (e) { toast.error((e as Error).message); }
  }

  const rows = list.data?.reservations ?? [];
  const active = rows.filter((r) => r.status === "booked" || r.status === "seated");
  const covers = active.reduce((n, r) => n + r.guests, 0);

  return (
    <div className="mx-auto max-w-[1000px] pb-8">
      <PageHeader title="Reservations" icon={CalendarDaysIcon} module="appr" count={active.length}
        description="Bookings hold their tables for the time booked; the floor shows them in the two hours before."
        actions={<Button size="lg" onClick={() => setEditing("new")}><PlusIcon /> New booking</Button>} />

      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="flex items-center rounded-xl border bg-card">
          <Button variant="ghost" size="icon" className="size-11" aria-label="Day before" onClick={() => shift(-1)}><ChevronLeftIcon /></Button>
          <Input type="date" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} className="h-11 w-44 border-0 shadow-none" />
          <Button variant="ghost" size="icon" className="size-11" aria-label="Day after" onClick={() => shift(1)}><ChevronRightIcon /></Button>
        </div>
        {!isToday && <Button variant="outline" className="h-11" onClick={() => setDay(ymd(new Date()))}>Today</Button>}
        <div className="text-sm text-muted-foreground">
          {new Date(`${day}T12:00:00`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })} · {active.length} booking{active.length === 1 ? "" : "s"} · {covers} guests
        </div>
      </div>
      <ErrorNote message={list.error} />

      {list.loading && !list.data ? <LoadingRows rows={4} /> : rows.length ? (
        <Stagger className="space-y-3">
          {rows.map((b) => (
            <StaggerItem key={b.id}>
              <div className={cn("surface flex flex-wrap items-center gap-4 p-4", (b.status === "cancelled" || b.status === "no_show") && "opacity-55")}>
                <div className="w-20 text-center">
                  <div className="font-heading text-xl font-semibold tabular-nums">{time(b.startsAt)}</div>
                  <div className="text-xs text-muted-foreground tabular-nums">to {time(b.endsAt)}</div>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{b.name}</span>
                    <ObjectStatus className={STATUS[b.status].tone}>{STATUS[b.status].label}</ObjectStatus>
                    {b.customerVisits ? <span className="text-xs text-muted-foreground">{b.customerVisits} visits before</span> : null}
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-x-4 gap-y-0.5 text-sm text-muted-foreground">
                    <span className="inline-flex items-center gap-1"><UsersRoundIcon className="size-3.5" /> {b.guests}</span>
                    <span className="inline-flex items-center gap-1"><ArmchairIcon className="size-3.5" /> {b.tableNames ?? "No table yet"}</span>
                    {b.phone && <span className="inline-flex items-center gap-1"><PhoneIcon className="size-3.5" /> {b.phone}</span>}
                    {b.note && <span className="inline-flex items-center gap-1 text-foreground"><StickyNoteIcon className="size-3.5" /> {b.note}</span>}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {b.status === "booked" && <>
                    {isToday && <Button className="h-11" onClick={() => void seat(b)}><ArmchairIcon /> Seat</Button>}
                    <Button variant="outline" className="h-11" onClick={() => setEditing(b)}><PencilIcon /> Change</Button>
                    <Button variant="ghost" className="h-11" aria-label="No-show" onClick={() => void status(b, "no_show")}><UserXIcon /></Button>
                    <Button variant="ghost" className="h-11" aria-label="Cancel" onClick={() => void status(b, "cancelled")}><BanIcon /></Button>
                  </>}
                  {b.status === "seated" && b.orderId && <Button variant="outline" className="h-11" onClick={() => router.push(`/register?order=${b.orderId}`)}>Open order</Button>}
                  {(b.status === "cancelled" || b.status === "no_show") && <Button variant="ghost" className="h-11" onClick={() => void status(b, "booked")}>Restore</Button>}
                </div>
              </div>
            </StaggerItem>
          ))}
        </Stagger>
      ) : (
        <EmptyState icon={CalendarDaysIcon} title="No bookings on this day" module="appr" action={<Button size="lg" onClick={() => setEditing("new")}><PlusIcon /> New booking</Button>}>
          Take a booking by phone: name, guests, time and the table to hold.
        </EmptyState>
      )}

      <BookingDialog value={editing} day={day} floor={floor.data} bookings={rows} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); list.reload(); }} />
    </div>
  );
}

/** A new booking or a change: who, how many, when, how long, which tables (those booked at that time are greyed out). */
function BookingDialog({ value, day, floor, bookings, onClose, onSaved }: {
  value: Booking | "new" | null; day: string; floor: FloorData | undefined; bookings: Booking[]; onClose: () => void; onSaved: () => void;
}) {
  const blank = { name: "", phone: "", guests: "2", date: day, time: "19:00", duration: "90", tables: [] as string[], note: "" };
  const [f, setF] = useState(blank);
  const [seen, setSeen] = useState<Booking | "new" | null>(null);
  const [busy, setBusy] = useState(false);
  if (value !== seen) {
    setSeen(value);
    if (value === "new") setF({ ...blank, date: day });
    else if (value) {
      const s = new Date(value.startsAt);
      setF({ name: value.name, phone: value.phone ?? "", guests: String(value.guests), date: ymd(s), time: s.toTimeString().slice(0, 5),
        duration: String(Math.round((new Date(value.endsAt).getTime() - s.getTime()) / 60000)), tables: value.tableIds, note: value.note ?? "" });
    }
  }
  const start = new Date(`${f.date}T${f.time}:00`);
  const end = new Date(start.getTime() + Number(f.duration || 0) * 60000);
  // Tables booked by someone else in this window (on the day shown; the server checks every day).
  const busyTables = new Set(bookings.filter((b) => (b.status === "booked" || b.status === "seated") && (value === "new" || b.id !== value?.id)
    && new Date(b.startsAt) < end && new Date(b.endsAt) > start).flatMap((b) => b.tableIds));
  const seats = (floor?.tables ?? []).filter((t) => f.tables.includes(t.id)).reduce((n, t) => n + t.seats, 0);
  const slots = Array.from({ length: 4 * 24 }, (_, i) => `${String(Math.floor(i / 4)).padStart(2, "0")}:${String((i % 4) * 15).padStart(2, "0")}`);

  async function save() {
    setBusy(true);
    try {
      const body = { name: f.name, phone: f.phone || null, guests: Number(f.guests), startsAt: start.toISOString(), durationMin: Number(f.duration), tableIds: f.tables, note: f.note || null };
      if (value === "new") await api("/reservations", "POST", body); else await api(`/reservations/${value!.id}`, "PUT", body);
      toast.success(value === "new" ? `Booked for ${f.name}` : "Booking changed");
      onSaved();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <Dialog open={!!value} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{value === "new" ? "New booking" : "Change booking"}</DialogTitle>
          <DialogDescription>A known customer is recognised by phone.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" required><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} className="h-11" /></Field>
          <Field label="Phone"><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} inputMode="tel" className="h-11" /></Field>
          <Field label="Date"><Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} className="h-11" /></Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Time">
              <select value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} className="h-11 w-full rounded-lg border border-input bg-card px-2 text-sm">
                {slots.map((s) => <option key={s}>{s}</option>)}
              </select>
            </Field>
            <Field label="For">
              <select value={f.duration} onChange={(e) => setF({ ...f, duration: e.target.value })} className="h-11 w-full rounded-lg border border-input bg-card px-2 text-sm">
                {[60, 90, 120, 150, 180, 240].map((m) => <option key={m} value={m}>{m >= 120 ? `${m / 60} h` : `${m} min`}</option>)}
              </select>
            </Field>
            <Field label="Guests"><Input value={f.guests} onChange={(e) => setF({ ...f, guests: e.target.value.replace(/\D/g, "") })} inputMode="numeric" className="h-11" /></Field>
          </div>
        </div>
        <div>
          <div className="mb-2 flex items-baseline justify-between">
            <span className="text-[0.8rem] font-medium text-foreground/80">Tables to hold</span>
            {f.tables.length > 0 && <span className={cn("text-xs", seats < Number(f.guests || 0) ? "text-warning" : "text-muted-foreground")}>{seats} seats for {f.guests || 0} guests</span>}
          </div>
          {(floor?.floors ?? []).map((fl) => {
            const tables = (floor?.tables ?? []).filter((t) => t.floorId === fl.id).sort((x, y) => x.name.localeCompare(y.name, undefined, { numeric: true }));
            if (!tables.length) return null;
            return (
              <div key={fl.id} className="mb-2">
                {(floor?.floors.length ?? 0) > 1 && <div className="mb-1 text-xs text-muted-foreground">{fl.name}</div>}
                <div className="flex flex-wrap gap-2">
                  {tables.map((t) => {
                    const on = f.tables.includes(t.id), taken = busyTables.has(t.id);
                    return (
                      <button key={t.id} type="button" disabled={taken && !on}
                        onClick={() => setF({ ...f, tables: on ? f.tables.filter((x) => x !== t.id) : [...f.tables, t.id] })}
                        className={cn("h-11 min-w-16 rounded-xl border px-3 text-sm transition-colors active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-35",
                          on ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:bg-muted")}>
                        <span className="font-medium">{t.name}</span> <span className={cn("text-xs", on ? "text-primary-foreground/80" : "text-muted-foreground")}>· {t.seats}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
          {!(floor?.tables.length) && <p className="text-sm text-muted-foreground">No tables on the floor plan yet. The booking can be made now and a table chosen later.</p>}
        </div>
        <Field label="Note" hint="e.g. birthday, high chair, window seat"><Input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} className="h-11" /></Field>
        <DialogFooter>
          <Button variant="outline" className="h-11" onClick={onClose}>Cancel</Button>
          <Button className="h-11 min-w-36" disabled={busy || !f.name.trim() || !(Number(f.guests) > 0)} onClick={() => void save()}>{value === "new" ? "Book" : "Save"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
