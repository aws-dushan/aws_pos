"use client";

import Link from "next/link";
import {
  ArmchairIcon, ArrowRightIcon, Building2Icon, CalendarDaysIcon, CheckIcon, ChefHatIcon, MonitorSmartphoneIcon, MoonStarIcon, PlugZapIcon,
  ShoppingBasketIcon, StoreIcon, SunIcon, SunriseIcon, UsersRoundIcon,
} from "lucide-react";
import { useApi } from "@/lib/api";
import { useNow, useStored } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { TILL_KEY, useSession } from "@/components/session";
import { MeterBar, StatTile } from "@/components/kit";
import { SalesDashboard } from "@/components/sales-dashboard";
import { MyShiftCard } from "@/components/my-shift";
import { Stagger, StaggerItem } from "@/components/motion";
import { ModuleIcon, type ModuleKey } from "@/components/modules";

type UserRow = { id: string; hasPin: boolean; isActive: boolean };

const greeting = (h: number) => (h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening");

/** Home: the greeting band, my shift (open / close, always in view), the sales dashboard (register and/or branch, per role) and, until set up, the checklist. */
export default function HomePage() {
  const { me, company, branch, can, isTill } = useSession();
  const users = useApi<UserRow[]>(company && can("users.manage") ? `/companies/${company.id}/users` : null);
  const now = useNow(60000);
  const till = useStored(TILL_KEY);
  if (!now) return null;

  const withPin = users.data?.filter((u) => u.hasPin && u.isActive).length ?? 0;
  const steps: { done: boolean; title: string; text: string; href?: string; icon: React.ComponentType<{ className?: string }>; module: ModuleKey; show: boolean }[] = [
    { done: me.companies.length > 0, title: "Create the company", text: "Legal name, TRN, VAT and its ERP: AWS One, FACTS or none.", href: "/admin/companies", icon: Building2Icon, module: "admin", show: me.user.isAdmin },
    { done: !!company?.branches.length, title: "Add a branch", text: "Each location, with table service on or off.", href: "/admin/companies", icon: StoreIcon, module: "sales", show: me.user.isAdmin || can("branch.manage") },
    { done: withPin > 0, title: "Add staff with PINs", text: "Cashiers and waiters sign in at the till with a 4–6 digit PIN.", href: "/admin/users", icon: UsersRoundIcon, module: "bp", show: can("users.manage") },
    { done: !!till, title: "Set up a till", text: "On the till's browser: user menu › Use this device as a till.", icon: MonitorSmartphoneIcon, module: "fin", show: can("branch.manage") && !isTill },
  ];
  const shown = steps.filter((s) => s.show);
  const done = shown.filter((s) => s.done).length;

  const next: { phase: string; title: string; text: string; icon: React.ComponentType<{ className?: string }>; module: ModuleKey }[] = [
    { phase: "Phase 1", title: "Devices", text: "Receipt printer, cash drawer and customer display through the Device Service.", icon: ShoppingBasketIcon, module: "fin" },
    { phase: "Phase 2", title: "Restaurant operations", text: "Floor plans, tables, kitchen display, shifts and day close.", icon: ArmchairIcon, module: "sales" },
    { phase: "Phase 2", title: "Kitchen", text: "Stations, tickets, timers and kitchen printers.", icon: ChefHatIcon, module: "purch" },
    { phase: "Phase 3", title: "AWS One and FACTS", text: "Items and stock from the ERP; sales, returns (STV) and payments back.", icon: PlugZapIcon, module: "inv" },
  ];

  return (
    <div className="space-y-6 pt-4">
      <GreetingBand name={me.user.displayName} place={branch ? `${company?.name} · ${branch.name}` : company?.name ?? "No company yet"} code={company?.code ?? "–"} now={now} />

      {branch && <MyShiftCard autoOpen />}

      {branch && (can("dashboard.register") || can("dashboard.branch")) && <SalesDashboard />}

      {shown.length > 0 && done < shown.length && (
        <section className="surface" aria-label="Set-up">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-3.5">
            <div>
              <h2 className="font-heading text-[0.95rem] font-semibold">Get ready to sell</h2>
              <p className="text-xs text-muted-foreground">{done === shown.length ? "All set. The register arrives in phase 1." : `${done} of ${shown.length} done`}</p>
            </div>
            <div className="w-40" data-module="sales"><MeterBar value={done} max={shown.length} tone={done === shown.length ? "success" : undefined} /></div>
          </div>
          <Stagger className="divide-y">
            {shown.map((s) => {
              const body = (
                <>
                  <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-full transition-colors", s.done ? "bg-success text-white" : "")}>
                    {s.done ? <CheckIcon className="size-4" /> : <ModuleIcon module={s.module} icon={s.icon} size="md" className="hover-hop" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={cn("block text-sm font-medium", s.done && "text-muted-foreground line-through decoration-muted-foreground/50")}>{s.title}</span>
                    <span className="block text-xs text-muted-foreground">{s.text}</span>
                  </span>
                  {s.href && !s.done && <ArrowRightIcon className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />}
                </>
              );
              return (
                <StaggerItem key={s.title}>
                  {s.href && !s.done
                    ? <Link href={s.href} className="group flex items-center gap-3.5 px-5 py-3 transition-colors hover:bg-muted/60">{body}</Link>
                    : <div className="group flex items-center gap-3.5 px-5 py-3">{body}</div>}
                </StaggerItem>
              );
            })}
          </Stagger>
        </section>
      )}

      {!(branch && (can("dashboard.register") || can("dashboard.branch"))) && <section aria-label="Coming next">
        <h2 className="mb-3 font-heading text-[0.95rem] font-semibold">Coming next</h2>
        <Stagger className="grid items-stretch gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {next.map((n) => (
            <StaggerItem key={n.title} className="h-full">
              <StatTile module={n.module} icon={n.icon} className="h-full" label={n.phase} value={<span className="text-[1.15rem]">{n.title}</span>} hint={n.text} />
            </StaggerItem>
          ))}
        </Stagger>
      </section>}
    </div>
  );
}

