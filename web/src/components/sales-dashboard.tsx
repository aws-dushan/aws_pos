"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  ArmchairIcon, BanknoteIcon, BikeIcon, CreditCardIcon, GiftIcon, HandPlatterIcon, MonitorSmartphoneIcon, PercentIcon, ReceiptTextIcon,
  RotateCcwIcon, ShoppingBagIcon, UserRoundIcon, UsersRoundIcon, WalletCardsIcon,
  StarIcon,
} from "lucide-react";
import { useApi } from "@/lib/api";
import { cn } from "@/lib/utils";
import { fmtIn } from "@/lib/num";
import { METHOD_LABEL, TYPE_LABEL, type OrderType, type PayMethod } from "@/lib/pos";
import { useSession } from "@/components/session";
import { useLiveEvent } from "@/components/live";
import { Avatar, BarChart, MeterBar, MoneyFigure, Segmented, StatTile } from "@/components/kit";
import { CountUp, Stagger, StaggerItem } from "@/components/motion";
import { Skeleton } from "@/components/ui/skeleton";

type Dash = {
  view: "register" | "branch"; date: string; registerName: string | null; sales: number; yesterday: number; yesterdaySoFar: number; compareAt: string | null; orders: number; averageTicket: number;
  discounts: number; refunds: number; openOrders: { count: number; value: number }; voids: { count: number; value: number };
  byMethod: { method: PayMethod; amount: number }[]; byType: { type: OrderType; amount: number; orders: number }[];
  byPlatform?: { name: string; amount: number; orders: number }[];
  byHour: { hour: number; amount: number }[];
  byRegister: { name: string; amount: number; orders: number }[] | null; byCashier: { name: string; amount: number; orders: number }[] | null;
};

const money = (n: number) => fmtIn(n, 2);
const METHOD_ICON: Record<PayMethod, React.ComponentType<{ className?: string }>> = { cash: BanknoteIcon, card: CreditCardIcon, other: WalletCardsIcon, voucher: GiftIcon, account: UserRoundIcon, points: StarIcon, platform: BikeIcon };
const TYPE_ICON: Record<OrderType, React.ComponentType<{ className?: string }>> = { dine_in: ArmchairIcon, takeaway: ShoppingBagIcon, delivery: BikeIcon };

/**
 * The sales dashboard (REQ RPT-01): "Register sales" (this till; permission dashboard.register, on a till) and "Branch sales"
 * (every register; dashboard.branch). Which ones a role sees is set by an admin in Roles. Figures update live as orders are paid.
 */
