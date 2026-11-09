/*
 * Prices in Excel: a template with today's prices (one row per item, the outlet and each platform as columns), and reading such a
 * file back. Reading only works out what differs from today's prices; the page puts those on the screen as typed changes, and
 * posting is the usual Post to FACTS. All in the browser (the library loads only when used).
 */
import { fileName, save } from "@/lib/export";

export type XItem = { id: string; code: string; name: string; category: string; outlet: number | null; platforms: Record<string, number> };
export type XPlatform = { id: string; name: string };

/** One price picked up from the file: the item, the platform ("" = outlet) and the price as typed. */
export type XChange = { itemId: string; platformId: string; price: number };
export type XResult = {
  changes: XChange[];
  perColumn: { label: string; n: number }[];
  unchanged: number;
  skipped: { row: number | null; code: string; why: string }[];
};

const OUTLET = "Outlet";
const outletHead = (priceType: string | null) => (priceType ? `${OUTLET} (${priceType})` : OUTLET);

export async function downloadTemplate(branch: { code: string; name: string; priceType: string | null }, platforms: XPlatform[], items: XItem[]) {
  const { Workbook } = await import("exceljs");
  const wb = new Workbook();
  wb.creator = "One POS";
  const ws = wb.addWorksheet("Prices");
  ws.addRow([`Prices · ${branch.name}`]).font = { bold: true, size: 14 };
  const b = ws.addRow(["Branch", branch.code]);
  b.getCell(1).font = { color: { argb: "FF666666" } };
  b.getCell(2).font = { bold: true };
  ws.addRow(["Selling prices with VAT. Change the prices you want and upload the file on the Prices page. An empty cell is left as it is; only the Code is used to find the item."])
    .font = { color: { argb: "FF666666" }, italic: true };
  ws.addRow([]);
  const head = ws.addRow(["Code", "Item", "Category", outletHead(branch.priceType), ...platforms.map((p) => p.name)]);
  head.font = { bold: true };
  head.eachCell((c) => { c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEEF0F6" } }; });
  const grey = { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFF3F4F6" } };
  for (const i of items) {
    const r = ws.addRow([i.code, i.name, i.category, i.outlet ?? null, ...platforms.map((p) => i.platforms[p.id] ?? null)]);
    r.getCell(1).numFmt = "@";
    for (let c = 1; c <= 3; c++) { r.getCell(c).fill = grey; r.getCell(c).font = { color: { argb: "FF555555" } }; }
    for (let c = 4; c <= 3 + 1 + platforms.length; c++) r.getCell(c).numFmt = "0.00";
  }
  ws.getColumn(1).width = 12;
  ws.getColumn(2).width = Math.min(48, Math.max(16, ...items.map((i) => i.name.length + 2)));
  ws.getColumn(3).width = Math.min(30, Math.max(12, ...items.map((i) => i.category.length + 2)));
  for (let c = 4; c <= 3 + 1 + platforms.length; c++) ws.getColumn(c).width = Math.max(12, String(head.getCell(c).value ?? "").length + 2);
  ws.views = [{ state: "frozen", ySplit: head.number, xSplit: 2 }];
  const buf = await wb.xlsx.writeBuffer();
  save(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
    `${fileName(`Prices ${branch.code} ${new Date().toISOString().slice(0, 10)}`)}.xlsx`);
}

/** A cell as plain text, whatever Excel stored (number, formula result, rich text, a date is not expected). */
function text(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return v.trim();
  if (typeof v === "object") {
    const o = v as { result?: unknown; richText?: { text: string }[]; text?: string };
    if (o.result !== undefined) return text(o.result);
    if (o.richText) return o.richText.map((x) => x.text).join("").trim();
    if (typeof o.text === "string") return o.text.trim();
  }
  return String(v).trim();
}

/** A price: more than 0, at most 2 decimals ("9.5", "9.50", 9.5 all fine). Null when it isn't one. */
function price(v: unknown): number | null {
  const raw = v !== null && typeof v === "object" && "result" in (v as object) ? (v as { result: unknown }).result : v;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw <= 0) return null;
    const cents = raw * 100;
    return Math.abs(cents - Math.round(cents)) < 1e-6 ? Math.round(cents) / 100 : null;
  }
  const s = text(raw).replace(/^AED\s*/i, "");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const n = Number(s);
  return n > 0 ? n : null;
}

export async function readPrices(file: File, branchCode: string, platforms: XPlatform[], items: XItem[]): Promise<XResult> {
  const { Workbook } = await import("exceljs");
  const wb = new Workbook();
  try { await wb.xlsx.load(await file.arrayBuffer()); }
  catch { throw new Error("This isn't an Excel file (.xlsx) that can be read. Download the template and use that."); }
  const ws = wb.worksheets[0];
  if (!ws) throw new Error("The file has no sheet.");

  // The heading row: the first row whose first cell is "Code". A "Branch" row above it, when there, must be this branch.
  let headRow = 0;
  for (let r = 1; r <= Math.min(ws.rowCount, 30) && !headRow; r++) {
    const first = text(ws.getRow(r).getCell(1).value).toLowerCase();
    if (first === "branch") {
      const code = text(ws.getRow(r).getCell(2).value);
      if (code && code.toUpperCase() !== branchCode.toUpperCase())
        throw new Error(`This file is for branch ${code}, not ${branchCode}. Switch branch at the top, or download this branch's template.`);
    }
    if (first === "code") headRow = r;
  }
  if (!headRow) throw new Error('No "Code" heading found. Download the template and use that.');

  // Columns by heading: Outlet (…) and the platform names; Code/Item/Category are not prices.
  const cols: { col: number; platformId: string; label: string }[] = [];
  const skipped: XResult["skipped"] = [];
  const head = ws.getRow(headRow);
  for (let c = 2; c <= head.cellCount; c++) {
    const h = text(head.getCell(c).value);
    if (!h || ["item", "category", "name"].includes(h.toLowerCase())) continue;
    if (h.toLowerCase().startsWith(OUTLET.toLowerCase())) { cols.push({ col: c, platformId: "", label: OUTLET }); continue; }
    const p = platforms.find((x) => x.name.trim().toLowerCase() === h.toLowerCase());
    if (p) cols.push({ col: c, platformId: p.id, label: p.name });
    else skipped.push({ row: null, code: "", why: `Column "${h}": not the outlet or a delivery platform here, left out` });
  }
  if (!cols.length) throw new Error("No price columns found (Outlet, or a platform name like Talabat).");

  const byCode = new Map(items.map((i) => [i.code.trim().toUpperCase(), i]));
  const seen = new Set<string>();
  const changes: XChange[] = [];
  let unchanged = 0;
  for (let r = headRow + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const code = text(row.getCell(1).value);
    const any = cols.some((c) => text(row.getCell(c.col).value) !== "");
    if (!code) { if (any) skipped.push({ row: r, code: "", why: "no code" }); continue; }
    const item = byCode.get(code.toUpperCase());
    if (!item) { skipped.push({ row: r, code, why: "not an item sold at this branch" }); continue; }
    if (seen.has(item.id)) { skipped.push({ row: r, code, why: "listed twice, only the first row is used" }); continue; }
    seen.add(item.id);
    for (const c of cols) {
      const cell = row.getCell(c.col).value;
      if (text(cell) === "") continue;
      const v = price(cell);
      if (v === null) { skipped.push({ row: r, code, why: `${c.label} "${text(cell)}": not a price (use e.g. 7.50)` }); continue; }
      const now = c.platformId === "" ? item.outlet : item.platforms[c.platformId] ?? null;
      if (now === v) unchanged++;
      else changes.push({ itemId: item.id, platformId: c.platformId, price: v });
    }
  }
  const perColumn = cols.map((c) => ({ label: c.label, n: changes.filter((x) => x.platformId === c.platformId).length })).filter((x) => x.n > 0);
  return { changes, perColumn, unchanged, skipped };
}
