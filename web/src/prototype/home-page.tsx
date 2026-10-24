"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  ArmchairIcon, ArrowRightIcon, BikeIcon, CalendarDaysIcon, ChefHatIcon, HandPlatterIcon, MoonStarIcon, ReceiptTextIcon,
  ShoppingBagIcon, SunIcon, SunriseIcon, UsersRoundIcon, WalletIcon,
} from "lucide-react";
import { cn, timeAgo } from "@/lib/utils";
import { usePosState } from "@/prototype/store";
import { money, orderTotals } from "@/prototype/totals";
import { BarChart, MeterBar, MoneyFigure, ObjectStatus, StatTile, TONE } from "@/components/kit";
import { Stagger, StaggerItem } from "@/components/motion";
import { ModuleIcon, type ModuleKey } from "@/components/modules";
import type { Order } from "@/prototype/types";

const greeting = (h: number) => (h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening");
const isToday = (iso?: string) => !!iso && new Date(iso).toDateString() === new Date().toDateString();

/** Today at a glance: greeting, sales hero card, key figures, recent orders and quick starts (the AWS One launchpad layout). */
export default function HomePage() {
  const s = usePosState();
  const { settings } = s;
  const cur = settings.currency;
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => setNow(new Date()), []);

  const paidToday = s.orders.filter((o) => o.status === "paid" && isToday(o.paidAt));
  const open = s.orders.filter((o) => o.status === "open");
  const sales = paidToday.reduce((t, o) => t + orderTotals(o, settings).total, 0);
  const avg = paidToday.length ? sales / paidToday.length : 0;
  const guests = paidToday.reduce((t, o) => t + (o.guests ?? 0), 0);
  const queue = s.tickets.filter((t) => t.status === "new" || t.status === "preparing").length;
  const ready = s.tickets.filter((t) => t.status === "ready").length;
  const seated = open.filter((o) => o.type === "dine-in" && o.tableId).length;
  const seats = open.filter((o) => o.type === "dine-in").reduce((t, o) => t + (o.guests ?? 0), 0);

  // Sales by hour, 08:00 – 23:00.
  const hours = Array.from({ length: 16 }, (_, i) => i + 8);
  const byHour = hours.map((h) => paidToday.filter((o) => new Date(o.paidAt!).getHours() === h).reduce((t, o) => t + orderTotals(o, settings).total, 0));
  const byType = (["dine-in", "takeaway", "delivery"] as const).map((type) => paidToday.filter((o) => o.type === type).reduce((t, o) => t + orderTotals(o, settings).total, 0));

  const recent = [...s.orders].filter((o) => o.status !== "void").sort((a, b) => (b.paidAt ?? b.createdAt).localeCompare(a.paidAt ?? a.createdAt)).slice(0, 7);

  const actions: { label: string; href: string; icon: React.ComponentType<{ className?: string }>; module: ModuleKey }[] = [
    ...(settings.tableService ? [{ label: "Seat a table", href: "/floor", icon: ArmchairIcon, module: "sales" as const }] : []),
    { label: "Takeaway", href: "/register?new=takeaway", icon: ShoppingBagIcon, module: "fin" },
    { label: "Delivery", href: "/register?new=delivery", icon: BikeIcon, module: "bank" },
    { label: "Kitchen", href: "/kitchen", icon: ChefHatIcon, module: "purch" },
  ];

  if (!now) return null;
  return (
    <div className="space-y-6 pt-4">
      <GreetingBand name={settings.cashierName} outlet={settings.restaurantName} code={settings.outletCode} mode={settings.tableService ? "Table service" : "Quick service"} now={now} />

      <div className="space-y-4">
        <Link href="/orders?status=paid" className="animate-rise-in card-lift grid gap-6 rounded-[1.25rem] p-6 text-white shadow-lift lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]" style={{ background: "var(--hero)" }}>
          <div className="flex flex-col justify-between gap-5">
            <div>
              <div className="flex items-center gap-2 text-sm text-white/70">
                <span className="flex size-7 items-center justify-center rounded-lg bg-white/12"><ReceiptTextIcon className="size-3.5" /></span>
                Sales today
              </div>
              <div className="mt-3 font-heading text-[2.4rem] leading-none font-semibold tracking-tight">
                <MoneyFigure value={sales} currency={cur} format={money} />
              </div>
              <div className="mt-3 text-xs text-white/70">incl. VAT {settings.vatRate}% · {paidToday.length} paid order{paidToday.length === 1 ? "" : "s"}</div>
            </div>
            <div className="grid grid-cols-3 gap-4 border-t border-white/12 pt-4 text-sm">
              {settings.tableService && <Mini label="Dine-in" value={`${cur} ${money(byType[0])}`} />}
              <Mini label="Takeaway" value={`${cur} ${money(byType[1])}`} />
              <Mini label="Delivery" value={`${cur} ${money(byType[2])}`} />
            </div>
          </div>
          <div className="flex flex-col justify-end">
            <div className="mb-3 flex items-baseline justify-between text-xs text-white/60">
              <span>Sales by hour</span>
              <span>Average ticket <span className="font-heading text-sm font-semibold text-white tabular-nums">{cur} {money(avg)}</span></span>
            </div>
            <BarChart tone="light" height={120} values={byHour} labels={hours.map((h) => `${String(h).padStart(2, "0")}:00`)}
              axis={["08:00", "15:00", "23:00"]} format={(v) => `${cur} ${money(v)}`}
              emptyNote="Sales show here hour by hour as orders are paid." />
          </div>
        </Link>

        <Stagger className="grid items-stretch gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {settings.tableService ? (
            <StaggerItem className="h-full">
              <StatTile module="sales" icon={ArmchairIcon} href="/floor" className="h-full" label="Tables seated"
                value={`${seated} / ${s.tables.length}`} hint={`${seats} guest${seats === 1 ? "" : "s"} in the room`}
                footer={<MeterBar value={seated} max={s.tables.length || 1} label={`${Math.round((seated / (s.tables.length || 1)) * 100)}% occupancy`} />} />
            </StaggerItem>
          ) : (
            <StaggerItem className="h-full">
              <StatTile module="sales" icon={ShoppingBagIcon} href="/orders" className="h-full" label="Orders today"
                value={paidToday.length + open.length} hint={`${open.length} still open`}
                footer={<MeterBar value={paidToday.length} max={paidToday.length + open.length || 1} tone="success" label="Paid share" />} />
            </StaggerItem>
          )}
          <StaggerItem className="h-full">
            <StatTile module="fin" icon={HandPlatterIcon} href="/orders" className="h-full" label="Open orders"
              value={open.length} hint={`${cur} ${money(open.reduce((t, o) => t + orderTotals(o, settings).total, 0))} on open bills`}
              footer={<MeterBar value={open.filter((o) => o.billRequested).length} max={open.length || 1} tone="warn" label={`${open.filter((o) => o.billRequested).length} asked for the bill`} />} />
          </StaggerItem>
          <StaggerItem className="h-full">
            <StatTile module="purch" icon={ChefHatIcon} href="/kitchen" className="h-full" label="Kitchen queue"
              value={queue} hint={`${ready} ready to serve`} tone={queue > 8 ? "warn" : "default"}
              footer={<MeterBar value={ready} max={queue + ready || 1} tone="success" label="Ready vs in progress" />} />
          </StaggerItem>
          <StaggerItem className="h-full">
            <StatTile module="bank" icon={settings.tableService ? UsersRoundIcon : WalletIcon} className="h-full"
              label={settings.tableService ? "Guests served" : "Average ticket"}
              value={settings.tableService ? guests : <MoneyFigure value={avg} currency={cur} format={money} />}
              hint={settings.tableService ? `Average ticket ${cur} ${money(avg)}` : "Paid orders today"}
              footer={<MeterBar value={1} max={1} label="Today, paid orders" />} />
          </StaggerItem>
        </Stagger>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <section className="surface lg:col-span-2" aria-label="Recent orders">
          <div className="flex items-center justify-between border-b px-5 py-3.5">
            <h2 className="font-heading text-[0.95rem] font-semibold">Recent orders</h2>
            <Link href="/orders" className="link-slide text-xs text-muted-foreground">All orders</Link>
          </div>
          {recent.length ? (
            <Stagger className="divide-y">
              {recent.map(recentRow)}
            </Stagger>
          ) : (
            <p className="px-5 py-10 text-center text-sm text-muted-foreground">No orders yet today. Start one from the right, or press <kbd className="rounded-md border bg-muted px-1.5 py-0.5 text-xs">F2</kbd>.</p>
          )}
        </section>

        <section aria-label="Start">
          <h2 className="mb-3 font-heading text-[0.95rem] font-semibold">Start</h2>
          <div className="grid grid-cols-2 gap-2.5">
            {actions.map((a) => (
              <Link key={a.href} href={a.href} data-module={a.module} className="group surface card-lift flex items-center gap-2.5 px-3 py-2.5 text-sm font-medium">
                <ModuleIcon module={a.module} icon={a.icon} size="sm" solid className="hover-hop" />
                {a.label}
              </Link>
            ))}
          </div>
        </section>
      </div>
    </div>
  );

  function recentRow(o: Order) {
    const t = orderTotals(o, settings);
    const table = o.tableId ? s.tables.find((x) => x.id === o.tableId) : undefined;
    const Icon = o.type === "dine-in" ? ArmchairIcon : o.type === "delivery" ? BikeIcon : ShoppingBagIcon;
    const mod: ModuleKey = o.type === "dine-in" ? "sales" : o.type === "delivery" ? "bank" : "fin";
    return (
      <StaggerItem key={o.id}>
        <Link href={o.status === "open" ? `/register?order=${o.id}` : `/orders?show=${o.id}`} className="group flex items-center gap-3.5 px-5 py-3 transition-colors hover:bg-muted/60">
          <ModuleIcon module={mod} icon={Icon} size="md" solid className="hover-hop" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
              <span className="font-medium">{table ? `Table ${table.name}` : o.customerName || (o.type === "delivery" ? "Delivery" : "Takeaway")}</span>
              <span className="font-mono text-xs text-muted-foreground">#{o.number}</span>
              {o.status === "paid" ? <ObjectStatus className={TONE.done}>Paid</ObjectStatus>
                : o.billRequested ? <ObjectStatus className={TONE.warn}>Bill asked</ObjectStatus>
                  : <ObjectStatus className={TONE.open}>Open</ObjectStatus>}
            </div>
            <div className="text-xs text-muted-foreground">{t.items} item{t.items === 1 ? "" : "s"}{o.guests ? ` · ${o.guests} guests` : ""}</div>
          </div>
          <div className="text-right">
            <div className="text-sm font-medium tabular-nums"><span className="mr-1 text-xs text-muted-foreground">{settings.currency}</span>{money(t.total)}</div>
            <div className="text-xs text-muted-foreground">{timeAgo(o.paidAt ?? o.createdAt)}</div>
          </div>
          <ArrowRightIcon className="size-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
        </Link>
      </StaggerItem>
    );
  }
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-white/60">{label}</div>
      <div className="mt-0.5 [overflow-wrap:anywhere] font-heading font-semibold tabular-nums">{value}</div>
    </div>
  );
}

