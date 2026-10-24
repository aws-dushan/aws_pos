"use client";

import Link from "next/link";
import { cloneElement, isValidElement, useRef, useState } from "react";
import { motion } from "motion/react";
import { toast } from "sonner";
import {
  AlertTriangleIcon, CheckCircle2Icon, CheckIcon, CircleDashedIcon, CircleDotIcon, CircleIcon, InfoIcon, Loader2Icon, MinusCircleIcon, SearchIcon, XCircleIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { PosError } from "@/lib/errors";
import { ModuleIcon, useModule, type ModuleKey } from "@/components/modules";
import { ActiveIndicator, celebrate, CountUp, EASE, motionOff } from "@/components/motion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";

type IconType = React.ComponentType<{ className?: string }>;

/** Shared page building blocks, the same as AWS One's (components/kit.tsx), so both products have one rhythm. */

/** Runs a POS action; a refusal (PosError) shows as an error toast instead of throwing. Returns true when it went through. */
export function attempt(fn: () => void): boolean {
  try {
    fn();
    return true;
  } catch (e) {
    if (e instanceof PosError) { toast.error(e.message); return false; }
    throw e;
  }
}

/** The title block of a screen: module icon chip, h1 with an optional count, a one-line subtitle, the actions on the right. */
export function PageHeader({ title, description, actions, icon, module, count }: {
  title: string; description?: React.ReactNode; actions?: React.ReactNode; icon: IconType; module?: ModuleKey; count?: number | null;
}) {
  const auto = useModule();
  const mod = module ?? auto;
  return (
    <div data-module={mod} className="mb-4 flex min-h-16 flex-wrap items-center justify-between gap-x-4 gap-y-2 pt-4">
      <div className="flex min-w-0 items-center gap-3">
        <ModuleIcon module={mod} icon={icon} size="md" className="hidden sm:inline-flex" />
        <div className="min-w-0">
          <h1 className="font-heading text-[1.35rem] leading-tight font-semibold tracking-tight text-foreground">
            {title}
            {count !== undefined && count !== null && (
              <span className="ml-2 inline-flex h-5 items-center rounded-full bg-muted px-2 align-middle font-sans text-xs font-semibold text-muted-foreground tabular-nums">{count.toLocaleString("en-US")}</span>
            )}
          </h1>
          {description && <div className="mt-0.5 text-sm text-muted-foreground">{description}</div>}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

const AVATAR_TONES = ["fin", "sales", "inv", "bp", "bank", "appr", "admin"] as const;

/** Initials in a soft coloured circle; the colour is stable per name. */
export function Avatar({ name, size = "sm", className }: { name: string; size?: "sm" | "md"; className?: string }) {
  const words = name.split(/[\s/,.()-]+/).filter((w) => /^\p{L}/u.test(w));
  const text = (words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? name).slice(0, 2)).toUpperCase();
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return (
    <span data-module={AVATAR_TONES[h % AVATAR_TONES.length]} aria-hidden
      className={cn("inline-flex shrink-0 items-center justify-center rounded-full bg-mod/14 font-semibold text-mod", size === "sm" ? "size-7 text-[0.62rem]" : "size-9 text-xs", className)}>
      {text}
    </span>
  );
}

/** Nothing to show yet: a soft composition of the module's icon, a title, friendly help and the primary action. */
export function EmptyState({ icon: Icon, title, children, action, compact, module }: {
  icon: IconType; title: string; children?: React.ReactNode; action?: React.ReactNode; compact?: boolean; module?: ModuleKey;
}) {
  const auto = useModule();
  return (
    <div data-module={module ?? auto} className={cn("animate-rise-in flex flex-col items-center gap-4 text-center", compact ? "px-6 py-10" : "surface px-6 py-16")}>
      <div className="relative size-24">
        <span className="absolute inset-0 rounded-full bg-mod/8" />
        <span className="absolute inset-3 rounded-full bg-mod/10" />
        <span className="hover-hop absolute inset-6 flex items-center justify-center rounded-2xl bg-mod-grad text-white shadow-[0_8px_20px_-8px_var(--mod)]">
          <Icon className="size-6" />
        </span>
        <span className="absolute top-1 right-1 size-3 rounded-full bg-mod/30" />
        <span className="absolute bottom-2 left-0 size-2 rounded-full bg-mod/40" />
      </div>
      <div className="space-y-1">
        <div className="font-heading text-base font-semibold">{title}</div>
        {children && <div className="mx-auto max-w-md text-sm text-muted-foreground">{children}</div>}
      </div>
      {action}
    </div>
  );
}

export const TONE = {
  draft: "text-amber-700 dark:text-amber-300",
  done: "text-emerald-700 dark:text-emerald-400",
  open: "text-blue-700 dark:text-blue-300",
  info: "text-sky-700 dark:text-sky-300",
  warn: "text-orange-700 dark:text-orange-300",
  danger: "text-rose-700 dark:text-rose-400",
  violet: "text-violet-700 dark:text-violet-300",
  muted: "text-muted-foreground",
  struck: "text-muted-foreground line-through",
};

const TONE_ICON: Record<string, IconType> = {
  [TONE.draft]: CircleDashedIcon,
  [TONE.done]: CheckCircle2Icon,
  [TONE.open]: CircleDotIcon,
  [TONE.info]: InfoIcon,
  [TONE.warn]: AlertTriangleIcon,
  [TONE.danger]: XCircleIcon,
  [TONE.violet]: CircleDotIcon,
  [TONE.muted]: CircleIcon,
  [TONE.struck]: MinusCircleIcon,
};

/** Object status: a small status icon and coloured text. Give it a TONE. */
export function ObjectStatus({ className = TONE.muted, children, title, icon }: { className?: string; children: React.ReactNode; title?: string; icon?: IconType }) {
  const Icon = icon ?? TONE_ICON[className] ?? CircleIcon;
  return (
    <span className={cn("inline-flex items-center gap-1 text-[0.8rem] font-medium whitespace-nowrap", className)} title={title}>
      <Icon className="size-3.5 shrink-0" />
      {children}
    </span>
  );
}

/** A small tinted tag; quieter than a status. Give it a TONE or leave neutral. */
export function Pill({ className, children, title, dot }: { className?: string; children: React.ReactNode; title?: string; dot?: boolean }) {
  return (
    <span title={title} className={cn("inline-flex h-5 items-center gap-1.5 rounded-md bg-current/8 px-1.5 text-[0.72rem] font-medium whitespace-nowrap text-muted-foreground", className)}>
      {dot && <span aria-hidden className="size-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

const STAT_TONE = { default: "", success: "text-success", warn: "text-warning", danger: "text-danger" };

/** A key figure: white card, gradient icon badge in the module colour, a large number, a hint line and an optional footer. */
export function StatTile({ label, value, hint, icon: Icon, tone = "default", href, footer, className, module }: {
  label: React.ReactNode; value: React.ReactNode; hint?: React.ReactNode; icon?: IconType; tone?: keyof typeof STAT_TONE;
  href?: string; footer?: React.ReactNode; className?: string; module?: ModuleKey;
}) {
  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <span className="pt-1 text-[0.8rem] font-medium text-muted-foreground">{label}</span>
        {Icon && (
          <span className="hover-hop flex size-10 items-center justify-center rounded-xl bg-mod-grad text-white shadow-[0_6px_16px_-6px_var(--mod)]">
            <Icon className="size-[1.1rem]" />
          </span>
        )}
      </div>
      <div className={cn("mt-1 font-heading text-[1.6rem] leading-tight font-semibold tracking-tight tabular-nums", STAT_TONE[tone])}>{value}</div>
      {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
      {footer && <div className="mt-auto pt-4">{footer}</div>}
    </>
  );
  const cls = cn("group surface flex flex-col p-5", href && "card-lift", className);
  return href
    ? <Link href={href} data-module={module} className={cls}>{body}</Link>
    : <div data-module={module} className={cls}>{body}</div>;
}

/** A thin bar that fills to `value` of `max` in the module colour or a tone. */
export function MeterBar({ value, max, tone, label }: { value: number; max: number; tone?: "danger" | "success" | "warn"; label?: React.ReactNode }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="space-y-1.5">
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <motion.div className={cn("h-full origin-left rounded-full", tone === "danger" ? "bg-danger" : tone === "success" ? "bg-success" : tone === "warn" ? "bg-warning" : "bg-mod-grad")}
          style={{ width: `${pct}%` }} initial={motionOff() ? false : { scaleX: 0 }} animate={{ scaleX: 1 }} transition={{ duration: 0.7, ease: EASE, delay: 0.2 }} />
      </div>
      {label && <div className="text-[0.7rem] text-muted-foreground">{label}</div>}
    </div>
  );
}

/** Values as rounded bars in the module gradient that grow in once (AWS One's BarChart). `tone="light"`: for the dark hero card. */
export function BarChart({ values, labels, axis, format, height = 120, tone = "mod", emptyNote }: {
  values: number[]; labels: string[]; axis?: [string, string, string]; format: (n: number) => string; height?: number; tone?: "mod" | "light"; emptyNote?: React.ReactNode;
}) {
  const max = Math.max(...values, 0);
  const animate = !motionOff();
  const light = tone === "light";
  if (max <= 0) {
    return (
      <div className={cn("flex items-center justify-center rounded-xl border border-dashed px-4 text-center text-sm", light ? "border-white/20 text-white/70" : "text-muted-foreground")} style={{ height }}>
        {emptyNote ?? "Nothing yet."}
      </div>
    );
  }
  return (
    <div>
      <div className="relative" style={{ height }} role="img" aria-label="Bar chart">
        {[0.25, 0.5, 0.75, 1].map((f) => (
          <div key={f} aria-hidden className={cn("absolute inset-x-0 border-t border-dashed", light ? "border-white/10" : "border-border")} style={{ bottom: `${f * 100}%` }} />
        ))}
        <div aria-hidden className={cn("absolute inset-x-0 bottom-0 border-t", light ? "border-white/25" : "border-border")} />
        <div className="absolute inset-0 flex items-end gap-[3px]">
          {values.map((v, i) => (
            <div key={i} className="group/bar relative flex h-full flex-1 items-end">
              {v > 0 ? (
                <motion.div
                  className={cn("w-full origin-bottom rounded-t-[4px] transition-opacity group-hover/bar:opacity-85", light ? "bg-[linear-gradient(180deg,oklch(0.86_0.13_165),oklch(0.66_0.14_172))]" : "bg-mod-grad")}
                  style={{ height: `${Math.max(4, (v / max) * 100)}%` }}
                  initial={animate ? { scaleY: 0 } : false} animate={{ scaleY: 1 }}
                  transition={{ duration: 0.55, ease: [0.34, 1.3, 0.64, 1], delay: 0.15 + i * 0.015 }}
                />
              ) : (
                <div className={cn("h-[2px] w-full rounded-full", light ? "bg-white/20" : "bg-muted-foreground/20")} />
              )}
              <div className={cn("pointer-events-none absolute bottom-full z-10 mb-1.5 rounded-md px-2 py-1 text-[0.7rem] whitespace-nowrap opacity-0 shadow-soft transition-opacity group-hover/bar:opacity-100",
                i < 4 ? "left-0" : i > values.length - 5 ? "right-0" : "left-1/2 -translate-x-1/2",
                light ? "bg-white text-ink" : "bg-ink text-background")}>
                {labels[i]} · <span className="font-semibold tabular-nums">{format(v)}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
      {axis && (
        <div className={cn("mt-1.5 flex justify-between text-[0.68rem]", light ? "text-white/55" : "text-muted-foreground")}>
          {axis.map((x) => <span key={x}>{x}</span>)}
        </div>
      )}
    </div>
  );
}

/** A money figure: the currency small and muted before a count-up amount. */
export function MoneyFigure({ value, currency, format, className }: { value: number; currency: string; format: (n: number) => string; className?: string }) {
  return (
    <span className={cn("inline-flex items-baseline gap-1.5", className)}>
      <span className="text-[0.55em] font-medium tracking-normal opacity-60">{currency}</span>
      <CountUp value={value} format={format} />
    </span>
  );
}

/** A search box with a leading icon. */
export function SearchField({ icon: Icon = SearchIcon, className, ...props }: React.ComponentProps<"input"> & { icon?: IconType }) {
  return (
    <div className={cn("relative", className)}>
      <Icon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <input
        type="search"
        data-list-search=""
        className="h-8 w-full min-w-0 rounded-lg border border-input bg-card pr-2.5 pl-8 text-sm transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40 dark:bg-input/30"
        {...props}
      />
    </div>
  );
}

/** A labelled field in an editor: label above, the control, then help text or an inline error. */
export function Field({ label, children, hint, span, required, error }: {
  label: React.ReactNode; children: React.ReactNode; hint?: React.ReactNode; span?: boolean; required?: boolean; error?: string | null;
}) {
  const control = required && typeof label === "string" && isValidElement<{ placeholder?: string }>(children) && children.type === Input
    && children.props.placeholder === undefined
    ? cloneElement(children, { placeholder: `Enter ${label.charAt(0).toLowerCase()}${label.slice(1)}` })
    : children;
  return (
    <div className={span ? "space-y-1.5 sm:col-span-2" : "space-y-1.5"} data-required={required || undefined}>
      <label className="block space-y-1.5">
        <span className="block text-[0.8rem] leading-none font-medium text-foreground/80">
          {label}{required && <span className="sr-only"> (required)</span>}
        </span>
        {control}
      </label>
      {error ? <p className="text-xs text-danger">{error}</p> : hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** A titled block of fields in an editor. `className`: the body's layout. */
export function FieldGroup({ title, children, className, description, actions }: {
  title: string; children: React.ReactNode; className?: string; description?: React.ReactNode; actions?: React.ReactNode;
}) {
  return (
    <section className="surface">
      <div className="flex items-center justify-between gap-3 border-b px-5 py-3">
        <div>
          <h3 className="font-heading text-[0.9rem] font-semibold">{title}</h3>
          {description && <p className="text-xs text-muted-foreground">{description}</p>}
        </div>
        {actions}
      </div>
      <div className={className ?? "grid gap-4 p-5 sm:grid-cols-2"}>{children}</div>
    </section>
  );
}

/** An on/off switch (the same look as AWS One's user-menu switches, larger for touch). */
export function Switch({ on, onChange, label, size = "md", disabled }: { on: boolean; onChange: (on: boolean) => void; label: string; size?: "md" | "lg"; disabled?: boolean }) {
  const lg = size === "lg";
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)}
      className={cn("relative shrink-0 rounded-full transition-colors duration-200 outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50",
        lg ? "h-7 w-12" : "h-5 w-9", on ? "bg-primary" : "bg-muted-foreground/30")}>
      <span className={cn("absolute top-0.5 left-0 rounded-full bg-white shadow transition-transform duration-200 ease-[cubic-bezier(0.34,1.56,0.64,1)]",
        lg ? "size-6" : "size-4", on ? (lg ? "translate-x-5.5" : "translate-x-4.5") : "translate-x-0.5")} />
    </button>
  );
}

/** A row of choices with a sliding highlight (AWS One's ActiveIndicator), e.g. Dine-in / Takeaway / Delivery. */
export function Segmented<T extends string>({ id, value, options, onChange, className, size = "md" }: {
  id: string; value: T; options: { value: T; label: React.ReactNode; icon?: IconType; disabled?: boolean }[]; onChange: (v: T) => void; className?: string; size?: "sm" | "md";
}) {
  return (
    <div role="radiogroup" className={cn("inline-flex rounded-xl bg-muted p-1", className)}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button key={o.value} type="button" role="radio" aria-checked={on} disabled={o.disabled} onClick={() => onChange(o.value)}
            className={cn("relative flex flex-1 items-center justify-center gap-1.5 rounded-lg font-medium whitespace-nowrap transition-colors disabled:opacity-40",
              size === "sm" ? "h-7 px-2.5 text-xs" : "h-8 px-3 text-[0.8125rem]",
              on ? "text-foreground" : "text-muted-foreground hover:text-foreground")}>
            {on && <ActiveIndicator id={id} className="rounded-lg bg-card shadow-soft ring-1 ring-border" />}
            {o.icon && <o.icon className="relative size-3.5" />}
            <span className="relative">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * A button for an action that takes a moment: a spinner while `onClick` runs, then a checkmark for a moment
 * (`celebrate`: plus AWS One's success check-mark and confetti). A refusal (PosError) shows as an error toast.
 */
export function ActionButton({ onClick, children, celebrate: party, ...props }: Omit<React.ComponentProps<typeof Button>, "onClick"> & {
  onClick: () => Promise<unknown> | unknown; celebrate?: boolean;
}) {
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const ref = useRef<HTMLButtonElement>(null);
  async function run() {
    if (state !== "idle") return;
    setState("busy");
    try {
      await onClick();
      setState("done");
      if (party) celebrate(ref.current);
      window.setTimeout(() => setState("idle"), 1400);
    } catch (e) {
      setState("idle");
      if (e instanceof PosError) toast.error(e.message);
      else throw e;
    }
  }
  return (
    <Button ref={ref} {...props} onClick={run} disabled={props.disabled || state === "busy"} aria-busy={state === "busy"}
      className={cn(state === "done" && "bg-success text-white hover:bg-success", props.className)}>
      {state === "busy" ? <><Loader2Icon className="animate-spin" /> Working…</> : state === "done" ? <><CheckIcon /> Done</> : children}
    </Button>
  );
}

/** Loading placeholder shaped like a table: a header bar and shimmering rows (AWS One's LoadingRows). */
export function LoadingRows({ rows = 6 }: { rows?: number }) {
  return (
    <div className="surface overflow-hidden" aria-busy="true" aria-label="Loading">
      <div className="flex gap-6 border-b bg-muted/50 px-4 py-3">
        {[16, 40, 20, 14].map((w, i) => <Skeleton key={i} className="h-3" style={{ width: `${w}%` }} />)}
      </div>
      <div className="divide-y">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="flex items-center gap-6 px-4 py-3">
            <Skeleton className="h-3.5 w-[14%]" />
            <Skeleton className="h-3.5 w-[38%]" />
            <Skeleton className="h-3.5 w-[18%]" />
            <Skeleton className="ml-auto h-3.5 w-[10%]" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** A table inside a white panel: hairline frame, tinted header row, sideways scroll when wide. */
export function TablePanel({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("surface overflow-x-auto [&_thead_th]:bg-muted [&_thead_tr]:border-b", className)}>{children}</div>;
}

/** A plain <select> styled like the inputs. */
export const selectClass = "h-8 w-full min-w-0 rounded-lg border border-input bg-card px-2.5 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40 dark:bg-input/30";

/** An error line under a form or list. */
export function ErrorNote({ message }: { message: string | null | undefined }) {
  if (!message) return null;
  return <p role="alert" className="animate-rise-in rounded-xl border border-danger/25 bg-danger/5 px-3 py-2 text-sm text-danger">{message}</p>;
}