export function SalesDashboard() {
  const { can, isTill, me, company, branch } = useSession();
  const views: { value: "register" | "branch"; label: string }[] = [
    ...(can("dashboard.register") && isTill ? [{ value: "register" as const, label: `Register sales${me.till?.registerName ? ` · ${me.till.registerName}` : ""}` }] : []),
    ...(can("dashboard.branch") ? [{ value: "branch" as const, label: `Branch sales · ${branch?.name ?? ""}` }] : []),
  ];
  const [view, setView] = useState<"register" | "branch">(views[0]?.value ?? "branch");
  const dash = useApi<Dash>(views.length ? `/dashboard?view=${view}` : null);
  // Live: re-read a moment after orders change (a burst of taps reloads once).
  const timer = useRef<number | undefined>(undefined);
  useLiveEvent(["order.changed"], () => { window.clearTimeout(timer.current); timer.current = window.setTimeout(() => dash.reload(), 600); });
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const cur = company?.currency ?? "AED";

  if (!views.length) {
    return can("dashboard.register")
      ? <p className="surface px-5 py-6 text-sm text-muted-foreground">Register sales show on a till. Set this device up as a till, or ask an admin for Branch sales.</p>
      : null;
  }
  const d = dash.data;
  const hours = d ? d.byHour.filter((h) => h.hour >= 6) : [];
  // While the day is open: against yesterday by the same time of day; once closed, full day against full day.
  const delta = d && d.yesterdaySoFar > 0 ? ((d.sales - d.yesterdaySoFar) / d.yesterdaySoFar) * 100 : null;
  const maxMethod = d ? Math.max(1, ...d.byMethod.map((m) => m.amount)) : 1;

  return (
    <section className="space-y-4" aria-label="Sales">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-heading text-[0.95rem] font-semibold">Today&apos;s sales</h2>
        {views.length > 1 ? <Segmented id="dash-view" value={view} onChange={setView} options={views} /> : <span className="text-sm text-muted-foreground">{views[0].label}</span>}
      </div>

      {!d ? (
        <div className="space-y-4"><Skeleton className="h-56 rounded-[1.25rem]" /><div className="grid gap-4 md:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-36 rounded-[1.25rem]" />)}</div></div>
      ) : (
        <>
          {/* Hero: AWS One's sales card. */}
          <div key={view} className="animate-rise-in grid gap-6 rounded-[1.25rem] p-6 text-white shadow-lift md:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]" style={{ background: "var(--hero)" }}>
            <div className="flex flex-col justify-between gap-5">
              <div>
                <div className="flex items-center gap-2 text-sm text-white/70">
                  <span className="flex size-7 items-center justify-center rounded-lg bg-white/12">{d.view === "register" ? <MonitorSmartphoneIcon className="size-3.5" /> : <ReceiptTextIcon className="size-3.5" />}</span>
                  {d.view === "register" ? `${d.registerName ?? "This register"} · sales today` : `${branch?.name} · sales today`}
                </div>
                <div className="mt-3 font-heading text-[2.6rem] leading-none font-semibold tracking-tight"><MoneyFigure value={d.sales} currency={cur} format={money} /></div>
                <div className="mt-3 text-xs text-white/75">
                  {delta === null ? (d.compareAt && d.yesterday > 0 ? `No sales by ${d.compareAt} yesterday to compare` : "No sales yesterday to compare") : (
                    <><span className={cn("font-semibold", delta >= 0 ? "text-emerald-300" : "text-rose-300")}>{delta >= 0 ? "▲" : "▼"} {Math.abs(delta).toFixed(1)}%</span>{" "}
                      {d.compareAt ? `vs same time yesterday (${cur} ${money(d.yesterdaySoFar)} by ${d.compareAt})` : `vs yesterday (${cur} ${money(d.yesterday)})`}</>
                  )}
                  {d.compareAt && d.yesterday > 0 && <div className="mt-0.5 text-white/60">Yesterday all day: {cur} {money(d.yesterday)}</div>}
                </div>
              </div>
              <div className="grid grid-cols-3 gap-4 border-t border-white/12 pt-4 text-sm">
                <Mini label="Orders" value={<CountUp value={d.orders} format={(n) => Math.round(n).toLocaleString("en-US")} />} />
                <Mini label="Average ticket" value={`${money(d.averageTicket)}`} />
                <Mini label="Refunds" value={money(d.refunds)} />
              </div>
            </div>
            <div className="flex flex-col justify-end">
              <div className="mb-3 text-xs text-white/60">Sales by hour</div>
              <BarChart tone="light" height={130} values={hours.map((h) => h.amount)} labels={hours.map((h) => `${String(h.hour).padStart(2, "0")}:00`)}
                axis={["06:00", "15:00", "23:00"]} format={(v) => `${cur} ${money(v)}`} emptyNote="Sales show here hour by hour as orders are paid." />
            </div>
          </div>

          <Stagger key={`tiles-${view}`} className="grid items-stretch gap-4 sm:grid-cols-2 md:grid-cols-4">
            <StaggerItem className="h-full">
              <StatTile module="bank" icon={BanknoteIcon} className="h-full" label="Payments" value={<MoneyFigure value={d.byMethod.reduce((t, m) => t + m.amount, 0)} currency={cur} format={money} />}
                hint="Net of refunds, by method"
                footer={d.byMethod.length ? (
                  <div className="space-y-2.5">
                    {d.byMethod.map((m) => {
                      const Icon = METHOD_ICON[m.method] ?? WalletCardsIcon;
                      return <MeterBar key={m.method} value={m.amount} max={maxMethod} label={<span className="flex items-center justify-between gap-2"><span className="flex items-center gap-1"><Icon className="size-3" />{METHOD_LABEL[m.method] ?? m.method}</span><span className="tabular-nums">{money(m.amount)}</span></span>} />;
                    })}
                  </div>
                ) : <span className="text-xs text-muted-foreground">No payments yet.</span>} />
            </StaggerItem>
            <StaggerItem className="h-full">
              <StatTile module="sales" icon={HandPlatterIcon} className="h-full" label="Order types" value={<CountUp value={d.orders} format={(n) => `${Math.round(n)} paid`} />}
                footer={<div className="space-y-2.5">{d.byType.filter((t) => t.orders || t.type !== "dine_in" || branch?.tableService).map((t) => {
                  const Icon = TYPE_ICON[t.type];
                  const label = t.type === "delivery" && d.byPlatform?.length ? "Own delivery" : TYPE_LABEL[t.type];
                  return <MeterBar key={t.type} value={t.amount} max={Math.max(1, d.sales)} label={<span className="flex items-center justify-between gap-2"><span className="flex items-center gap-1"><Icon className="size-3" />{label} · {t.orders}</span><span className="tabular-nums">{money(t.amount)}</span></span>} />;
                })}
                {/* Each delivery platform's share of the day (details in the Delivery platform report). */}
                {(d.byPlatform ?? []).map((p) => (
                  <MeterBar key={p.name} value={p.amount} max={Math.max(1, d.sales)} label={<span className="flex items-center justify-between gap-2"><span className="flex items-center gap-1"><BikeIcon className="size-3" />{p.name} · {p.orders}</span><span className="tabular-nums">{money(p.amount)}</span></span>} />
                ))}
                {!!d.byPlatform?.length && <Link href="/platforms" className="link-slide block text-xs text-muted-foreground">Platform commission and payout</Link>}
                </div>} />
            </StaggerItem>
            <StaggerItem className="h-full">
              <StatTile module="fin" icon={ReceiptTextIcon} href="/register" className="h-full" label="Open orders" value={<CountUp value={d.openOrders.count} format={(n) => String(Math.round(n))} />}
                hint={`${cur} ${money(d.openOrders.value)} not yet paid`}
                footer={<MeterBar value={d.openOrders.count} max={Math.max(1, d.openOrders.count + d.orders)} tone="warn" label="Open vs all today" />} />
            </StaggerItem>
            <StaggerItem className="h-full">
              <StatTile module="bp" icon={PercentIcon} href="/orders" className="h-full" label="Discounts & voids" value={<MoneyFigure value={d.discounts} currency={cur} format={money} />}
                hint={`${d.voids.count} void${d.voids.count === 1 ? "" : "s"} · ${cur} ${money(d.voids.value)}`}
                footer={<div className="flex items-center gap-1.5 text-xs text-muted-foreground"><RotateCcwIcon className="size-3" />{cur} {money(d.refunds)} refunded</div>} />
            </StaggerItem>
          </Stagger>

          {d.view === "branch" && (
            <div className="grid gap-4 md:grid-cols-2">
              <Breakdown title="By register" icon={MonitorSmartphoneIcon} rows={d.byRegister ?? []} total={d.sales} currency={cur} />
              <Breakdown title="By cashier" icon={UsersRoundIcon} rows={d.byCashier ?? []} total={d.sales} currency={cur} people />
            </div>
          )}
          <p className="text-xs text-muted-foreground">Business date {new Date(d.date + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}. <Link href="/orders" className="link-slide">All orders</Link></p>
        </>
      )}
    </section>
  );
}

