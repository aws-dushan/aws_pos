"use client";

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { animate, motion, MotionConfig, useReducedMotion, type Variants } from "motion/react";
import { fmtIn } from "@/lib/num";
import { cn } from "@/lib/utils";

/*
 * AWS One motion kit: calm and cheap, so it runs smoothly on basic office PCs and remote desktops.
 * Short, mostly one-time animations of transform and opacity only: no blur filters, no backdrop
 * filters, no canvas/WebGL, no endless loops (except a loading shimmer). Everything is off under the
 * OS "reduce motion" setting or the user's own "Reduce animations" (MotionProvider below).
 */

export const EASE = [0.2, 0, 0, 1] as const;

type MotionPref = { reduced: boolean; setReduced: (on: boolean) => void };
const MotionPrefContext = createContext<MotionPref>({ reduced: false, setReduced: () => {} });

/** The user's "Reduce animations" switch (the OS setting applies on top of it). */
export const useMotionPref = () => useContext(MotionPrefContext);

/** True when animation should not run: the OS setting or the user's own switch. */
export function motionOff() {
  if (typeof window === "undefined") return true;
  return document.documentElement.hasAttribute("data-reduce-motion") || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Mounted once at the root. `reduced` (the user's switch) turns motion's animations off and marks
 * <html data-reduce-motion>, which stops CSS animations and transitions too.
 */
export function MotionProvider({ children }: { children: React.ReactNode }) {
  const [reduced, setReducedState] = useState(false);
  const setReduced = useCallback((on: boolean) => {
    setReducedState(on);
    document.documentElement.toggleAttribute("data-reduce-motion", on);
  }, []);
  const value = useMemo(() => ({ reduced, setReduced }), [reduced, setReduced]);
  return (
    <MotionPrefContext.Provider value={value}>
      <MotionConfig reducedMotion={reduced ? "always" : "user"} transition={{ duration: 0.2, ease: EASE }}>{children}</MotionConfig>
    </MotionPrefContext.Provider>
  );
}

/** A screen entering: fade with a 12px rise (240 ms). */
export function PageTransition({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <motion.div className={className} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.24, ease: EASE }}>
      {children}
    </motion.div>
  );
}

const staggerParent: Variants = { hidden: {}, show: { transition: { staggerChildren: 0.04 } } };
const staggerChild: Variants = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.28, ease: [0.34, 1.3, 0.64, 1] } },
};

/** A grid or list whose StaggerItem children enter one after another (once, on first view). */
export function Stagger({ children, className }: { children: React.ReactNode; className?: string }) {
  return <motion.div className={className} variants={staggerParent} initial="hidden" animate="show">{children}</motion.div>;
}

export function StaggerItem({ children, className }: { children: React.ReactNode; className?: string }) {
  return <motion.div className={className} variants={staggerChild}>{children}</motion.div>;
}

/** A KPI number counting up to `value` once, formatted with `format` (so currency decimals are kept). */
export function CountUp({ value, format, className, duration = 0.7 }: {
  value: number; format: (n: number) => string; className?: string; duration?: number;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const from = useRef(0);
  const reduce = useReducedMotion();
  const [initial] = useState(() => format(0));
  const formatRef = useRef(format);
  useEffect(() => { formatRef.current = format; });
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (reduce || motionOff()) {
      node.textContent = formatRef.current(value);
      from.current = value;
      return;
    }
    const controls = animate(from.current, value, {
      duration,
      ease: EASE,
      onUpdate: (v) => { node.textContent = formatRef.current(v); },
      onComplete: () => { node.textContent = formatRef.current(value); },
    });
    from.current = value;
    return () => controls.stop();
  }, [value, duration, reduce]);
  return <span ref={ref} className={cn("tabular-nums", className)}>{initial}</span>;
}

/**
 * Counts the number shown in `children` up to its value — whatever rendered it (a currency format, a column total,
 * a negative in brackets…). The real content stays in place (invisible while counting) so the layout never moves;
 * a copy of its text with the number stepping sits on top, then the real content shows. Re-counts from the old value
 * when the figure changes; text without a number, and "reduce animations", show as is.
 */
export function CountUpText({ children, className, duration = 0.7 }: { children: React.ReactNode; className?: string; duration?: number }) {
  const real = useRef<HTMLSpanElement>(null);
  const ghost = useRef<HTMLSpanElement>(null);
  const last = useRef<number | null>(null);
  const shown = useRef<string | null>(null);
  const reduce = useReducedMotion();
  useLayoutEffect(() => {
    const el = real.current, g = ghost.current;
    if (!el || !g) return;
    const text = el.textContent ?? "";
    if (text === shown.current) return;
    shown.current = text;
    const m = text.match(/-?\d[\d,]*(\.\d+)?/);
    const target = m ? parseFloat(m[0].replace(/,/g, "")) : null;
    const from = last.current ?? 0;
    last.current = target;
    if (!m || target === null || target === from || reduce || motionOff()) return;
    const decimals = m[1] ? m[1].length - 1 : 0;
    const grouped = m[0].includes(",") || Math.abs(target) >= 1000;
    const fmt = (v: number) => text.replace(m[0], grouped ? fmtIn(v, decimals) : v.toFixed(decimals));
    el.style.visibility = "hidden";
    g.style.display = "";
    g.textContent = fmt(from);
    const controls = animate(from, target, {
      duration, ease: EASE,
      onUpdate: (v) => { g.textContent = fmt(v); },
      onComplete: () => { el.style.visibility = ""; g.style.display = "none"; },
    });
    return () => { controls.stop(); el.style.visibility = ""; g.style.display = "none"; };
  });
  return (
    <span className={cn("relative inline-block tabular-nums", className)}>
      <span ref={real}>{children}</span>
      <span ref={ghost} aria-hidden className="absolute inset-y-0 right-0 whitespace-nowrap" style={{ display: "none" }} />
    </span>
  );
}

