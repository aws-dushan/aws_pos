/*
 * Report exports (REQ RPT-06): a table as CSV, as an Excel workbook (.xlsx, built in the browser; the library loads only when
 * someone exports), or as a print-ready page the browser saves as PDF.
 */

export type ExportTable = { title: string; subtitle?: string; head: string[]; rows: (string | number)[][] };

const fileName = (s: string) => s.replace(/[^\w.-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");

function save(blob: Blob, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  window.setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

export function downloadCsv(name: string, t: ExportTable | ExportTable[]) {
  const esc = (v: string | number) => { const s = String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  // Several tables: one under the other, each after its title (and a blank line between).
  const all = Array.isArray(t) ? t.flatMap((x, i) => [...(i ? [[]] : []), [x.title], x.head, ...x.rows]) : [t.head, ...t.rows];
  save(new Blob(["﻿" + all.map((r) => r.map(esc).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" }), `${fileName(name)}.csv`);
}

/** Numbers formatted for the screen ("1,234.50") go into Excel as numbers, so they add up there. */
const asNumber = (v: string | number) => {
  if (typeof v === "number") return v;
  const s = v.replace(/,/g, "").trim();
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : v;
};

export async function downloadXlsx(name: string, t: ExportTable | ExportTable[]) {
  const { Workbook } = await import("exceljs");
  const wb = new Workbook();
  wb.creator = "One POS";
  // Several tables (the Summary report): a sheet each.
  for (const x of Array.isArray(t) ? t : [t]) addSheet(wb, x);
  const buf = await wb.xlsx.writeBuffer();
  save(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), `${fileName(name)}.xlsx`);
}

function addSheet(wb: import("exceljs").Workbook, t: ExportTable) {
  const ws = wb.addWorksheet(t.title.replace(/[*?:\\/[\]]/g, " ").slice(0, 31));
  ws.addRow([t.title]).font = { bold: true, size: 14 };
  if (t.subtitle) ws.addRow([t.subtitle]).font = { color: { argb: "FF666666" } };
  ws.addRow([]);
  const head = ws.addRow(t.head);
  head.font = { bold: true };
  head.eachCell((c) => { c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEEF0F6" } }; });
  for (const r of t.rows) ws.addRow(r.map(asNumber));
  ws.columns.forEach((col, i) => {
    const widest = Math.max(t.head[i]?.length ?? 8, ...t.rows.map((r) => String(r[i] ?? "").length));
    col.width = Math.min(48, Math.max(10, widest + 2));
  });
  ws.views = [{ state: "frozen", ySplit: head.number }];
  // A filter on every heading, so the rows can be narrowed in Excel.
  if (t.head.length) ws.autoFilter = { from: { row: head.number, column: 1 }, to: { row: head.number, column: t.head.length } };
}

/** A clean page with the table (or several, each under its own heading), opened for printing: the browser's "Save as PDF" makes the PDF. */
export function printPdf(t: ExportTable | ExportTable[], heading?: { title: string; subtitle?: string }) {
  const esc = (v: string | number) => String(v).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
  const many = Array.isArray(t);
  const tables = many ? t : [t];
  const top = heading ?? { title: tables[0]?.title ?? "", subtitle: tables[0]?.subtitle };
  const table = (x: ExportTable) => {
    const numeric = x.head.map((_, i) => x.rows.length > 0 && x.rows.every((r) => typeof asNumber(r[i] ?? "") === "number" || r[i] === "" || r[i] === "—"));
    return `${many ? `<h2>${esc(x.title)}</h2>` : ""}<table><thead><tr>${x.head.map((h, i) => `<th class="${numeric[i] ? "n" : ""}">${esc(h)}</th>`).join("")}</tr></thead>
  <tbody>${x.rows.map((r) => `<tr class="${String(r[0]).startsWith("Total") ? "t" : ""}">${r.map((v, i) => `<td class="${numeric[i] ? "n" : ""}">${esc(v)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  };
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(top.title)}</title><style>
    @page { size: A4; margin: 14mm; }
    body { font: 11px/1.4 "DM Sans", system-ui, sans-serif; color: #111; }
    h1 { font-size: 16px; margin: 0 0 2px; } p { margin: 0 0 12px; color: #666; } h2 { font-size: 13px; margin: 18px 0 6px; break-after: avoid; }
    table { width: 100%; border-collapse: collapse; } th, td { padding: 5px 6px; border-bottom: 1px solid #e5e7eb; text-align: left; }
    th { background: #eef0f6; font-weight: 600; } .n { text-align: right; font-variant-numeric: tabular-nums; } tr.t td { font-weight: 600; }
    footer { margin-top: 10px; color: #888; font-size: 10px; }
  </style></head><body><h1>${esc(top.title)}</h1>${top.subtitle ? `<p>${esc(top.subtitle)}</p>` : ""}
  ${tables.map(table).join("")}
  <footer>One POS · printed ${esc(new Date().toLocaleString("en-GB"))}</footer>
  <script>window.onload = () => { window.print(); };</script></body></html>`;
  const w = window.open("", "_blank");
  if (!w) return false;
  w.document.open(); w.document.write(html); w.document.close();
  return true;
}