/** AWS One's greeting band: soft indigo → violet tint, dot pattern, initials, greeting with a rising time-of-day icon, chips. */
function GreetingBand({ name, place, code, now }: { name: string; place: string; code: string; now: Date }) {
  const h = now.getHours();
  const Icon = h < 12 ? SunriseIcon : h < 17 ? SunIcon : MoonStarIcon;
  return (
    <section className="animate-rise-in relative flex min-h-[72px] flex-wrap items-center justify-between gap-x-6 gap-y-2 overflow-hidden rounded-[1.25rem] border px-5 py-3
      bg-[linear-gradient(100deg,oklch(0.93_0.045_275)_0%,oklch(0.95_0.035_295)_35%,var(--card)_75%)]
      dark:bg-[linear-gradient(100deg,oklch(0.3_0.09_275)_0%,oklch(0.25_0.05_290)_40%,var(--card)_80%)]">
      <div aria-hidden className="pointer-events-none absolute inset-y-0 right-0 w-1/2 opacity-60 [background-image:radial-gradient(color-mix(in_oklab,var(--primary)_22%,transparent)_1px,transparent_1.5px)] [background-size:14px_14px] [mask-image:linear-gradient(90deg,transparent,black_60%)]" />
      <div className="relative flex min-w-0 items-center gap-3.5">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-linear-to-br from-[oklch(0.55_0.2_268)] to-[oklch(0.55_0.2_300)] text-sm font-semibold text-white shadow-[0_4px_12px_-4px_oklch(0.5_0.2_280)]">
          {name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase()}
        </span>
        <h1 className="flex items-center gap-2 font-heading text-[1.4rem] leading-tight font-light tracking-tight">
          <span>{greeting(h)}, <span className="font-semibold">{name}</span></span>
          <span className="greet-icon inline-flex text-amber-500 dark:text-amber-300"><Icon className="size-5" /></span>
        </h1>
      </div>
      <div className="relative flex flex-wrap items-center gap-2 text-xs">
        <span className="inline-flex h-7 items-center gap-1.5 rounded-full border bg-card px-3 font-medium text-foreground shadow-soft">
          <CalendarDaysIcon className="size-3.5 text-primary" />
          {now.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" })}
        </span>
        <span className="inline-flex h-7 items-center gap-1.5 rounded-full border bg-card pr-3 pl-1 font-medium text-foreground shadow-soft">
          <span className="flex size-5 items-center justify-center rounded-full bg-ink text-[0.55rem] font-semibold text-background">{code.slice(0, 2)}</span>
          {place}
        </span>
      </div>
    </section>
  );
}
