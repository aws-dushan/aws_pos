"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { PrinterIcon } from "lucide-react";

/*
 * Blank order pads for outages (REQ ONL-04): numbered slips, four to an A4 page, printed ahead of time. Staff write the items,
 * total and payment on them; a manager keys each in under Paper sales once One POS is reachable again.
 */
export default function PadPage() {
  return <Suspense><Pads /></Suspense>;
}

function Pads() {
  const p = useSearchParams();
  const from = Math.max(1, Number(p.get("from")) || 1);
  const count = Math.min(200, Math.max(1, Number(p.get("count")) || 20));
  const company = p.get("company") ?? "";
  const branch = p.get("branch") ?? "";
  const code = p.get("code") ?? "";
  const numbers = Array.from({ length: count }, (_, i) => String(from + i).padStart(4, "0"));
  const pages = Array.from({ length: Math.ceil(count / 4) }, (_, i) => numbers.slice(i * 4, i * 4 + 4));

  return (
    <div className="min-h-screen bg-neutral-100 text-black print:bg-white">
      <style>{`@page { size: A4; margin: 8mm; } @media print { .no-print { display: none !important } .sheet { box-shadow: none !important; margin: 0 !important; break-after: page; } }`}</style>
      <div className="no-print sticky top-0 z-10 flex items-center justify-between gap-3 border-b bg-white px-6 py-3">
        <div className="text-sm"><b>{count} order slips</b> · {numbers[0]} to {numbers[numbers.length - 1]} · {company} {branch}</div>
        <button type="button" onClick={() => window.print()} className="inline-flex h-10 items-center gap-2 rounded-lg bg-black px-4 text-sm font-medium text-white">
          <PrinterIcon className="size-4" /> Print
        </button>
      </div>
      {pages.map((slips, i) => (
        <div key={i} className="sheet mx-auto my-6 grid h-[281mm] w-[194mm] grid-cols-2 grid-rows-2 bg-white shadow-lg">
          {slips.map((n) => <Slip key={n} no={n} company={company} branch={branch} code={code} />)}
        </div>
      ))}
    </div>
  );
}

function Slip({ no, company, branch, code }: { no: string; company: string; branch: string; code: string }) {
  const box = <span className="inline-block size-3 border border-black align-middle" />;
  return (
    <div className="flex min-h-0 flex-col overflow-hidden border border-dashed border-neutral-400 p-[4mm] font-sans text-[8.5pt] leading-tight">
      <div className="flex items-start justify-between">
        <div>
          <div className="text-[10pt] font-bold">{company}</div>
          <div className="text-neutral-600">{branch}</div>
          <div className="text-[7.5pt] text-neutral-500">Paper order · system offline</div>
        </div>
        <div className="text-right">
          <div className="text-neutral-600">Slip</div>
          <div className="font-mono text-[12pt] font-bold whitespace-nowrap">{code ? `${code}-` : ""}{no}</div>
        </div>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5">
        <div className="whitespace-nowrap">Date ___/___/______</div>
        <div className="whitespace-nowrap text-right">Time ___:___</div>
        <div className="col-span-2 flex flex-wrap gap-x-3 whitespace-nowrap">{box} Dine-in, table ____ {box} Takeaway {box} Delivery</div>
      </div>
      <table className="mt-2 w-full border-collapse">
        <thead>
          <tr className="text-left">
            <th className="w-[12%] border border-black px-1 py-0.5">Qty</th>
            <th className="border border-black px-1 py-0.5">Item</th>
            <th className="w-[17%] border border-black px-1 py-0.5 text-right">Price</th>
            <th className="w-[19%] border border-black px-1 py-0.5 text-right">Amount</th>
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: 12 }, (_, i) => (
            <tr key={i} className="h-[6mm]"><td className="border border-black" /><td className="border border-black" /><td className="border border-black" /><td className="border border-black" /></tr>
          ))}
        </tbody>
      </table>
      <div className="mt-2 grid grid-cols-2 gap-y-1.5">
        <div className="whitespace-nowrap">Discount ____ %</div>
        <div className="whitespace-nowrap text-right font-bold">TOTAL ____________</div>
        <div className="col-span-2 flex flex-wrap gap-x-3 whitespace-nowrap">Paid: {box} Cash {box} Card, ref ________ {box} Other</div>
        <div className="col-span-2 whitespace-nowrap">Cashier ______________ Sign ____________</div>
      </div>
      <div className="mt-auto pt-1 text-[7pt] text-neutral-500">Prices include VAT. A tax invoice is issued when this slip is entered in One POS.</div>
    </div>
  );
}
