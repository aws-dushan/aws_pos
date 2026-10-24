"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { ArmchairIcon, BellIcon, BellOffIcon, BikeIcon, ChefHatIcon, CupSodaIcon, PrinterIcon, RotateCcwIcon, ShoppingBagIcon, XOctagonIcon } from "lucide-react";
import { toast } from "sonner";
import { api, useApi } from "@/lib/api";
import { cn } from "@/lib/utils";
import { setStored, useNow, useStored } from "@/lib/hooks";
import type { KitchenTicket, TicketStatus } from "@/lib/pos";
import { reprintTicket } from "@/lib/kitchen-print";
import { useLiveEvent } from "@/components/live";
import { EmptyState, Segmented } from "@/components/kit";
import { EASE, motionOff } from "@/components/motion";
import { Button } from "@/components/ui/button";
import { fmtQty } from "@/lib/pos";

type Board = { stations: { kind: string; name: string; printerName: string | null }[]; tickets: KitchenTicket[] };

const COLUMNS: { status: TicketStatus; title: string; next: TicketStatus; action: string; module: string }[] = [
  { status: "new", title: "New", next: "preparing", action: "Start", module: "bank" },
  { status: "preparing", title: "Preparing", next: "ready", action: "Ready", module: "inv" },
  { status: "ready", title: "Ready to serve", next: "served", action: "Served", module: "sales" },
];

/** A short two-note chime for a new ticket (no sound file; Web Audio). */
function chime() {
  try {
    const ctx = new AudioContext();
    [880, 1320].forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = f; o.type = "sine";
      g.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.16);
      g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + i * 0.16 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.16 + 0.35);
      o.connect(g).connect(ctx.destination); o.start(ctx.currentTime + i * 0.16); o.stop(ctx.currentTime + i * 0.16 + 0.4);
    });
  } catch { /* no audio */ }
}

/**
 * The kitchen display (REQ KIT-02, KIT-05): tickets per station in three columns. Tap the button on a ticket to move it on;
 * it slides to the next column. Timers turn amber after 10 minutes and red after 20. Cancel tickets show in red.
 */
export default function KitchenPage() {
  const stationPref = useStored("onepos.kds.station") ?? "all";
  const sound = useStored("onepos.kds.sound") !== "off";
  const board = useApi<Board>(`/kitchen${stationPref === "all" ? "" : `?station=${stationPref}`}`);
  const now = useNow(1000);
  const seen = useRef<Set<string> | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const [moving, setMoving] = useState<string | null>(null);
  useLiveEvent(["order.changed", "kitchen.changed"], () => { window.clearTimeout(timer.current); timer.current = window.setTimeout(() => board.reload(), 200); });
  useEffect(() => () => window.clearTimeout(timer.current), []);

  // A chime when a ticket arrives that wasn't on the board before (not on the first load).
  useEffect(() => {
    const ids = new Set((board.data?.tickets ?? []).filter((t) => t.status === "new").map((t) => t.id));
    if (seen.current && sound && [...ids].some((id) => !seen.current!.has(id))) chime();
    if (board.data) seen.current = ids;
  }, [board.data, sound]);

  async function move(t: KitchenTicket, status: TicketStatus) {
    setMoving(t.id);
    try { await api(`/kitchen/tickets/${t.id}`, "PUT", { status }); board.reload(); }
    catch (e) { toast.error((e as Error).message); }
    finally { setMoving(null); }
  }

  const tickets = board.data?.tickets ?? [];
  // Recently served (not cancel acknowledgements), newest first: tap to bring one back to Ready.
  const served = tickets.filter((t) => t.status === "served" && !t.isCancel).sort((a, b) => (b.servedAt ?? "").localeCompare(a.servedAt ?? ""));

  return (
    <div className="flex flex-col gap-3 py-3 md:h-[calc(100dvh-3.5rem)]">
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex size-11 items-center justify-center rounded-xl bg-[linear-gradient(135deg,oklch(0.7_0.16_55),oklch(0.6_0.19_28))] text-white shadow-soft"><ChefHatIcon className="size-5" /></span>
        <h1 className="font-heading text-xl font-semibold">Kitchen</h1>
        <Segmented id="kds-station" value={stationPref} onChange={(v) => setStored("onepos.kds.station", v)} size="md"
          options={[{ value: "all", label: "All" }, { value: "kitchen", label: "Kitchen", icon: ChefHatIcon }, { value: "bar", label: "Bar", icon: CupSodaIcon }]} />
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" className="h-11" onClick={() => setStored("onepos.kds.sound", sound ? "off" : "on")} aria-label={sound ? "Mute the chime" : "Turn the chime on"}>
            {sound ? <BellIcon /> : <BellOffIcon />} {sound ? "Chime on" : "Muted"}
          </Button>
          {now && <span className="font-heading text-2xl font-semibold tabular-nums">{now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</span>}
        </div>
      </div>

      {board.loading && !board.data ? <div className="grid flex-1 gap-3 md:grid-cols-3">{[0, 1, 2].map((i) => <div key={i} className="rounded-2xl skeleton-shimmer" />)}</div> : (
        <LayoutGroup>
          <div className="grid min-h-0 flex-1 gap-3 md:grid-cols-3">
            {COLUMNS.map((col) => {
              const list = tickets.filter((t) => t.status === col.status);
              return (
                <section key={col.status} data-module={col.module} className="flex min-h-0 flex-col rounded-2xl bg-muted/50 p-2.5">
                  <div className="mb-2 flex items-center justify-between px-1.5">
                    <h2 className="flex items-center gap-2 font-heading font-semibold"><span className="size-2.5 rounded-full bg-mod" />{col.title}</h2>
                    <span className="rounded-full bg-card px-2.5 py-0.5 text-sm font-semibold tabular-nums shadow-soft">{list.length}</span>
                  </div>
                  <div className="scrollbar-thin min-h-0 flex-1 space-y-2.5 overflow-y-auto p-0.5">
                    <AnimatePresence initial={false}>
                      {list.map((t) => <TicketCard key={t.id} t={t} now={now} col={col} busy={moving === t.id} onMove={(s) => void move(t, s)} />)}
                    </AnimatePresence>
                    {!list.length && <p className="py-10 text-center text-sm text-muted-foreground">{col.status === "new" ? "Waiting for orders." : "Nothing here."}</p>}
                  </div>
                </section>
              );
            })}
          </div>
        </LayoutGroup>
      )}

      {served.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-2xl border bg-card px-3 py-2">
          <span className="text-xs font-medium text-muted-foreground">Just served</span>
          {served.slice(0, 6).map((t) => (
            <Button key={t.id} variant="outline" className="h-10" onClick={() => void move(t, "ready")} title="Bring back to Ready">
              <RotateCcwIcon /> #{t.orderNumber} {t.label} · {t.station === "bar" ? "Bar" : "Kitchen"}
            </Button>
          ))}
        </div>
      )}
      {board.data && !tickets.length && (
        <EmptyState compact icon={ChefHatIcon} title="All clear" module="purch">New orders appear here the moment a till sends them.</EmptyState>
      )}
    </div>
  );
}

