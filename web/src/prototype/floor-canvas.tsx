"use client";

import { useRef, useState } from "react";
import { motion } from "motion/react";
import { ClockIcon, UsersRoundIcon } from "lucide-react";
import { cn, minutesSince } from "@/lib/utils";
import { canPlace } from "@/prototype/store";
import { FLOOR_GRID } from "@/prototype/seed";
import { money } from "@/prototype/totals";
import { motionOff } from "@/components/motion";
import type { Table } from "@/prototype/types";

/*
 * A floor plan: tables placed on a grid of cells (FLOOR_GRID), drawn with their chairs.
 * - service: each table shows its state (free / seated / bill / reserved); click opens it.
 * - design: tables can be dragged to a free spot (snapped to the grid) and selected for editing.
 * Motion: tables pop in one after another when a floor shows (transform/opacity only); a moved
 * table glides to its new cell.
 */

export type TableState = "free" | "seated" | "bill" | "reserved";

export type TableInfo = { state: TableState; guests?: number; total?: number; since?: string; number?: number };

const STATE_STYLE: Record<TableState, { module: string; label: string }> = {
  free: { module: "sales", label: "Free" },
  seated: { module: "fin", label: "Seated" },
  bill: { module: "inv", label: "Bill" },
  reserved: { module: "appr", label: "Reserved" },
};

export function FloorLegend({ counts }: { counts: Record<TableState, number> }) {
  return (
    <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
      {(Object.keys(STATE_STYLE) as TableState[]).map((s) => (
        <span key={s} data-module={STATE_STYLE[s].module} className="inline-flex items-center gap-1.5">
          <span className={cn("size-2.5 rounded-full", s === "free" ? "border-2 border-mod bg-card" : s === "reserved" ? "border-2 border-dashed border-mod" : "bg-mod-grad")} />
          {STATE_STYLE[s].label} <span className="font-semibold text-foreground tabular-nums">{counts[s]}</span>
        </span>
      ))}
    </div>
  );
}

