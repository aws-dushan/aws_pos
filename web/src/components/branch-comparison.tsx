"use client";

import { LightbulbIcon } from "lucide-react";
import type { ExportTable } from "@/lib/export";
import { fmtIn } from "@/lib/num";
import { SummaryView } from "@/components/summary-report";

/** The Branch comparison report (admin and finance): what /reports/branch-comparison returns. */
export type Comparison = {
  from: string; to: string; previousFrom: string; previousTo: string; findings: string[];
  branches: {
    code: string; name: string; orders: number; net: number; netPct: number | null; share: number; daysOpen: number; perDay: number; perDayPct: number | null;
    averageBill: number; averageBillPct: number | null; ordersPct: number | null; dineIn: number; takeaway: number; delivery: number; platform: number; platformPct: number;
    discounts: number; discountPct: number; refunds: number; voids: number; wastage: number; wastagePct: number; variance: number; busiestHour: number | null;
  }[];
  total: { orders: number; net: number; netPct: number | null; daysOpen: number; discounts: number; refunds: number; voids: number; wastage: number; variance: number; platform: number; averageBill: number };
  why: { branch: string; now: number; before: number; change: number; changePct: number | null; fromOrders: number; fromBill: number; ordersNow: number; ordersBefore: number;
    billNow: number; billBefore: number; discountPctNow: number; discountPctBefore: number; platformPctNow: number; platformPctBefore: number }[];
  gaps: { item: string; branch: string; shareHere: number; shareElsewhere: number; salesHere: number; gap: number }[];
};

const money = (n: number) => fmtIn(n, 2);
const pct = (n: number) => `${fmtIn(n, 1)}%`;
const vs = (p: number | null) => p === null ? "" : ` ${p >= 0 ? "▲" : "▼"} ${fmtIn(Math.abs(p), 1)}%`;
const day = (d: string) => new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

/** The report's tables (each branch a column, then why sales changed, then items selling less at a branch); the screen and exports use them. */
export function comparisonSections(c: Comparison): ExportTable[] {
  const b = c.branches;
  const row = (label: string, cell: (x: Comparison["branches"][number]) => string | number, total: string | number = "") => [label, ...b.map(cell), total];
  return [
    { title: "Branches side by side", subtitle: `against ${day(c.previousFrom)} to ${day(c.previousTo)}`, head: ["", ...b.map((x) => x.name), "Total"], rows: [
      row("Net sales", (x) => `${money(x.net)}${vs(x.netPct)}`, `${money(c.total.net)}${vs(c.total.netPct)}`),
      row("Share of sales", (x) => pct(x.share), "100%"),
      row("Days open", (x) => x.daysOpen, c.total.daysOpen),
      row("Net sales per day open", (x) => `${money(x.perDay)}${vs(x.perDayPct)}`, c.total.daysOpen ? money(c.total.net / c.total.daysOpen) : ""),
      row("Orders", (x) => `${x.orders}${vs(x.ordersPct)}`, c.total.orders),
      row("Average bill", (x) => `${money(x.averageBill)}${vs(x.averageBillPct)}`, money(c.total.averageBill)),
      row("Dine in / takeaway / own delivery", (x) => `${fmtIn(x.dineIn, 0)} / ${fmtIn(x.takeaway, 0)} / ${fmtIn(x.delivery, 0)} %`),
      row("Delivery platforms", (x) => `${money(x.platform)} (${pct(x.platformPct)})`, money(c.total.platform)),
      row("Discounts", (x) => `${money(x.discounts)} (${pct(x.discountPct)})`, money(c.total.discounts)),
      row("Refunds", (x) => money(x.refunds), money(c.total.refunds)),
      row("Voided orders", (x) => money(x.voids), money(c.total.voids)),
      row("Wastage", (x) => `${money(x.wastage)} (${pct(x.wastagePct)})`, money(c.total.wastage)),
      row("Cash variance", (x) => money(x.variance), money(c.total.variance)),
      row("Busiest hour", (x) => x.busiestHour === null ? "—" : `${String(x.busiestHour).padStart(2, "0")}:00`),
    ] },
    { title: "Why sales changed", head: ["Branch", "Before", "Now", "Change", "From number of orders", "From bill size", "Orders", "Average bill", "Discounts", "Platforms"], rows: c.why.map((w) => [
      w.branch, money(w.before), money(w.now), `${money(w.change)}${vs(w.changePct)}`, money(w.fromOrders), money(w.fromBill),
      `${w.ordersBefore} → ${w.ordersNow}`, `${money(w.billBefore)} → ${money(w.billNow)}`, `${pct(w.discountPctBefore)} → ${pct(w.discountPctNow)}`, `${pct(w.platformPctBefore)} → ${pct(w.platformPctNow)}`,
    ]) },
    { title: "Sells less here than at the other branches", head: ["Item", "Branch", "Share of sales here", "At the other branches", "Sales here", "Sales if like the others"], rows: c.gaps.map((g) => [
      g.item, g.branch, pct(g.shareHere), pct(g.shareElsewhere), money(g.salesHere), `+${money(g.gap)}`,
    ]) },
  ];
}

/** Findings first (plain sentences), then the tables. */
export function ComparisonView({ data, sections }: { data: Comparison; sections: ExportTable[] }) {
  return (
    <div className="space-y-5">
      {data.findings.length > 0 && (
        <section className="surface p-5" data-module="appr">
          <h2 className="mb-2 flex items-center gap-2 font-heading font-semibold"><LightbulbIcon className="size-4 text-primary" /> What stands out</h2>
          <ul className="list-disc space-y-1 pl-5 text-sm">{data.findings.map((f) => <li key={f}>{f}</li>)}</ul>
        </section>
      )}
      {data.branches.length < 2 && <p className="text-sm text-muted-foreground">Only {data.branches.length ? data.branches[0].name : "no branch"} sold in these days: the comparison needs two branches with sales.</p>}
      <SummaryView wide sections={sections.filter((s) => s.rows.length > 0)} />
      <p className="text-xs text-muted-foreground">Each figure is against the previous period of the same length ({day(data.previousFrom)} to {day(data.previousTo)}); choose whole weeks to compare the same weekdays. &ldquo;From number of orders&rdquo; is the change in orders at last period&apos;s average bill; &ldquo;From bill size&rdquo; is the rest.</p>
    </div>
  );
}
