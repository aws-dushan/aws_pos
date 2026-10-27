"use client";

import type { ExportTable } from "@/lib/export";
import { fmtIn } from "@/lib/num";
import { fmtQty } from "@/lib/pos";
import { cn } from "@/lib/utils";
import { TablePanel } from "@/components/kit";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

/** The Summary report (admin and finance): what /reports/summary returns. */
export type Summary = {
  sales: { orders: number; subtotal: number; discount: number; serviceCharge: number; vat: number; vatIncluded: boolean; billAmount: number; creditNotes: number; creditNoteCount: number; netSales: number };
  collection: { payments: { label: string; count: number; amount: number }[]; refunds: { label: string; count: number; amount: number }[]; net: number };
  tax: { rate: number; amount: number; vat: number }[];
  pos: { gross: number; deduction: number; net: number };
  cancelled: { bill: string; branch: string; amount: number; reason: string | null; by: string | null }[];
  voided: { code: string | null; name: string; qty: number; amount: number }[];
  categories: { category: string; qty: number; amount: number }[];
  bills: { cashier: string; bill: string; branch: string; amount: number }[];
  discounts: { bill: string; branch: string; reference: string; amount: number }[];
  expenses: { type: string; day: string; branch: string; account: string | null; who: string; amount: number; memo: string | null }[];
};

const money = (n: number) => fmtIn(n, 2);
const sum = <T,>(xs: T[], f: (x: T) => number) => xs.reduce((t, x) => t + f(x), 0);
const day = (d: string) => new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

/** The report's sections, in the order of the paper cash report; each ends with its total. The screen and every export use them. */
export function summarySections(s: Summary, many: boolean): ExportTable[] {
  const br = <T,>(x: T[]) => (many ? x : []);
  const sales: (string | number)[][] = [
    ["Sub-total", s.sales.orders, money(s.sales.subtotal)],
    ["Discount", "", money(-s.sales.discount)],
    ...(s.sales.serviceCharge ? [["Service charge", "", money(s.sales.serviceCharge)]] : []),
    [s.sales.vatIncluded ? "VAT (included in prices)" : "VAT", "", money(s.sales.vat)],
    ["Bill amount", "", money(s.sales.billAmount)],
    [`Credit notes`, s.sales.creditNoteCount, money(-s.sales.creditNotes)],
    ["Total, net sales", "", money(s.sales.netSales)],
  ];
  const collection: (string | number)[][] = [
    ...s.collection.payments.map((x) => [x.label, x.count, money(x.amount)]),
    ...s.collection.refunds.map((x) => [`Refund: ${x.label}`, x.count, money(-x.amount)]),
    ["Total, net collection", "", money(s.collection.net)],
  ];
  // Each cashier's bills, then their subtotal.
  const bills: (string | number)[][] = [];
  for (const name of [...new Set(s.bills.map((x) => x.cashier))]) {
    const mine = s.bills.filter((x) => x.cashier === name);
    bills.push(...mine.map((x) => [name, x.bill, ...br([x.branch]), money(x.amount)]));
    bills.push([`Total, ${name}`, `${mine.length} bills`, ...br([""]), money(sum(mine, (x) => x.amount))]);
  }
  bills.push(["Total", `${s.bills.length} bills`, ...br([""]), money(sum(s.bills, (x) => x.amount))]);
  return [
    { title: "Sales", head: ["Description", "Qty", "Amount"], rows: sales },
    { title: "Collection", head: ["Payment", "Count", "Amount"], rows: collection },
    { title: "Tax", head: ["VAT rate", "Amount before VAT", "VAT"], rows: [
      ...s.tax.map((x) => [`${fmtIn(x.rate, 2)}%`, money(x.amount), money(x.vat)]),
      ["Total", money(sum(s.tax, (x) => x.amount)), money(sum(s.tax, (x) => x.vat))]] },
    { title: "Gross to net", head: ["Gross sales", "Deduction", "Net sale"], rows: [[money(s.pos.gross), money(s.pos.deduction), money(s.pos.net)]] },
    { title: "Cancelled bills", head: ["Bill no", ...br(["Branch"]), "Reason", "By", "Amount"], rows: [
      ...s.cancelled.map((x) => [x.bill, ...br([x.branch]), x.reason ?? "—", x.by ?? "—", money(x.amount)]),
      ["Total", ...br([""]), `${s.cancelled.length} bills`, "", money(sum(s.cancelled, (x) => x.amount))]] },
    { title: "Voided items", head: ["Code", "Name", "Qty", "Amount"], rows: [
      ...s.voided.map((x) => [x.code ?? "—", x.name, fmtQty(x.qty), money(x.amount)]),
      ["Total", "", fmtQty(sum(s.voided, (x) => x.qty)), money(sum(s.voided, (x) => x.amount))]] },
    { title: "Discounts", head: ["Bill no", ...br(["Branch"]), "Reference", "Amount"], rows: [
      ...s.discounts.map((x) => [x.bill, ...br([x.branch]), x.reference, money(x.amount)]),
      ["Total", ...br([""]), `${s.discounts.length} bills`, money(sum(s.discounts, (x) => x.amount))]] },
    { title: "Category sales", head: ["Category", "Qty", "Amount"], rows: [
      ...s.categories.map((x) => [x.category, fmtQty(x.qty), money(x.amount)]),
      ["Total", fmtQty(sum(s.categories, (x) => x.qty)), money(sum(s.categories, (x) => x.amount))]] },
    { title: "Transactions", head: ["Cashier", "Bill no", ...br(["Branch"]), "Amount"], rows: bills },
    { title: "Expenses", head: ["Type", "Day", ...br(["Branch"]), "Account", "Person / item", "Memo", "Amount"], rows: [
      ...s.expenses.map((x) => [x.type, day(x.day), ...br([x.branch]), x.account ?? "—", x.who, x.memo ?? "—", money(x.amount)]),
      ["Total", "", ...br([""]), "", "", "", money(sum(s.expenses, (x) => x.amount))]] },
  ];
}