export function FloorCanvas({ floorId, tables, mode, info, selectedId, onSelect, onMove, currency }: {
  floorId: string;
  tables: Table[];
  mode: "service" | "design";
  info?: (t: Table) => TableInfo;
  selectedId?: string | null;
  onSelect: (t: Table) => void;
  onMove?: (t: Table, x: number, y: number) => void;
  currency?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ id: string; x: number; y: number; dx: number; dy: number; moved: boolean } | null>(null);
  const on = tables.filter((t) => t.floorId === floorId);
  const animate = !motionOff();

  /** The grid cell under the pointer, less the grab offset. */
  const cellAt = (e: React.PointerEvent, dx: number, dy: number) => {
    const r = ref.current!.getBoundingClientRect();
    return {
      x: Math.round(((e.clientX - r.left) / r.width) * FLOOR_GRID.cols - dx),
      y: Math.round(((e.clientY - r.top) / r.height) * FLOOR_GRID.rows - dy),
    };
  };

  function down(e: React.PointerEvent, t: Table) {
    if (mode !== "design" || e.button !== 0) return;
    const r = ref.current!.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * FLOOR_GRID.cols;
    const py = ((e.clientY - r.top) / r.height) * FLOOR_GRID.rows;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ id: t.id, x: t.x, y: t.y, dx: px - t.x, dy: py - t.y, moved: false });
  }
  function move(e: React.PointerEvent) {
    if (!drag) return;
    const c = cellAt(e, drag.dx, drag.dy);
    if (c.x !== drag.x || c.y !== drag.y) setDrag({ ...drag, ...c, moved: true });
  }
  function up(t: Table) {
    if (!drag) return;
    const d = drag;
    setDrag(null);
    if (d.moved && (d.x !== t.x || d.y !== t.y) && canPlace(tables, t, d.x, d.y)) onMove?.(t, d.x, d.y);
    if (!d.moved) onSelect(t);
  }

  return (
    <div
      ref={ref}
      className={cn("relative w-full touch-none overflow-hidden rounded-[1.25rem] border bg-card select-none", mode === "design" && "bg-[radial-gradient(color-mix(in_oklab,var(--foreground)_14%,transparent)_1px,transparent_1.5px)]")}
      style={{ aspectRatio: `${FLOOR_GRID.cols} / ${FLOOR_GRID.rows}`, backgroundSize: mode === "design" ? `${100 / FLOOR_GRID.cols}% ${100 / FLOOR_GRID.rows}%` : undefined, backgroundPosition: "center" }}
      onPointerMove={move}
    >
      {mode === "service" && (
        <div aria-hidden className="pointer-events-none absolute inset-0 opacity-50 [background-image:radial-gradient(color-mix(in_oklab,var(--primary)_14%,transparent)_1px,transparent_1.5px)] [background-size:18px_18px] [mask-image:linear-gradient(160deg,black,transparent_70%)]" />
      )}
      {on.map((t, i) => {
        const dragging = drag?.id === t.id;
        const x = dragging ? drag.x : t.x;
        const y = dragging ? drag.y : t.y;
        const ok = !dragging || canPlace(tables, t, x, y);
        const inf = info?.(t) ?? { state: "free" as TableState };
        return (
          <div
            key={t.id}
            className={cn("absolute p-[0.9%]", dragging ? "z-20 cursor-grabbing" : "transition-[left,top] duration-200 ease-[cubic-bezier(0.2,0,0,1)]", mode === "design" && !dragging && "cursor-grab")}
            style={{ left: `${(x / FLOOR_GRID.cols) * 100}%`, top: `${(y / FLOOR_GRID.rows) * 100}%`, width: `${(t.w / FLOOR_GRID.cols) * 100}%`, height: `${(t.h / FLOOR_GRID.rows) * 100}%` }}
            onPointerDown={(e) => down(e, t)}
            onPointerUp={() => up(t)}
          >
            <motion.div
              key={floorId}
              className="h-full w-full"
              initial={animate ? { opacity: 0, scale: 0.85 } : false}
              animate={{ opacity: 1, scale: dragging ? 1.06 : 1 }}
              transition={{ duration: 0.28, ease: [0.34, 1.3, 0.64, 1], delay: dragging ? 0 : Math.min(i * 0.03, 0.4) }}
            >
              <TableShapeView table={t} info={inf} mode={mode} selected={selectedId === t.id} invalid={!ok} currency={currency}
                onClick={mode === "service" ? () => onSelect(t) : undefined} />
            </motion.div>
          </div>
        );
      })}
      {mode === "design" && on.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">No tables on this floor yet. Add one above.</div>
      )}
    </div>
  );
}

/** Where the chairs go round a table: positions in % of the table box. */
function chairs(t: Table): { left: number; top: number; rot: number }[] {
  const n = Math.max(1, Math.min(t.seats, 12));
  if (t.shape === "round") {
    return Array.from({ length: n }, (_, i) => {
      const a = (i / n) * Math.PI * 2 - Math.PI / 2;
      return { left: 50 + Math.cos(a) * 50, top: 50 + Math.sin(a) * 50, rot: (a * 180) / Math.PI + 90 };
    });
  }
  const out: { left: number; top: number; rot: number }[] = [];
  const along = (count: number, side: "top" | "bottom" | "left" | "right") => {
    for (let i = 0; i < count; i++) {
      const p = ((i + 1) / (count + 1)) * 100;
      if (side === "top") out.push({ left: p, top: 0, rot: 0 });
      if (side === "bottom") out.push({ left: p, top: 100, rot: 180 });
      if (side === "left") out.push({ left: 0, top: p, rot: 270 });
      if (side === "right") out.push({ left: 100, top: p, rot: 90 });
    }
  };
  if (t.shape === "square" && n <= 4) {
    (["top", "bottom", "left", "right"] as const).slice(0, n).forEach((s) => along(1, s));
  } else if (t.shape === "square") {
    along(Math.ceil(n / 4), "top"); along(Math.ceil((n - Math.ceil(n / 4)) / 3), "bottom");
    const rest = n - out.length; along(Math.ceil(rest / 2), "left"); along(Math.floor(rest / 2), "right");
  } else {
    const ends = n >= 6 ? 2 : 0;
    along(Math.ceil((n - ends) / 2), "top"); along(Math.floor((n - ends) / 2), "bottom");
    if (ends) { along(1, "left"); along(1, "right"); }
  }
  return out;
}

