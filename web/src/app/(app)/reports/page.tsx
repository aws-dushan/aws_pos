"use client";

import { useMemo, useState } from "react";
import { BarChart3Icon, PrinterIcon, ReceiptIcon, RotateCcwIcon, ScaleIcon, UsersIcon, WalletIcon } from "lucide-react";
import { useApi } from "@/lib/api";
import { ExportMenu } from "@/components/export-menu";
import { ReceiptDialog } from "@/components/pos-payment";
import { SummaryView, summarySections, type Summary } from "@/components/summary-report";
import { dayReportLines, printReports, ReportDialog, SHIFT_STATUS, shiftReportLines, type DayReport, type ShiftReport, type ShiftStatus } from "@/components/shift";
import type { ReceiptLine } from "@/lib/device";
import { toast } from "sonner";
import { fmtIn } from "@/lib/num";
import { cn } from "@/lib/utils";
import { fmtQty, METHOD_LABEL, TYPE_LABEL, type OrderType, type PayMethod } from "@/lib/pos";
import { useSession } from "@/components/session";
import { BarChart, ErrorNote, LoadingRows, MeterBar, PageHeader, Segmented, StatTile, TablePanel } from "@/components/kit";
import { Stagger, StaggerItem } from "@/components/motion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

type Report = {
  from: string; to: string; branches: number;
  summary: { orders: number; gross: number; vat: number; net: number; netOfVat: number; discounts: number; serviceCharge: number; guests: number; refunds: number; creditNotes: number; averageOrder: number; voids: { count: number; value: number } };
  byDay: { day: string; orders: number; sales: number }[];
  byHour: { hour: number; orders: number; sales: number }[];
  amountRefunds: number;
  byItem: { name: string; category: string; qty: number; sales: number }[];
  byCategory: { category: string; qty: number; sales: number }[];
  byMethod: { method: PayMethod; taken: number; refunded: number; net: number; count: number }[];
  byCashier: { name: string; payments: number; taken: number; refunded: number; net: number }[];
  byDiscount: { name: string; kind: "promotion" | "cashier" | "typed" | "platform"; by: string; bills: number; amount: number }[];
  byType: { type: OrderType; orders: number; sales: number }[];
  byBranch: { code: string; name: string; orders: number; sales: number }[];
};
type Tab = "items" | "categories" | "days" | "methods" | "cashiers" | "invoices" | "finance" | "summary" | "closed" | "discounts" | "branches" | "exceptions" | "stock";
type Inv = {
  id: string; invoiceNo: string; businessDate: string; branch: string; at: string; orderType: OrderType; platform: string | null; platformRef: string | null;
  status: "paid" | "refunded" | "void"; cashier: string | null; till: string | null; items: number;
  gross: number; discount: number; vat: number; net: number; refunded: number; paidBy: string | null; facts: string | null; customer?: string | null;
};
type InvPay = { orderId: string; type: string; amount: number };
type ClosedDays = {
  days: { id: string; date: string; branch: string; closedAt: string | null; closedByName: string | null; reopened: number; z: DayReport | null }[];
  shifts: { id: string; date: string; branch: string; registerName: string; userName: string; openedAt: string; closedAt: string | null; status: ShiftStatus; openingFloat: number;
    expectedCash: number | null; countedCash: number | null; variance: number | null; approvedByName: string | null; sales: number; z: ShiftReport | null }[];
};
type InvKind = "all" | "notPosted";
const FACTS_LABEL: Record<string, string> = { posted: "Posted", pending: "Waiting", waiting: "Waiting", failed: "Failed", skipped: "Skipped" };
const invStatus = (x: Inv) => x.status === "void" ? "Void" : x.status === "refunded" ? "Refunded" : x.refunded > 0 ? "Part refunded" : "Paid";
type StockKind = "all" | "out" | "negative" | "noPlatform";
type StockRep = {
  platforms: { id: string; name: string }[];
  items: { id: string; code: string | null; name: string; category: string; factsItem: boolean; madeToOrder: boolean; stock: number | null; stockAt: string | null; price: number | null; platforms: Record<string, number | null> }[];
};
type ExKind = "discounts" | "voids" | "lineVoids" | "refunds" | "noSales";
type Exc = {
  discounts: { number: number | null; businessDate: string; branch: string; pct: number; what: string | null; amount: number; total: number; by: string | null; approvedBy: string | null }[];
  voids: { number: number | null; businessDate: string; branch: string; total: number; reason: string | null; by: string | null }[];
  lineVoids: { at: string; branch: string; what: string | null; reason: string | null; by: string | null }[];
  refunds: { number: string; orderNumber: number | null; businessDate: string; branch: string; total: number; method: PayMethod; reason: string; by: string | null; approvedBy: string | null }[];
  noSales: { at: string; businessDate: string; branch: string; register: string | null; reason: string; by: string | null }[];
  totals: { discounts: { count: number; value: number }; voids: { count: number; value: number }; lineVoids: { count: number }; refunds: { count: number; value: number }; noSales: { count: number } };
};
const time = (s: string) => new Date(s).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

