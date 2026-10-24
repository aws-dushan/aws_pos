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

export function downloadCsv(name: string, t: ExportTable) {
  const esc = (v: string | number) => { const s = String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  save(new Blob(["﻿" + [t.head, ...t.rows].map((r) => r.map(esc).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" }), `${fileName(name)}.csv`);
}

/** Numbers formatted for the screen ("1,234.50") go into Excel as numbers, so they add up there. */
const asNumber = (v: string | number) => {
  if (typeof v === "number") return v;
  const s = v.replace(/,/g, "").trim();
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : v;
};

export async function downloadXlsx(name: string, t: ExportTable) {
  const { Workbook } = await import("exceljs");
  const wb = new Workbook();
  wb.creator = "One POS";
  const ws = wb.addWorksheet(t.title.slice(0, 31));
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
  const buf = await wb.xlsx.writeBuffer();
  save(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), `${fileName(name)}.xlsx`);
}

/** A clean page with the table, opened for printing: the browser's "Save as PDF" makes the PDF. */
export function printPdf(t: ExportTable) {
  const esc = (v: string | number) => String(v).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
  const numeric = t.head.map((_, i) => t.rows.length > 0 && t.rows.every((r) => typeof asNumber(r[i] ?? "") === "number" || r[i] === "" || r[i] === "—"));
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(t.title)}</title><style>
    @page { size: A4; margin: 14mm; }
    body { font: 11px/1.4 "DM Sans", system-ui, sans-serif; color: #111; }
    h1 { font-size: 16px; margin: 0 0 2px; } p { margin: 0 0 12px; color: #666; }
    table { width: 100%; border-collapse: collapse; } th, td { padding: 5px 6px; border-bottom: 1px solid #e5e7eb; text-align: left; }
    th { background: #eef0f6; font-weight: 600; } .n { text-align: right; font-variant-numeric: tabular-nums; }
    footer { margin-top: 10px; color: #888; font-size: 10px; }
  </style></head><body><h1>${esc(t.title)}</h1>${t.subtitle ? `<p>${esc(t.subtitle)}</p>` : ""}
  <table><thead><tr>${t.head.map((h, i) => `<th class="${numeric[i] ? "n" : ""}">${esc(h)}</th>`).join("")}</tr></thead>
  <tbody>${t.rows.map((r) => `<tr>${r.map((v, i) => `<td class="${numeric[i] ? "n" : ""}">${esc(v)}</td>`).join("")}</tr>`).join("")}</tbody></table>
  <footer>One POS · printed ${esc(new Date().toLocaleString("en-GB"))}</footer>
  <script>window.onload = () => { window.print(); };</script></body></html>`;
  const w = window.open("", "_blank");
  if (!w) return false;
  w.document.open(); w.document.write(html); w.document.close();
  return true;
}