function Mini({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-white/60">{label}</div>
      <div className="mt-0.5 font-heading font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function Breakdown({ title, icon: Icon, rows, total, currency, people }: {
  title: string; icon: React.ComponentType<{ className?: string }>; rows: { name: string; amount: number; orders: number }[]; total: number; currency: string; people?: boolean;
}) {
  return (
    <section className="surface" aria-label={title}>
      <div className="flex items-center gap-2 border-b px-5 py-3.5"><Icon className="size-4 text-muted-foreground" /><h3 className="font-heading text-[0.9rem] font-semibold">{title}</h3></div>
      {rows.length ? (
        <Stagger className="divide-y">
          {rows.map((r) => (
            <StaggerItem key={r.name}>
              <div className="flex items-center gap-3 px-5 py-3">
                {people ? <Avatar name={r.name} size="md" /> : <span className="flex size-9 items-center justify-center rounded-xl bg-primary/10 text-primary"><MonitorSmartphoneIcon className="size-4" /></span>}
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2 text-sm"><span className="font-medium">{r.name}</span><span className="font-medium tabular-nums">{currency} {money(r.amount)}</span></div>
                  <div className="mt-1.5"><MeterBar value={r.amount} max={Math.max(1, total)} label={`${r.orders} order${r.orders === 1 ? "" : "s"} · ${total ? Math.round((r.amount / total) * 100) : 0}%`} /></div>
                </div>
              </div>
            </StaggerItem>
          ))}
        </Stagger>
      ) : <p className="px-5 py-6 text-sm text-muted-foreground">No sales yet today.</p>}
    </section>
  );
}