/**
 * The sliding highlight behind the active item of a menu or tab strip: render it inside the active
 * item only, with the same `id` for the whole group, and it slides from the old item to the new one.
 */
export function ActiveIndicator({ id, className }: { id: string; className?: string }) {
  return (
    <motion.span
      layoutId={id}
      aria-hidden
      className={cn("pointer-events-none absolute inset-0", className)}
      transition={{ type: "spring", stiffness: 420, damping: 28, mass: 0.8 }}
    />
  );
}

/** A pop-in for dialogs (scale .96 → 1 with a fade). */
export function PopIn({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <motion.div className={className} initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.18, ease: EASE }}>
      {children}
    </motion.div>
  );
}

/**
 * The first rows of the table inside `ref` rise in one after another when it first shows (only the
 * first `limit`, so a list of thousands costs nothing). CSS animation, transform/opacity only.
 */
export function useEnterRows(ref: React.RefObject<HTMLElement | null>, limit = 10) {
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root || motionOff()) return;
    root.querySelectorAll<HTMLElement>("tbody tr").forEach((tr, i) => {
      if (i < limit) tr.style.animation = `rise-in 220ms cubic-bezier(0.2,0,0,1) ${i * 25}ms both`;
    });
  }, [ref, limit]);
}

/* ---------------------------------------------------------------- shared-element morph */

let pendingMorph: { rect: DOMRect; at: number } | null = null;

/** Remember where a clicked list row was, so the record it opens can grow out of it (see useMorphIn). */
export function rememberMorph(el: Element) {
  pendingMorph = { rect: el.getBoundingClientRect(), at: Date.now() };
}

/** Makes the element grow out of the row that was just clicked (if any, within the last few seconds). Transform/opacity only. */
export function useMorphIn(ref: React.RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const el = ref.current;
    const from = pendingMorph;
    pendingMorph = null;
    if (!el || !from || Date.now() - from.at > 4000 || motionOff()) return;
    const to = el.getBoundingClientRect();
    if (!to.width || !to.height) return;
    el.style.transformOrigin = "top left";
    const controls = animate(el, {
      x: [from.rect.left - to.left, 0],
      y: [from.rect.top - to.top, 0],
      scaleX: [from.rect.width / to.width, 1],
      scaleY: [Math.max(0.2, from.rect.height / to.height), 1],
      opacity: [0.4, 1],
    }, { duration: 0.28, ease: EASE });
    return () => controls.stop();
  }, [ref]);
}

/* ---------------------------------------------------------------- success */

/**
 * A short success moment (a document posted): a green check draws itself over `origin` (an element,
 * e.g. the Post button; by default the focused element or the centre of the screen) and fades away.
 * Transform/opacity only; nothing under reduced motion.
 */
export function celebrate(origin?: Element | null) {
  if (motionOff()) return;
  const el = origin ?? (document.activeElement && document.activeElement !== document.body ? document.activeElement : null);
  const r = el?.getBoundingClientRect();
  const cx = r && r.width ? r.left + r.width / 2 : window.innerWidth / 2;
  const cy = r && r.height ? r.top + r.height / 2 : window.innerHeight / 2;
  const badge = document.createElement("div");
  badge.setAttribute("aria-hidden", "true");
  badge.style.cssText = `position:fixed;z-index:100;pointer-events:none;left:${cx - 22}px;top:${cy - 22}px;width:44px;height:44px;border-radius:9999px;background:var(--success);box-shadow:var(--shadow-pop-v);display:flex;align-items:center;justify-content:center`;
  badge.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" pathLength="1" style="stroke-dasharray:1;stroke-dashoffset:1;animation:check-draw 320ms 100ms cubic-bezier(.2,0,0,1) forwards"/></svg>`;
  document.body.appendChild(badge);
  // A small one-shot confetti burst (20 DOM pieces, transform/opacity only).
  const colours = ["var(--mod-fin)", "var(--mod-sales)", "var(--mod-inv)", "var(--mod-bp)", "var(--mod-bank)", "var(--mod-appr)"];
  for (let i = 0; i < 20; i++) {
    const p = document.createElement("span");
    const w = 5 + Math.random() * 4;
    p.style.cssText = `position:fixed;z-index:99;pointer-events:none;left:${cx}px;top:${cy}px;width:${w}px;height:${w * 0.5}px;border-radius:2px;background:${colours[i % colours.length]}`;
    document.body.appendChild(p);
    const angle = (Math.PI * 2 * i) / 20 + Math.random() * 0.3, dist = 50 + Math.random() * 60;
    const dx = Math.cos(angle) * dist, dy = Math.sin(angle) * dist - 30;
    p.animate([
      { transform: "translate(-50%,-50%) rotate(0deg)", opacity: 1 },
      { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy + 50}px)) rotate(${Math.random() * 360}deg)`, opacity: 0 },
    ], { duration: 800 + Math.random() * 300, easing: "cubic-bezier(.2,.7,.3,1)", fill: "forwards" }).finished.then(() => p.remove(), () => p.remove());
  }
  badge.animate([{ transform: "scale(0.5)", opacity: 0 }, { transform: "scale(1)", opacity: 1 }], { duration: 220, easing: "cubic-bezier(.2,0,0,1)" });
  badge.animate([{ opacity: 1 }, { opacity: 0, transform: "translateY(-8px)" }], { duration: 260, delay: 900, fill: "forwards" })
    .finished.then(() => badge.remove(), () => badge.remove());
}
