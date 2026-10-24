"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { appStorage } from "@/lib/base-path";
import { FLOOR_GRID, SHAPE_SIZE, seedState } from "@/prototype/seed";
import { uid } from "@/lib/utils";
import type {
  Category, Floor, MenuItem, Order, OrderType, Payment, PosState, Settings, Station, Table, TableShape, TicketStatus,
} from "@/prototype/types";

/*
 * One POS state: kept in this browser (localStorage) and synced live between tabs of the same browser,
 * so a kitchen screen opened in a second window follows the register. Every change goes through an
 * action below, which is where an API call to the AWS One server will go when the POS is connected.
 */

const KEY = "onepos.state.v1";

function load(): PosState {
  try {
    const raw = appStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw) as PosState;
      if (s.version === 1) return { ...seedState(), ...s, settings: { ...seedState().settings, ...s.settings } };
    }
  } catch {
    // storage unavailable or damaged: start from the demo data
  }
  return seedState();
}

function save(s: PosState) {
  try {
    appStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // storage full or blocked: the session keeps working in memory
  }
}

import { PosError } from "@/lib/errors";
export { PosError };

type Ctx = { state: PosState; update: (fn: (s: PosState) => PosState) => void };
const PosContext = createContext<Ctx | null>(null);

export function PosProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<PosState | null>(null);
  const ref = useRef<PosState | null>(null);

  useEffect(() => {
    const s = load();
    ref.current = s;
    setState(s);
    const onStorage = (e: StorageEvent) => {
      if (e.key && e.key.endsWith(KEY)) {
        const next = load();
        ref.current = next;
        setState(next);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const update = useCallback((fn: (s: PosState) => PosState) => {
    if (!ref.current) return;
    const next = fn(ref.current);   // may throw PosError: nothing changes
    ref.current = next;
    save(next);
    setState(next);
  }, []);

  const value = useMemo(() => (state ? { state, update } : null), [state, update]);
  if (!value) return <BootScreen />;
  return <PosContext.Provider value={value}>{children}</PosContext.Provider>;
}

function BootScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="h-2 w-40 overflow-hidden rounded-full skeleton-shimmer" />
    </div>
  );
}

export function usePosState(): PosState {
  const ctx = useContext(PosContext);
  if (!ctx) throw new Error("usePosState outside PosProvider");
  return ctx.state;
}

const now = () => new Date().toISOString();
const mapOrder = (s: PosState, id: string, fn: (o: Order) => Order): PosState => {
  const o = s.orders.find((x) => x.id === id);
  if (!o) throw new PosError("That order no longer exists.");
  if (o.status !== "open") throw new PosError(`Order #${o.number} is already ${o.status === "paid" ? "paid" : "voided"}.`);
  return { ...s, orders: s.orders.map((x) => (x.id === id ? fn(x) : x)) };
};

/** The open order on a table, if any. */
export const openOrderOn = (s: PosState, tableId: string) => s.orders.find((o) => o.status === "open" && o.tableId === tableId);

/** True when two tables overlap on the grid. */
const overlaps = (a: Pick<Table, "x" | "y" | "w" | "h">, b: Pick<Table, "x" | "y" | "w" | "h">) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** The first free spot on a floor for a table of size w×h (scanning row by row); null when the floor is full. */
export function freeSpot(tables: Table[], floorId: string, w: number, h: number): { x: number; y: number } | null {
  const on = tables.filter((t) => t.floorId === floorId);
  for (let y = 1; y + h <= FLOOR_GRID.rows - 1; y++)
    for (let x = 1; x + w <= FLOOR_GRID.cols - 1; x++)
      if (!on.some((t) => overlaps(t, { x: x - 1, y: y - 1, w: w + 2, h: h + 2 }))) return { x, y };
  return null;
}

/** Whether a table may sit at x/y on its floor (inside the canvas, not on another table). */
export function canPlace(tables: Table[], t: Table, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x + t.w > FLOOR_GRID.cols || y + t.h > FLOOR_GRID.rows) return false;
  return !tables.some((o) => o.id !== t.id && o.floorId === t.floorId && overlaps(o, { x, y, w: t.w, h: t.h }));
}