function TicketCard({ t, now, col, busy, onMove }: {
  t: KitchenTicket; now: Date | null; col: (typeof COLUMNS)[number]; busy: boolean; onMove: (s: TicketStatus) => void;
}) {
  const since = now ? Math.max(0, Math.floor((now.getTime() - new Date(t.createdAt).getTime()) / 1000)) : 0;
  const mins = Math.floor(since / 60);
  const late = !t.isCancel && t.status !== "ready" && (mins >= 20 ? "danger" : mins >= 10 ? "warn" : null);
  const TypeIcon = t.orderType === "dine_in" ? ArmchairIcon : t.orderType === "delivery" ? BikeIcon : ShoppingBagIcon;
  const animate = !motionOff();
  return (
    <motion.article layout={animate} layoutId={animate ? `ticket-${t.id}` : undefined}
      initial={animate ? { opacity: 0, scale: 0.95, y: 10 } : false} animate={{ opacity: 1, scale: 1, y: 0 }} exit={animate ? { opacity: 0, scale: 0.95 } : undefined}
      transition={{ duration: 0.28, ease: EASE }}
      className={cn("overflow-hidden rounded-2xl border bg-card shadow-soft", t.isCancel && "border-danger/50 ring-2 ring-danger/40")}>
      <header className={cn("flex items-center gap-2 px-3.5 py-2.5 text-white",
        t.isCancel ? "bg-danger" : late === "danger" ? "bg-[linear-gradient(135deg,oklch(0.6_0.2_25),oklch(0.55_0.21_15))]" : late === "warn" ? "bg-[linear-gradient(135deg,oklch(0.75_0.15_70),oklch(0.66_0.17_50))]" : "bg-mod-grad")}>
        {t.isCancel ? <XOctagonIcon className="size-4" /> : <TypeIcon className="size-4" />}
        <span className="font-heading text-lg font-semibold">#{t.orderNumber}</span>
        <span className="min-w-0 truncate font-medium">{t.label}</span>
        <span className="ml-auto shrink-0 font-heading font-semibold tabular-nums">{t.status === "ready" ? "Ready" : `${mins}:${String(since % 60).padStart(2, "0")}`}</span>
      </header>
      {t.isCancel && <div className="bg-danger/10 px-3.5 py-1.5 text-sm font-semibold text-danger">CANCELLED: don&apos;t make, or stop</div>}
      <ul className="space-y-1.5 px-3.5 py-3">
        {t.lines.map((l, i) => (
          <li key={i} className={cn(t.isCancel && "text-danger line-through decoration-2")}>
            <div className="flex gap-2 text-lg leading-snug"><span className="font-heading font-bold tabular-nums">{fmtQty(l.qty)}×</span><span className="font-medium">{l.name}</span></div>
            {l.extras && <div className="pl-8 text-sm text-muted-foreground">{l.extras}</div>}
            {l.note && <div className="ml-8 mt-0.5 inline-block rounded-md bg-warning/15 px-2 py-0.5 text-sm font-semibold text-warning">{l.note}</div>}
          </li>
        ))}
      </ul>
      <footer className="flex items-center gap-2 border-t bg-muted/30 px-2.5 py-2">
        <span className="min-w-0 truncate pl-1 text-xs text-muted-foreground">{t.sentByName ?? ""}</span>
        <Button variant="ghost" size="icon-lg" className="ml-auto shrink-0" aria-label="Reprint ticket" onClick={() => reprintTicket(t.id).then(() => toast.success("Ticket sent to the printer.")).catch((e: Error) => toast.error(e.message))}><PrinterIcon /></Button>
        {t.isCancel
          ? <Button className="h-12 min-w-24 shrink-0 bg-danger px-5 text-white hover:bg-danger/90" disabled={busy} onClick={() => onMove("served")}>Got it</Button>
          : <Button className="h-12 min-w-24 shrink-0 px-5 text-base" disabled={busy} onClick={() => onMove(col.next)}>{col.action}</Button>}
      </footer>
    </motion.article>
  );
}