const money = (n: number) => fmtIn(n, 2);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const shortDay = (d: string) => new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

/** Sales reports (REQ RPT-02 … RPT-06): a range of business days for this branch or all of mine; every table exports to Excel, CSV or PDF. Exceptions (RPT-03): discounts, voids, refunds, no-sales. */
export default function ReportsPage() {
  const { company, branch, can } = useSession();
  const finance = can("facts.post");
  const cur = company?.currency ?? "AED";
  const today = iso(new Date());
  const [from, setFrom] = useState(() => { const d = new Date(); d.setDate(d.getDate() - 6); return iso(d); });
  const [to, setTo] = useState(today);
  const [where, setWhere] = useState<"branch" | "all">("branch");
  const [tab, setTab] = useState<Tab>("items");
  const r = useApi<Report>(`/reports/sales?from=${from}&to=${to}${where === "all" ? "&branches=all" : ""}`);
  const [exKind, setExKind] = useState<ExKind>("discounts");
  const ex = useApi<Exc>(tab === "exceptions" ? `/reports/exceptions?from=${from}&to=${to}${where === "all" ? "&branches=all" : ""}` : null);
  const [stockKind, setStockKind] = useState<StockKind>("all");
  const st = useApi<StockRep>(tab === "stock" ? "/reports/stock" : null);
  const invTab = tab === "invoices" || tab === "finance";
  const summary = useApi<Summary>(tab === "summary" ? `/reports/summary?from=${from}&to=${to}${where === "all" ? "&branches=all" : ""}` : null);
  const sections = useMemo(() => summary.data ? summarySections(summary.data, where === "all") : null, [summary.data, where]);
  const inv = useApi<{ invoices: Inv[]; payments: InvPay[] | null }>(invTab ? `/reports/invoices?from=${from}&to=${to}${where === "all" ? "&branches=all" : ""}${tab === "finance" ? "&finance=true" : ""}` : null);
  const [invKind, setInvKind] = useState<InvKind>("all");
  const [invQ, setInvQ] = useState("");
  const [receipt, setReceipt] = useState<string | null>(null);
  // Closed days (admin and finance): the days or their shifts, each with its kept Z report.
  const [dayKind, setDayKind] = useState<"days" | "shifts">("days");
  const cd = useApi<ClosedDays>(tab === "closed" ? `/reports/days?from=${from}&to=${to}${where === "all" ? "&branches=all" : ""}` : null);
  const [zLines, setZLines] = useState<ReceiptLine[] | null>(null);
  const zTitle = (code: string) => `${company?.name ?? ""} · ${code}`;
  const zOf = (i: number): ReceiptLine[] | null => {
    if (dayKind === "days") { const x = cd.data?.days[i]; return x?.z ? dayReportLines({ ...x.z, status: "closed" }, zTitle(x.branch)) : null; }
    const x = cd.data?.shifts[i];
    return x?.z ? shiftReportLines({ ...x.z, kind: "Z" }, zTitle(x.branch)) : null;
  };
  // The bills shown: not yet in FACTS (waiting or failed; voids never go), and the search on number, cashier, platform order or method.
  const invRows = useMemo(() => {
    const q = invQ.trim().toLowerCase();
    return (inv.data?.invoices ?? []).filter((x) => (invKind === "all" || (x.status !== "void" && x.facts !== "posted" && x.facts !== "skipped" && x.facts !== null))
      && (!q || [x.invoiceNo, x.cashier, x.platformRef, x.paidBy, x.platform, x.customer].some((v) => v?.toLowerCase().includes(q))));
  }, [inv.data, invKind, invQ]);
  // Finance invoices: a row per payment, so a bill paid two ways is two rows (a bill with no payment, e.g. a void, is one row).
  const finRows = useMemo(() => {
    const by = new Map<string, InvPay[]>();
    for (const p of inv.data?.payments ?? []) by.set(p.orderId, [...(by.get(p.orderId) ?? []), p]);
    return invRows.flatMap((x) => { const ps = by.get(x.id); return ps?.length ? ps.map((p) => ({ x, p: p as InvPay | null })) : [{ x, p: null }]; });
  }, [inv.data, invRows]);
  const stockMatch = useMemo(() => {
    const s = st.data;
    const noPlatform = (x: StockRep["items"][number]) => !!s?.platforms.length && s.platforms.every((p) => x.platforms[p.id] == null);
    const is: Record<StockKind, (x: StockRep["items"][number]) => boolean> = {
      all: () => true, out: (x) => x.stock === 0, negative: (x) => x.stock !== null && x.stock < 0, noPlatform,
    };
    return is;
  }, [st.data]);
  const d = r.data;
  const label = tab === "stock" ? `${branch?.code}-${today}` : `${where === "all" ? company?.code : branch?.code}-${from}-to-${to}`;

  function preset(days: number) { const e = new Date(); const s = new Date(); s.setDate(s.getDate() - (days - 1)); setFrom(iso(s)); setTo(iso(e)); }
  function monthToDate() { const e = new Date(); setFrom(iso(new Date(e.getFullYear(), e.getMonth(), 1))); setTo(iso(e)); }

  const table = useMemo(() => {
    if (!d) return null;
    const total = d.summary.net || 1;
    switch (tab) {
      case "items": {
        const rows: (string | number)[][] = d.byItem.map((x) => [x.name, x.category, fmtQty(x.qty), money(x.sales), `${(x.sales / total * 100).toFixed(1)}%`]);
        const share = d.byItem.map((x) => x.sales / total);
        if (Math.abs(d.amountRefunds) >= 0.01) { rows.push(["Refunds of an amount, not of items", "—", "", money(d.amountRefunds), ""]); share.push(0); }
        return { head: ["Item", "Category", "Qty", "Sales", "Share"], rows, share };
      }
      case "categories": return { head: ["Category", "Qty", "Sales", "Share"], rows: d.byCategory.map((x) => [x.category, fmtQty(x.qty), money(x.sales), `${(x.sales / total * 100).toFixed(1)}%`]), share: d.byCategory.map((x) => x.sales / total) };
      case "days": return { head: ["Day", "Orders", "Sales", "Average"], rows: d.byDay.map((x) => [shortDay(x.day), x.orders, money(x.sales), money(x.orders ? x.sales / x.orders : 0)]), share: null };
      case "methods": return { head: ["Method", "Payments", "Taken", "Refunded", "Net"], rows: d.byMethod.map((x) => [METHOD_LABEL[x.method] ?? x.method, x.count, money(x.taken), money(x.refunded), money(x.net)]), share: null };
      case "cashiers": return { head: ["Cashier", "Payments", "Taken", "Refunded", "Net"], rows: d.byCashier.map((x) => [x.name, x.payments, money(x.taken), money(x.refunded), money(x.net)]), share: null };
      case "invoices": {
        if (!inv.data) return { head: [], rows: [], share: null };
        const many = where === "all";
        return {
          head: ["Invoice no", ...(many ? ["Branch"] : []), "Date & time", "Type", "Platform order", "Cashier", "Till", "Items", "Gross", "Discount", "VAT", "Net", "Refunded", "Paid by", "Status", "FACTS"],
          share: null, ids: invRows.map((x) => x.id),
          rows: invRows.map((x) => [x.invoiceNo, ...(many ? [x.branch] : []), time(x.at), x.platform ?? TYPE_LABEL[x.orderType], x.platformRef ?? "—", x.cashier ?? "—", x.till ?? "—",
            fmtQty(x.items), money(x.gross), money(x.discount), money(x.vat), money(x.net), money(x.refunded), x.paidBy ?? "—", invStatus(x), x.facts ? FACTS_LABEL[x.facts] ?? x.facts : "—"]),
        };
      }
      case "closed": {
        const c = cd.data;
        if (!c) return { head: [], rows: [], share: null };
        const many = where === "all";
        const m = (n: number | null | undefined) => n == null ? "—" : money(n);
        if (dayKind === "days") return {
          head: ["Day", ...(many ? ["Branch"] : []), "Closed", "Orders", "Net sales", "Float", "Expected", "Counted", "Variance"], share: null,
          rows: c.days.map((x) => [`${shortDay(x.date)}${x.reopened ? ` (reopened ${x.reopened}×)` : ""}`, ...(many ? [x.branch] : []), `${x.closedAt ? time(x.closedAt) : "—"} · ${x.closedByName ?? "automatically"}`,
            x.z?.sales.orders ?? "—", m(x.z?.netSales), m(x.z?.cash?.openingFloat), m(x.z?.cash?.expected), m(x.z?.cash?.counted), m(x.z?.variance)]),
        };
        return {
          head: ["Day", ...(many ? ["Branch"] : []), "Till", "Cashier", "Opened", "Closed", "Sales", "Float", "Cash expected", "Counted", "Variance", "Status"], share: null,
          rows: c.shifts.map((x) => [shortDay(x.date), ...(many ? [x.branch] : []), x.registerName, x.userName, time(x.openedAt), x.closedAt ? time(x.closedAt) : "—",
            money(x.sales), money(x.openingFloat), m(x.expectedCash), m(x.countedCash), m(x.variance), `${SHIFT_STATUS[x.status]}${x.approvedByName ? ` (approved by ${x.approvedByName})` : ""}`]),
        };
      }
      case "finance": {
        if (!inv.data) return { head: [], rows: [], share: null };
        const many = where === "all";
        return {
          head: ["Invoice no", ...(many ? ["Branch"] : []), "Date & time", "Type", "Platform order", "Customer", "Cashier", "Till", "Items", "Gross", "Discount", "VAT", "Net", "Refunded", "Paid amount", "Payment type", "Status", "FACTS"],
          share: null, ids: finRows.map((r) => r.x.id),
          rows: finRows.map(({ x, p }) => [x.invoiceNo, ...(many ? [x.branch] : []), time(x.at), x.platform ?? TYPE_LABEL[x.orderType], x.platformRef ?? "—", x.customer ?? "—", x.cashier ?? "—", x.till ?? "—",
            fmtQty(x.items), money(x.gross), money(x.discount), money(x.vat), money(x.net), money(x.refunded), p ? money(p.amount) : "—", p?.type ?? "—", invStatus(x), x.facts ? FACTS_LABEL[x.facts] ?? x.facts : "—"]),
        };
      }
      case "discounts": {
        const all = d.byDiscount.reduce((t, x) => t + x.amount, 0) || 1;
        const kind = { promotion: "Promotion", cashier: "Cashier discount", typed: "Typed", platform: "Platform offer" };
        return { head: ["Discount", "Kind", "Given by", "Bills", "Amount"], rows: d.byDiscount.map((x) => [x.name, kind[x.kind] ?? x.kind, x.by, x.bills, money(x.amount)]), share: d.byDiscount.map((x) => x.amount / all) };
      }
      case "branches": return { head: ["Branch", "Orders", "Sales", "Share"], rows: d.byBranch.map((x) => [`${x.code} · ${x.name}`, x.orders, money(x.sales), `${(x.sales / total * 100).toFixed(1)}%`]), share: d.byBranch.map((x) => x.sales / total) };
      case "stock": {
        const s = st.data;
        if (!s) return { head: [], rows: [], share: null };
        const price = (n: number | null) => n == null ? "" : money(n);
        return {
          head: ["Item", "Code", "Category", "Stock", "Outlet price", ...s.platforms.map((p) => p.name)], share: null,
          rows: s.items.filter(stockMatch[stockKind]).map((x) => [x.name, x.code ?? "—", x.category,
            x.madeToOrder ? "Made to order" : x.stock == null ? "—" : fmtQty(x.stock), price(x.price), ...s.platforms.map((p) => price(x.platforms[p.id]))]),
        };
      }
      case "exceptions": {
        const e = ex.data;
        if (!e) return { head: [], rows: [], share: null };
        const who = (by: string | null, ap?: string | null) => `${by ?? "—"}${ap ? ` (approved by ${ap})` : ""}`;
        switch (exKind) {
          case "discounts": return { head: ["Order", "Day", "Branch", "Discount", "Amount", "Paid", "By"], share: null,
            rows: e.discounts.map((x) => [`#${x.number}`, shortDay(x.businessDate), x.branch, x.what ?? `${x.pct}%`, money(x.amount), money(x.total), who(x.by, x.approvedBy)]) };
          case "voids": return { head: ["Order", "Day", "Branch", "Value", "Reason", "By"], share: null,
            rows: e.voids.map((x) => [`#${x.number}`, shortDay(x.businessDate), x.branch, money(x.total), x.reason ?? "—", x.by ?? "—"]) };
          case "lineVoids": return { head: ["When", "Branch", "What", "Reason", "By"], share: null,
            rows: e.lineVoids.map((x) => [time(x.at), x.branch, x.what ?? "—", x.reason ?? "—", x.by ?? "—"]) };
          case "refunds": return { head: ["Credit note", "Order", "Day", "Branch", "Method", "Reason", "By", "Amount"], share: null,
            rows: e.refunds.map((x) => [x.number, x.orderNumber ? `#${x.orderNumber}` : "—", shortDay(x.businessDate), x.branch, METHOD_LABEL[x.method] ?? x.method, x.reason, who(x.by, x.approvedBy), money(x.total)]) };
          case "noSales": return { head: ["When", "Branch", "Till", "By", "Reason"], share: null,
            rows: e.noSales.map((x) => [time(x.at), x.branch, x.register ?? "Back office", x.by ?? "—", x.reason]) };
        }
      }
    }
  }, [d, tab, ex.data, exKind, st.data, stockKind, stockMatch, inv.data, invRows, finRows, where, cd.data, dayKind]);
  const titles: Record<Tab, string> = { items: "Sales by item", categories: "Sales by category", days: "Sales by day", methods: "Payments by method", cashiers: "Payments by cashier", invoices: "Invoices", finance: "Finance invoices", summary: "Summary", closed: "Closed days", discounts: "Discounts given", branches: "Sales by branch", exceptions: "Exceptions", stock: "Stock" };
  const stockTitles: Record<StockKind, string> = { all: "All items", out: "Out of stock", negative: "Negative stock", noPlatform: "No platform price" };
  const exTitles: Record<ExKind, string> = { discounts: "Discounts", voids: "Voided orders", lineVoids: "Voided items", refunds: "Refunds", noSales: "No-sales" };
  // Which columns hold figures (right-aligned): for sales tables all but the names; for exceptions, the ones that are numbers.
  const isNum = (v: string | number) => typeof v === "number" || /^[#-]?[\d,]+(\.\d+)?%?$/.test(v);
  const listTab = tab === "exceptions" || invTab || tab === "closed";
  const numCol = (i: number) => listTab ? !!table?.rows.length && table.rows.every((r) => isNum(r[i]) || r[i] === "—") : i >= (tab === "items" ? 2 : tab === "stock" ? 3 : 1);
  const exportTable = table ? {
    title: `${titles[tab]}${tab === "exceptions" ? ` · ${exTitles[exKind]}` : tab === "stock" && stockKind !== "all" ? ` · ${stockTitles[stockKind]}` : ""}`,
    subtitle: tab === "stock"
      ? `${company?.name ?? ""} · ${branch?.name ?? ""} · stock now, ${new Date().toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}`
      : `${where === "all" ? company?.name ?? "" : `${company?.name ?? ""} · ${branch?.name ?? ""}`} · ${from} to ${to}`,
    head: table.head, rows: table.rows,
  } : null;

  return (
    <div className="pb-8">
      <PageHeader title="Reports" icon={BarChart3Icon} module="bank"
        description={`Sales for ${where === "all" ? `every branch of ${company?.name ?? "the company"}` : branch?.name ?? "this branch"}, by business day. Net sales are after credit notes.`}
        actions={<Segmented id="rep-where" value={where} onChange={setWhere} options={[{ value: "branch", label: "This branch" }, { value: "all", label: "All my branches" }]} />} />

      <div className="mb-5 flex flex-wrap items-end gap-3">
        <label className="grid gap-1 text-xs font-medium text-muted-foreground">From<Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className="h-10 w-40" /></label>
        <label className="grid gap-1 text-xs font-medium text-muted-foreground">To<Input type="date" value={to} min={from} max={today} onChange={(e) => setTo(e.target.value)} className="h-10 w-40" /></label>
        <div className="flex gap-1.5">
          <Button variant="outline" className="h-10" onClick={() => preset(1)}>Today</Button>
          <Button variant="outline" className="h-10" onClick={() => preset(7)}>7 days</Button>
          <Button variant="outline" className="h-10" onClick={() => preset(30)}>30 days</Button>
          <Button variant="outline" className="h-10" onClick={monthToDate}>This month</Button>
        </div>
      </div>
      <ErrorNote message={r.error} />

      {!d ? <LoadingRows /> : (
        <Stagger className="space-y-5">
          <StaggerItem>
            <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-4">
              <StatTile module="fin" icon={ReceiptIcon} label="Net sales" value={`${cur} ${money(d.summary.net)}`} hint={`${d.summary.orders} orders · average ${money(d.summary.averageOrder)}`} />
              <StatTile module="bank" icon={WalletIcon} label="Net of VAT" value={`${cur} ${money(d.summary.netOfVat)}`} hint={`VAT ${money(d.summary.vat)}`} />
              <StatTile module="appr" icon={RotateCcwIcon} label="Refunds" value={`${cur} ${money(d.summary.refunds)}`} hint={`${d.summary.creditNotes} credit notes · ${d.summary.voids.count} voided orders`} tone={d.summary.refunds > 0 ? "warn" : "default"} />
              <StatTile module="sales" icon={UsersIcon} label="Discounts given" value={`${cur} ${money(d.summary.discounts)}`} hint={`${d.summary.guests} guests${d.summary.serviceCharge ? ` · service charge ${money(d.summary.serviceCharge)}` : ""}`} />
            </div>
          </StaggerItem>

          <StaggerItem>
            <div className="grid gap-5 md:grid-cols-[2fr_1fr]">
              <section className="surface p-5" data-module="fin">
                <h2 className="mb-3 font-heading font-semibold">{d.byDay.length > 1 ? "Net sales by day" : "Sales by hour"}</h2>
                {d.byDay.length > 1
                  ? <BarChart values={d.byDay.map((x) => x.sales)} labels={d.byDay.map((x) => shortDay(x.day))} format={(n) => `${cur} ${money(n)}`} height={160} emptyNote="No sales in these days" />
                  : <BarChart values={d.byHour.map((x) => x.sales)} labels={d.byHour.map((x) => `${String(x.hour).padStart(2, "0")}:00`)} format={(n) => `${cur} ${money(n)}`} height={160} emptyNote="No sales on this day" />}
              </section>
              <section className="surface p-5" data-module="bank">
                <h2 className="mb-3 font-heading font-semibold">By order type</h2>
                <div className="space-y-3">
                  {d.byType.length ? d.byType.map((x) => (
                    <MeterBar key={x.type} value={x.sales} max={d.summary.net || 1}
                      label={<span className="flex justify-between"><span>{TYPE_LABEL[x.type]} · {x.orders}</span><span className="tabular-nums">{money(x.sales)}</span></span>} />
                  )) : <p className="text-sm text-muted-foreground">No sales yet.</p>}
                </div>
                {d.byHour.length > 0 && d.byDay.length > 1 && (
                  <div className="mt-5 border-t pt-4 text-sm">
                    <div className="text-xs text-muted-foreground">Busiest hour</div>
                    {(() => { const b = [...d.byHour].sort((a, z) => z.sales - a.sales)[0]; return <div className="font-medium">{String(b.hour).padStart(2, "0")}:00 · {cur} {money(b.sales)} · {b.orders} orders</div>; })()}
                  </div>
                )}
              </section>
            </div>
          </StaggerItem>

          <StaggerItem>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
              <Segmented id="rep-tab" value={tab} onChange={setTab} options={[
                { value: "items", label: "Items" }, { value: "categories", label: "Categories" }, { value: "days", label: "Days" },
                { value: "methods", label: "Payment methods" }, { value: "cashiers", label: "Cashiers" }, { value: "invoices", label: "Invoices" },
                ...(finance ? [{ value: "finance" as const, label: "Finance invoices" }, { value: "summary" as const, label: "Summary" }, { value: "closed" as const, label: "Closed days" }] : []),
                { value: "discounts", label: "Discounts" },
                ...(where === "all" ? [{ value: "branches" as const, label: "Branches" }] : []),
                { value: "exceptions", label: "Exceptions" },
                { value: "stock", label: "Stock" },
              ]} />
              {tab === "summary"
                ? <ExportMenu name={`summary-${label}`} tables={sections} heading={{ title: "Summary", subtitle: `${where === "all" ? company?.name ?? "" : `${company?.name ?? ""} · ${branch?.name ?? ""}`} · ${from} to ${to}` }} />
                : <ExportMenu name={`${tab === "exceptions" ? exKind : tab}-${label}`} table={exportTable} />}
            </div>
            {tab === "stock" && (
              <div className="mb-3 flex flex-wrap items-center gap-3">
                <Segmented id="stock-kind" size="sm" value={stockKind} onChange={setStockKind} options={(Object.keys(stockTitles) as StockKind[]).map((k) => (
                  { value: k, label: `${stockTitles[k]}${st.data ? ` · ${st.data.items.filter(stockMatch[k]).length}` : ""}` }))} />
                <span className="text-sm text-muted-foreground">{branch?.name}, now: FACTS stock less what was sold and thrown away since. A blank price means FACTS has none, so it can&apos;t be sold there.</span>
              </div>
            )}
            {tab === "closed" && (
              <div className="mb-3 flex flex-wrap items-center gap-3">
                <Segmented id="days-kind" size="sm" value={dayKind} onChange={setDayKind} options={[
                  { value: "days", label: `Days${cd.data ? ` · ${cd.data.days.length}` : ""}` }, { value: "shifts", label: `Shifts${cd.data ? ` · ${cd.data.shifts.length}` : ""}` }]} />
                {cd.data && (() => {
                  const ds = cd.data.days;
                  return <span className="text-sm text-muted-foreground">Net sales {cur} {money(ds.reduce((t, x) => t + (x.z?.netSales ?? 0), 0))} · variance {money(ds.reduce((t, x) => t + (x.z?.variance ?? 0), 0))} · click a row for its Z report</span>;
                })()}
                <Button variant="outline" size="sm" className="ml-auto" disabled={!table?.rows.length}
                  onClick={() => {
                    const all = (table?.rows ?? []).map((_, i) => zOf(i)).filter((x): x is ReceiptLine[] => !!x);
                    if (!all.length) toast.error("No Z reports kept for these.");
                    else if (!printReports([...all].reverse(), `Z reports ${from} to ${to}`)) toast.error("Allow pop-ups for One POS to print or save as PDF.");
                  }}><PrinterIcon /> Print all Z reports</Button>
              </div>
            )}
            {invTab && (
              <div className="mb-3 flex flex-wrap items-center gap-3">
                <Segmented id="inv-kind" size="sm" value={invKind} onChange={setInvKind} options={[{ value: "all", label: "All bills" }, { value: "notPosted", label: "Not in FACTS yet" }]} />
                <Input type="search" value={invQ} onChange={(e) => setInvQ(e.target.value)} placeholder={tab === "finance" ? "Invoice no, customer, cashier, platform order or method" : "Invoice no, cashier, platform order or method"} className="h-9 w-72" />
                {inv.data && (() => {
                  const sold = invRows.filter((x) => x.status !== "void");
                  const sum = (k: "net" | "vat" | "discount" | "refunded") => money(sold.reduce((t, x) => t + x[k], 0));
                  const paid = tab === "finance" ? ` · paid ${money(finRows.reduce((t, r) => t + (r.p?.amount ?? 0), 0))} in ${finRows.filter((r) => r.p).length} payments` : "";
                  return <span className="text-sm text-muted-foreground">{sold.length} bills · net {cur} {sum("net")} · VAT {sum("vat")} · discount {sum("discount")} · refunded {sum("refunded")}{paid}</span>;
                })()}
              </div>
            )}
            <ErrorNote message={tab === "stock" ? st.error : invTab ? inv.error : tab === "summary" ? summary.error : tab === "closed" ? cd.error : undefined} />
            {tab === "exceptions" && (
              <div className="mb-3 flex flex-wrap items-center gap-3">
                <Segmented id="ex-kind" size="sm" value={exKind} onChange={setExKind} options={(Object.keys(exTitles) as ExKind[]).map((k) => {
                  const t = ex.data?.totals[k];
                  return { value: k, label: `${exTitles[k]}${t ? ` · ${t.count}` : ""}` };
                })} />
                {ex.data && exKind !== "lineVoids" && exKind !== "noSales" && (
                  <span className="text-sm text-muted-foreground">{cur} {money((ex.data.totals[exKind] as { value: number }).value)} in total</span>
                )}
              </div>
            )}
            {tab === "summary" ? (sections ? <SummaryView sections={sections} /> : !summary.error && <LoadingRows />) : table?.rows.length ? (
              // Scrolls inside its own box (both ways), so the sideways scrollbar is always on screen; headings and the first column stay put.
              <TablePanel className="max-h-[70vh] overflow-auto [&_thead_th]:sticky [&_thead_th]:top-0 [&_thead_th]:z-10 [&_tbody_td:first-child]:sticky [&_tbody_td:first-child]:left-0 [&_tbody_td:first-child]:bg-card [&_thead_th:first-child]:left-0 [&_thead_th:first-child]:z-20">
                <Table bare>
                  <TableHeader><TableRow>
                    {table.head.map((h, i) => <TableHead key={h} className={i === 0 ? "pl-5" : i === table.head.length - 1 ? cn("pr-5", (!listTab || numCol(i)) && "text-right") : numCol(i) ? "text-right" : ""}>{h}</TableHead>)}
                  </TableRow></TableHeader>
                  <TableBody>
                    {table.rows.slice(0, 200).map((row, ri) => (
                      <TableRow key={ri} className={table.ids || tab === "closed" ? "cursor-pointer" : undefined}
                        onClick={tab === "closed" ? () => { const z = zOf(ri); if (z) setZLines(z); else toast.error("No Z report was kept for this."); } : table.ids ? () => setReceipt(table.ids![ri]) : undefined}>
                        {row.map((v, i) => (
                          <TableCell key={i} className={i === 0 ? "pl-5 font-medium" : i === row.length - 1 ? cn("pr-5", (!listTab || numCol(i)) && "text-right tabular-nums") : numCol(i) ? "text-right tabular-nums" : "text-muted-foreground"}>
                            {i === row.length - 1 && table.share ? (
                              <span className="inline-flex items-center gap-2"><span className="inline-block h-1.5 w-16 overflow-hidden rounded-full bg-muted"><span className="block h-full rounded-full bg-primary" style={{ width: `${Math.min(100, table.share[ri] * 100)}%` }} /></span>{v}</span>
                            ) : v}
                          </TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TablePanel>
            ) : (tab === "stock" && !st.data) || (invTab && !inv.data && !inv.error) || (tab === "closed" && !cd.data && !cd.error) ? <LoadingRows /> : <p className="surface px-5 py-8 text-center text-sm text-muted-foreground">{tab === "stock" ? "No items here." : "Nothing in these days."}</p>}
            {tab !== "summary" && table && table.rows.length > 200 && <p className="mt-2 text-xs text-muted-foreground">Showing 200 of {table.rows.length}; the export has them all.</p>}
          </StaggerItem>

          <ReceiptDialog orderId={receipt} onClose={() => setReceipt(null)} />
          <ReportDialog lines={zLines} onClose={() => setZLines(null)} />
          <StaggerItem>
            <p className="flex items-center gap-2 text-xs text-muted-foreground"><ScaleIcon className="size-3.5" /> Item sales are each line&apos;s share of what its order was paid (discounts and service charge spread), less items that came back. Payment methods and cashiers count money on the day it changed hands, so they can differ from sales when an order is paid on a later day.</p>
          </StaggerItem>
        </Stagger>
      )}
    </div>
  );
}