/** All POS actions. Each throws PosError (and changes nothing) when it is not allowed. */
export function usePos() {
  const ctx = useContext(PosContext);
  if (!ctx) throw new Error("usePos outside PosProvider");
  const { state, update } = ctx;

  return useMemo(() => {
    const a = {
      /* ---------------- settings */
      updateSettings(patch: Partial<Settings>) {
        update((s) => {
          if (patch.tableService === false) {
            const seated = s.orders.filter((o) => o.status === "open" && o.type === "dine-in").length;
            if (seated) throw new PosError(`Close the ${seated} open dine-in order${seated === 1 ? "" : "s"} before turning table service off.`);
          }
          return { ...s, settings: { ...s.settings, ...patch } };
        });
      },
      resetDemo() {
        update(() => seedState());
      },

      /* ---------------- floors & tables */
      addFloor(name: string): string {
        const id = uid();
        update((s) => ({ ...s, floors: [...s.floors, { id, name: name.trim() || `Floor ${s.floors.length + 1}` }] }));
        return id;
      },
      renameFloor(id: string, name: string) {
        update((s) => ({ ...s, floors: s.floors.map((f) => (f.id === id ? { ...f, name: name.trim() || f.name } : f)) }));
      },
      deleteFloor(id: string) {
        update((s) => {
          const busy = s.tables.filter((t) => t.floorId === id).find((t) => openOrderOn(s, t.id));
          if (busy) throw new PosError(`Table ${busy.name} on this floor has an open order.`);
          if (s.floors.length === 1) throw new PosError("Keep at least one floor while table service is on.");
          return { ...s, floors: s.floors.filter((f) => f.id !== id), tables: s.tables.filter((t) => t.floorId !== id) };
        });
      },
      addTable(floorId: string, shape: TableShape, seats?: number): string {
        const id = uid();
        update((s) => {
          const size = SHAPE_SIZE[shape];
          const spot = freeSpot(s.tables, floorId, size.w, size.h);
          if (!spot) throw new PosError("This floor is full. Move tables closer together or add another floor.");
          const used = new Set(s.tables.map((t) => t.name));
          let k = s.tables.length + 1;
          while (used.has(`T${k}`)) k++;
          const table: Table = { id, floorId, name: `T${k}`, seats: seats ?? (shape === "rect" ? 6 : shape === "round" ? 2 : 4), shape, ...spot, ...size };
          return { ...s, tables: [...s.tables, table] };
        });
        return id;
      },
      updateTable(id: string, patch: Partial<Table>) {
        update((s) => {
          const t = s.tables.find((x) => x.id === id);
          if (!t) return s;
          let next = { ...t, ...patch };
          if (patch.shape && patch.shape !== t.shape) next = { ...next, ...SHAPE_SIZE[patch.shape] };
          if (patch.name !== undefined) {
            const name = patch.name.trim();
            if (!name) throw new PosError("A table needs a name.");
            if (s.tables.some((x) => x.id !== id && x.name.toLowerCase() === name.toLowerCase())) throw new PosError(`There is already a table ${name}.`);
            next.name = name;
          }
          if (patch.floorId && patch.floorId !== t.floorId) {
            const spot = freeSpot(s.tables, patch.floorId, next.w, next.h);
            if (!spot) throw new PosError("That floor is full.");
            next = { ...next, ...spot };
          } else if (!canPlace(s.tables, next, next.x, next.y)) {
            throw new PosError("There's no room for that here.");
          }
          return { ...s, tables: s.tables.map((x) => (x.id === id ? next : x)) };
        });
      },
      deleteTable(id: string) {
        update((s) => {
          if (openOrderOn(s, id)) throw new PosError("This table has an open order. Pay or move it first.");
          return { ...s, tables: s.tables.filter((t) => t.id !== id) };
        });
      },

      /* ---------------- menu */
      saveCategory(c: Partial<Category> & { name: string; tone: Category["tone"] }): string {
        const id = c.id ?? uid();
        update((s) => ({
          ...s,
          categories: c.id ? s.categories.map((x) => (x.id === c.id ? { ...x, ...c, id } : x)) : [...s.categories, { id, name: c.name, tone: c.tone }],
        }));
        return id;
      },
      deleteCategory(id: string) {
        update((s) => {
          if (s.items.some((i) => i.categoryId === id)) throw new PosError("Move or delete the items in this category first.");
          return { ...s, categories: s.categories.filter((c) => c.id !== id) };
        });
      },
      saveItem(item: Omit<MenuItem, "id"> & { id?: string }) {
        update((s) => {
          if (!item.name.trim()) throw new PosError("An item needs a name.");
          if (!(item.price >= 0)) throw new PosError("Enter a price of zero or more.");
          return item.id
            ? { ...s, items: s.items.map((x) => (x.id === item.id ? { ...x, ...item, id: x.id } : x)) }
            : { ...s, items: [...s.items, { ...item, id: uid() }] };
        });
      },
      deleteItem(id: string) {
        update((s) => ({ ...s, items: s.items.filter((i) => i.id !== id) }));
      },

      /* ---------------- orders */
      /** Opens an order (on a table: its open order if it has one). Returns the order id. */
      openOrder(type: OrderType, opts: { tableId?: string; guests?: number } = {}): string {
        let id = "";
        update((s) => {
          if (type === "dine-in" && !s.settings.tableService) throw new PosError("Table service is off: start a takeaway or delivery order.");
          if (opts.tableId) {
            const existing = openOrderOn(s, opts.tableId);
            if (existing) { id = existing.id; return s; }
          }
          id = uid();
          const order: Order = {
            id, number: s.nextOrderNumber, type, tableId: type === "dine-in" ? opts.tableId : undefined, guests: opts.guests,
            lines: [], discountPct: 0, status: "open", createdAt: now(), payments: [], cashier: s.settings.cashierName,
          };
          return {
            ...s, orders: [...s.orders, order], nextOrderNumber: s.nextOrderNumber + 1,
            tables: opts.tableId ? s.tables.map((t) => (t.id === opts.tableId ? { ...t, reserved: false } : t)) : s.tables,
          };
        });
        return id;
      },
      /** Leaves an order: an order nothing was added to is removed again (and its table is free). */
      discardIfEmpty(orderId: string) {
        update((s) => {
          const o = s.orders.find((x) => x.id === orderId);
          return o && o.status === "open" && o.lines.length === 0 && o.payments.length === 0
            ? { ...s, orders: s.orders.filter((x) => x.id !== orderId) } : s;
        });
      },
      addItem(orderId: string, item: MenuItem) {
        update((s) => mapOrder(s, orderId, (o) => {
          // Another of an item already on the order (not yet sent, no note) adds to that line.
          const same = o.lines.find((l) => l.itemId === item.id && !l.note && l.sentQty === 0);
          return {
            ...o,
            lines: same
              ? o.lines.map((l) => (l.id === same.id ? { ...l, qty: l.qty + 1 } : l))
              : [...o.lines, { id: uid(), itemId: item.id, name: item.name, price: item.price, qty: 1, sentQty: 0, station: item.station }],
          };
        }));
      },
      changeQty(orderId: string, lineId: string, delta: number) {
        update((s) => mapOrder(s, orderId, (o) => {
          const l = o.lines.find((x) => x.id === lineId)!;
          const qty = l.qty + delta;
          if (qty < l.sentQty) throw new PosError(`${l.sentQty} ${l.name} already went to the kitchen. Void the order or ask a manager.`);
          return { ...o, lines: qty <= 0 ? o.lines.filter((x) => x.id !== lineId) : o.lines.map((x) => (x.id === lineId ? { ...x, qty } : x)) };
        }));
      },
      setLineNote(orderId: string, lineId: string, note: string) {
        update((s) => mapOrder(s, orderId, (o) => ({
          ...o,
          lines: o.lines.flatMap((l) => {
            if (l.id !== lineId) return [l];
            // A note on a line part of which was sent: the unsent rest becomes its own line with the note.
            if (l.sentQty > 0 && l.sentQty < l.qty) return [{ ...l, qty: l.sentQty }, { ...l, id: uid(), qty: l.qty - l.sentQty, sentQty: 0, note: note.trim() || undefined }];
            if (l.sentQty > 0) throw new PosError("This line was already sent to the kitchen.");
            return [{ ...l, note: note.trim() || undefined }];
          }),
        })));
      },
      setOrder(orderId: string, patch: Partial<Pick<Order, "discountPct" | "guests" | "customerName" | "billRequested">>) {
        update((s) => mapOrder(s, orderId, (o) => ({ ...o, ...patch })));
      },
      setOrderType(orderId: string, type: OrderType, tableId?: string) {
        update((s) => {
          if (type === "dine-in") {
            if (!tableId) throw new PosError("Pick a table for a dine-in order.");
            const other = openOrderOn(s, tableId);
            if (other && other.id !== orderId) throw new PosError("That table already has an open order.");
          }
          return mapOrder(s, orderId, (o) => ({ ...o, type, tableId: type === "dine-in" ? tableId : undefined }));
        });
      },
      /** Moves a dine-in order to another (free) table. */
      moveTable(orderId: string, tableId: string) {
        update((s) => {
          const other = openOrderOn(s, tableId);
          if (other && other.id !== orderId) throw new PosError("That table already has an open order.");
          return mapOrder(s, orderId, (o) => ({ ...o, tableId }));
        });
      },
      /** Sends the unsent quantities to the kitchen/bar as tickets (one per station). Returns how many items went. */
      sendToKitchen(orderId: string): number {
        let sent = 0;
        update((s) => {
          const o = s.orders.find((x) => x.id === orderId);
          if (!o) throw new PosError("That order no longer exists.");
          const pending = o.lines.filter((l) => l.qty > l.sentQty);
          if (!pending.length) throw new PosError("Nothing new to send.");
          const table = o.tableId ? s.tables.find((t) => t.id === o.tableId) : undefined;
          const label = table ? `Table ${table.name}` : o.customerName ? `${o.type === "delivery" ? "Delivery" : "Takeaway"} · ${o.customerName}` : o.type === "delivery" ? "Delivery" : "Takeaway";
          const stations = [...new Set(pending.map((l) => l.station))] as Station[];
          const tickets = stations.map((station) => ({
            id: uid(), orderId, orderNumber: o.number, label, type: o.type, station, createdAt: now(), status: "new" as TicketStatus,
            lines: pending.filter((l) => l.station === station).map((l) => ({ name: l.name, qty: l.qty - l.sentQty, note: l.note })),
          }));
          sent = pending.reduce((t, l) => t + l.qty - l.sentQty, 0);
          const next = mapOrder(s, orderId, (x) => ({ ...x, lines: x.lines.map((l) => ({ ...l, sentQty: l.qty })) }));
          return { ...next, tickets: [...next.tickets, ...tickets] };
        });
        return sent;
      },
      /** Takes payment; the order closes (and its table frees) once it is paid in full. */
      pay(orderId: string, payments: Omit<Payment, "id" | "at">[], total: number) {
        update((s) => mapOrder(s, orderId, (o) => {
          const all = [...o.payments, ...payments.map((p) => ({ ...p, id: uid(), at: now() }))];
          const paid = all.reduce((t, p) => t + p.amount, 0);
          if (!o.lines.length) throw new PosError("Add something to the order first.");
          const full = paid >= total - 0.004;
          return { ...o, payments: all, status: full ? "paid" : "open", paidAt: full ? now() : undefined, billRequested: full ? false : o.billRequested };
        }));
      },
      voidOrder(orderId: string) {
        update((s) => {
          const o = s.orders.find((x) => x.id === orderId);
          if (o?.payments.length) throw new PosError("This order has payments. Refund them before voiding.");
          const next = mapOrder(s, orderId, (x) => ({ ...x, status: "void" }));
          return { ...next, tickets: next.tickets.filter((t) => t.orderId !== orderId || t.status === "served") };
        });
      },

      /* ---------------- kitchen */
      setTicketStatus(id: string, status: TicketStatus) {
        update((s) => ({ ...s, tickets: s.tickets.map((t) => (t.id === id ? { ...t, status } : t)) }));
      },
    };
    return a;
  }, [update]);
}

export type { Floor };