/** The sections on screen, two side by side where there is room; the money columns on the right, each total in bold. */
export function SummaryView({ sections, wide }: { sections: ExportTable[]; wide?: boolean }) {
  return (
    <div className="grid items-start gap-5 lg:grid-cols-2">
      {sections.map((t) => {
        const right = (i: number) => i > 0 && t.rows.every((r) => r[i] === "" || r[i] === "—" || typeof r[i] === "number" || /^-?[\d,]+(\.\d+)?%?$/.test(String(r[i])));
        return (
          <section key={t.title} className={cn("min-w-0", (wide || t.title === "Transactions" || t.title === "Expenses") && "lg:col-span-2")}>
            <h2 className="mb-2 font-heading font-semibold">{t.title}</h2>
            <TablePanel className="max-h-[60vh] overflow-auto [&_thead_th]:sticky [&_thead_th]:top-0 [&_thead_th]:z-10">
              <Table bare>
                <TableHeader><TableRow>
                  {t.head.map((h, i) => <TableHead key={h} className={cn(i === 0 && "pl-5", i === t.head.length - 1 && "pr-5", right(i) && "text-right")}>{h}</TableHead>)}
                </TableRow></TableHeader>
                <TableBody>
                  {t.rows.map((row, ri) => {
                    const total = String(row[0]).startsWith("Total");
                    return (
                      <TableRow key={ri} className={cn(total && "bg-muted/40 font-semibold")}>
                        {row.map((v, i) => (
                          <TableCell key={i} className={cn(i === 0 && "pl-5", i === row.length - 1 && "pr-5", right(i) ? "text-right tabular-nums" : !total && i > 0 && "text-muted-foreground")}>{v}</TableCell>
                        ))}
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </TablePanel>
          </section>
        );
      })}
    </div>
  );
}
