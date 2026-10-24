"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { BellRingIcon, ChefHatIcon } from "lucide-react";
import { api, setApiScope } from "@/lib/api";
import { appStorage } from "@/lib/base-path";
import { Logo } from "@/components/logo";
import { EASE } from "@/components/motion";

type Row = { id: string; number: number | null; orderType: string; customerName: string | null; platformName: string | null; platformRef: string | null; openedAt: string; readyAt: string | null };
/** What fits on a 1080p TV: older preparing orders first; the newest ready ones first. */
const PREP_MAX = 15;
const READY_MAX = 9;

type Board = { mode: "off" | "auto" | "cashier"; branch: string; branchAr: string | null; preparing: Row[]; ready: Row[] };

/** Who the order is for, under its number: the platform (its rider collects), else the customer's first name. */
const sub = (r: Row) => r.platformName ?? r.customerName?.split(/\s+/)[0] ?? null;

/** A short two-note chime when an order turns ready (Web Audio, no file to load). */
function chime() {
  try {
    const ctx = new AudioContext();
    [880, 1318.5].forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = f; o.type = "sine";
      g.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.18);
      g.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + i * 0.18 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.18 + 0.5);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + i * 0.18); o.stop(ctx.currentTime + i * 0.18 + 0.55);
    });
  } catch { /* no sound before the screen is first tapped */ }
}

/**
 * The order-ready screen (REQ KIT-06) for a TV by the counter: takeaway and delivery order numbers being prepared, and the
 * ready ones large (a chime as each turns ready). Read every few seconds. Tap once for full screen (and to allow the chime).
 */
export default function PickupPage() {
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);

  useEffect(() => {
    try {
      const s = JSON.parse(appStorage.getItem("onepos.scope") ?? "{}") as { companyId?: string; branchId?: string };
      setApiScope(s.companyId ?? null, appStorage.getItem("onepos.till.branch") ?? s.branchId ?? null);
    } catch { /* a till's session decides */ }
    let alive = true;
    const load = () => api<Board>("/pickup").then((b) => {
      if (!alive) return;
      setError(null);
      const ids = new Set(b.ready.map((r) => r.id));
      // A chime and a moment in the spotlight for each order that just turned ready (not for what was ready at start).
      if (seen.current) {
        const newly = b.ready.find((r) => !seen.current!.has(r.id));
        if (newly) { chime(); setFresh(newly.id); window.setTimeout(() => setFresh((f) => (f === newly.id ? null : f)), 6000); }
      }
      seen.current = ids;
      setBoard(b);
    }, (e: Error) => alive && setError(e.message));
    void load();
    const t = window.setInterval(load, 4000);
    return () => { alive = false; window.clearInterval(t); };
  }, []);

  return (
    <main className="flex h-dvh cursor-none flex-col overflow-hidden bg-background select-none"
      onClick={() => { if (!document.fullscreenElement) void document.documentElement.requestFullscreen().catch(() => {}); }}>
      <header className="flex items-center justify-between border-b px-10 py-5">
        <Logo />
        <div className="text-right">
          <div className="font-heading text-2xl font-semibold">{board?.branch ?? ""}</div>
          {board?.branchAr && <div dir="rtl" className="text-lg text-muted-foreground">{board.branchAr}</div>}
        </div>
      </header>
      {error && <p className="bg-danger/10 px-10 py-3 text-danger">{error}</p>}
      {board?.mode === "off" && <p className="bg-warning/12 px-10 py-3 text-lg text-warning">The order-ready screen is off for this branch. A manager switches it on under Companies &amp; branches.</p>}
      <div className="grid min-h-0 flex-1 grid-cols-[2fr_3fr]">
        <section className="flex min-h-0 flex-col border-r bg-muted/30 px-10 py-8">
          <h2 className="mb-6 flex items-center gap-3 font-heading text-3xl font-semibold text-muted-foreground">
            <ChefHatIcon className="size-8" /> Preparing <span dir="rtl" className="ml-auto text-2xl font-normal">قيد التحضير</span>
          </h2>
          <div className="grid content-start gap-3 overflow-hidden sm:grid-cols-2 xl:grid-cols-3">
            <AnimatePresence initial={false}>
              {(board?.preparing ?? []).slice(0, PREP_MAX).map((r) => (
                <motion.div key={r.id} layout initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }}
                  transition={{ duration: 0.3, ease: EASE }} className="surface px-5 py-4 text-center">
                  <div className="font-heading text-4xl font-semibold tabular-nums text-foreground/80">{r.number}</div>
                  {sub(r) && <div className="mt-1 truncate text-sm text-muted-foreground">{sub(r)}</div>}
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
          {(board?.preparing.length ?? 0) > PREP_MAX && <p className="mt-4 text-center text-lg text-muted-foreground">+{board!.preparing.length - PREP_MAX} more being prepared</p>}
        </section>
        <section className="flex min-h-0 flex-col px-10 py-8">
          <h2 className="mb-6 flex items-center gap-3 font-heading text-4xl font-semibold text-success">
            <BellRingIcon className="size-9" /> Ready to collect <span dir="rtl" className="ml-auto text-3xl font-normal">جاهز للاستلام</span>
          </h2>
          <div className="grid content-start gap-4 overflow-hidden sm:grid-cols-2 xl:grid-cols-3">
            <AnimatePresence initial={false}>
              {(board?.ready ?? []).slice(0, READY_MAX).map((r) => (
                <motion.div key={r.id} layout initial={{ opacity: 0, y: 30, scale: 0.8 }} animate={{ opacity: 1, y: 0, scale: fresh === r.id ? 1.06 : 1 }} exit={{ opacity: 0, scale: 0.8 }}
                  transition={{ type: "spring", stiffness: 260, damping: 20 }}
                  className={`rounded-3xl border-2 px-6 py-6 text-center shadow-sm ${fresh === r.id ? "border-success bg-success text-white" : "border-success/40 bg-success/10"}`}>
                  <div className={`font-heading text-7xl font-bold tabular-nums ${fresh === r.id ? "" : "text-success"}`}>{r.number}</div>
                  {sub(r) && <div className={`mt-1 truncate text-lg ${fresh === r.id ? "text-white/90" : "text-muted-foreground"}`}>{sub(r)}</div>}
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
          {board && !board.ready.length && <p className="mt-10 text-center text-2xl text-muted-foreground">Your order number shows here when it&apos;s ready.</p>}
        </section>
      </div>
    </main>
  );
}