/** AWS One's greeting band: soft indigo → violet tint, dot pattern, initials, greeting with a rising time-of-day icon, chips. */
function GreetingBand({ name, outlet, code, mode, now }: { name: string; outlet: string; code: string; mode: string; now: Date }) {
  const h = now.getHours();
  const Icon = h < 12 ? SunriseIcon : h < 17 ? SunIcon : MoonStarIcon;
  const initials = name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  return (
    <section className="animate-rise-in relative flex min-h-[72px] flex-wrap items-center justify-between gap-x-6 gap-y-2 overflow-hidden rounded-[1.25rem] border px-5 py-3
      bg-[linear-gradient(100deg,oklch(0.93_0.045_275)_0%,oklch(0.95_0.035_295)_35%,var(--card)_75%)]
      dark:bg-[linear-gradient(100deg,oklch(0.3_0.09_275)_0%,oklch(0.25_0.05_290)_40%,var(--card)_80%)]">
      <div aria-hidden className="pointer-events-none absolute inset-y-0 right-0 w-1/2 opacity-60 [background-image:radial-gradient(color-mix(in_oklab,var(--primary)_22%,transparent)_1px,transparent_1.5px)] [background-size:14px_14px] [mask-image:linear-gradient(90deg,transparent,black_60%)]" />
      <div className="relative flex min-w-0 items-center gap-3.5">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-linear-to-br from-[oklch(0.55_0.2_268)] to-[oklch(0.55_0.2_300)] text-sm font-semibold text-white shadow-[0_4px_12px_-4px_oklch(0.5_0.2_280)]">
          {initials}
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
        <span className={cn("inline-flex h-7 items-center gap-1.5 rounded-full border bg-card pr-3 pl-1 font-medium text-foreground shadow-soft")}>
          <span className="flex size-5 items-center justify-center rounded-full bg-ink text-[0.55rem] font-semibold text-background">{code.slice(0, 2)}</span>
          {outlet} <span className="text-muted-foreground">· {mode}</span>
        </span>
      </div>
    </section>
  );
}