function TableShapeView({ table: t, info, mode, selected, invalid, onClick, currency }: {
  table: Table; info: TableInfo; mode: "service" | "design"; selected: boolean; invalid: boolean; onClick?: () => void; currency?: string;
}) {
  const st = STATE_STYLE[info.state];
  const busy = info.state === "seated" || info.state === "bill";
  const mins = info.since ? minutesSince(info.since) : 0;
  const Tag = onClick ? "button" : "div";
  return (
    <div data-module={mode === "design" ? "admin" : st.module} className="group relative h-full w-full p-[9%]">
      {chairs(t).map((c, i) => (
        <span key={i} aria-hidden
          className={cn("absolute h-[11%] w-[22%] max-w-5 min-w-2.5 rounded-full transition-colors", busy ? "bg-mod/55" : "bg-muted-foreground/25")}
          style={{ left: `${c.left}%`, top: `${c.top}%`, transform: `translate(-50%,-50%) rotate(${c.rot}deg)` }} />
      ))}
      <Tag
        type={onClick ? "button" : undefined}
        onClick={onClick}
        aria-label={`Table ${t.name}, ${t.seats} seats, ${st.label}`}
        className={cn(
          "relative flex h-full w-full flex-col items-center justify-center overflow-hidden text-center transition-[transform,box-shadow] duration-200 ease-[cubic-bezier(0.2,0,0,1)]",
          t.shape === "round" ? "rounded-full" : "rounded-2xl",
          mode === "design"
            ? "border bg-card shadow-soft"
            : busy ? "bg-mod-grad text-white shadow-[0_8px_20px_-8px_var(--mod)]"
              : info.state === "reserved" ? "border-2 border-dashed border-mod/60 bg-mod/6"
                : "border-2 border-mod/35 bg-card",
          onClick && "cursor-pointer hover:-translate-y-0.5 hover:shadow-lift active:scale-[0.97]",
          selected && "ring-3 ring-primary ring-offset-2 ring-offset-card",
          invalid && "border-danger bg-danger/10 ring-2 ring-danger",
        )}
      >
        <span className={cn("font-heading leading-none font-semibold", "text-[clamp(0.7rem,1.4vw,1.05rem)]", !busy && "text-foreground")}>{t.name}</span>
        {mode === "design" ? (
          <span className="mt-0.5 flex items-center gap-0.5 text-[clamp(0.55rem,0.9vw,0.72rem)] text-muted-foreground"><UsersRoundIcon className="size-[1em]" />{t.seats}</span>
        ) : busy ? (
          <>
            {info.total !== undefined && t.shape !== "round" && (
              <span className="mt-0.5 hidden text-[clamp(0.55rem,0.85vw,0.72rem)] font-medium text-white/85 tabular-nums sm:block">{currency} {money(info.total)}</span>
            )}
            <span className="mt-0.5 flex items-center gap-0.5 text-[clamp(0.55rem,0.85vw,0.7rem)] text-white/80 tabular-nums"><ClockIcon className="size-[1em]" />{mins}m</span>
          </>
        ) : (
          <span className={cn("mt-0.5 text-[clamp(0.55rem,0.85vw,0.7rem)]", info.state === "reserved" ? "font-medium text-mod" : "text-muted-foreground")}>
            {info.state === "reserved" ? "Reserved" : `${t.seats} seats`}
          </span>
        )}
        {info.state === "bill" && mode === "service" && (
          <span className="absolute top-[10%] right-[12%] size-2 rounded-full bg-white shadow-[0_0_0_3px_color-mix(in_oklab,white_35%,transparent)]" />
        )}
      </Tag>
    </div>
  );
}
