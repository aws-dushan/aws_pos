// Future orders in the demo copy (after seed.mjs): Marina Grill takes three future orders; the FACTS-linked Demo Bakery posts
// advances as QRV51 (no FACTS connection: its posting queue only fills, nothing is sent). Throwaway demo copy ONLY (API 5091, DB 5440).
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
const API = "http://localhost:5091/api";
if (!API.includes(":5091")) throw new Error("demo API only");
const sql = (q) => execSync(`docker exec onepos-docs-db psql -U onepos_owner -d onepos -qtAc "${q.replace(/\s+/g, " ").replace(/"/g, '\\"')}"`).toString().trim();
let cookie = "";
const ctx = {};
async function call(method, path, body) {
  const h = { "Content-Type": "application/json", Cookie: cookie, "Idempotency-Key": crypto.randomUUID() };
  if (ctx.company) h["X-Company-Id"] = ctx.company;
  if (ctx.branch) h["X-Branch-Id"] = ctx.branch;
  if (ctx.register) h["X-Register-Id"] = ctx.register;
  const r = await fetch(API + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const set = r.headers.getSetCookie?.() ?? [];
  if (set.length) cookie = set.map((c) => c.split(";")[0]).join("; ");
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} ${r.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
}
const at = (days, hh, mm = 0) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(hh, mm, 0, 0); return d.toISOString(); };
const ids = JSON.parse(readFileSync(new URL("./ids.json", import.meta.url), "utf8"));
const f = JSON.parse(readFileSync(new URL("./ids-facts.json", import.meta.url), "utf8"));

// Switched on for both demo branches; Demo Bakery posts advances as QRV51 from yesterday (queue only: posting stays off).
sql(`update branch set future_orders = true where id in ('${ids.branch}', '${f.branch}')`);
sql(`update company set facts_advances = 'qrv51' where id = '${f.company}'`);
sql(`update branch set facts_post_from = current_date - 1 where id = '${f.branch}'`);
sql(`insert into erp_payment_mode (company_id, branch_id, code, name, kind, label) values
     ('${f.company}', '${f.branch}', 'DMQSCASH', 'DMQS CASH', 'cash', 'Cash'), ('${f.company}', '${f.branch}', 'DMQSVISA', 'DMQS VISA CARD', 'card', 'Visa')
     on conflict do nothing`);

// Marina Grill: Sara at Till 1.
ctx.company = ids.company; ctx.branch = ids.branch; ctx.register = ids.register;
await call("POST", "/auth/pin", { branchId: ids.branch, pin: "2580", registerId: ids.register });
const fo = async (body, lines, pays) => {
  const o = (await call("POST", "/future-orders", body)).order;
  for (const [item, qty] of lines) await call("POST", `/orders/${o.id}/lines`, { itemId: ids.items[item], qty });
  if (pays) await call("POST", `/orders/${o.id}/pay`, { payments: pays });
  return o;
};
const a = await fo({ type: "takeaway", customerName: "Noura Al Mansoori", customerPhone: "0507788990", collectAt: at(1, 16), note: "Birthday: write \"Happy Birthday Omar\"" },
  [["Cheesecake", 4], ["Chocolate Fondant", 6]], [{ method: "card", amount: 100 }]);
const b = await fo({ type: "delivery", customerName: "Ahmed Karim", customerPhone: "0552233445", deliveryAddress: "Marina Promenade, Delphine tower, apt 2304", collectAt: at(0, 23, 30) },
  [["Four Cheese", 3], ["Caesar Salad", 2]], null);
const bt = (await call("GET", `/orders/${b.id}`)).order.total;
await call("POST", `/orders/${b.id}/pay`, { payments: [{ method: "cash", amount: bt, tendered: Math.ceil(bt / 50) * 50 }] });
await call("POST", `/future-orders/${b.id}/ready`, {});
await fo({ type: "takeaway", customerName: "Fatima Rahman", customerPhone: "0569911223", collectAt: at(3, 11) }, [["Cappuccino", 12], ["Cheesecake", 2]], null);

// Demo Bakery (FACTS): a cake with a FACTS item code, an advance split card + cash, collected with the balance by card.
cookie = ""; ctx.register = undefined; ctx.company = f.company; ctx.branch = f.branch;
await call("POST", "/auth/login", { username: "admin", password: "Demo-2026x" });
const regs = await call("GET", `/branches/${f.branch}/registers`);
const reg = (Array.isArray(regs) ? regs : regs.registers)?.[0] ?? await call("POST", `/branches/${f.branch}/registers`, { code: "T1", name: "Till 1" });
ctx.register = reg.id ?? reg.register?.id;
await call("POST", "/day/open", {}).catch(() => {});
await call("POST", "/shifts/open", { openingFloat: 300 }).catch(() => {});
const menu = await call("GET", "/menu");
const cat = (menu.categories ?? []).find((c) => c.name === "Cakes") ?? await call("POST", "/menu/categories", { name: "Cakes" });
const item = (menu.items ?? []).find((i) => i.name === "Chocolate Celebration Cake") ?? await call("POST", "/menu/items", { categoryId: cat.id, name: "Chocolate Celebration Cake", price: 185, station: "none" });
sql(`update menu_item set erp_item_code = '700125', erp_item_type = 'FG', erp_unit = 'PCS' where id = '${item.id}'`);
sql(`insert into branch_item (company_id, branch_id, item_id, is_sold, price, erp_priced) values ('${f.company}', '${f.branch}', '${item.id}', true, 185, false) on conflict do nothing`);
const c = (await call("POST", "/future-orders", { type: "takeaway", customerName: "Maryam Saeed", customerPhone: "0501122334", collectAt: at(2, 17), note: "Name on cake: Maryam" })).order;
await call("POST", `/orders/${c.id}/lines`, { itemId: item.id, qty: 2 });
await call("POST", `/orders/${c.id}/pay`, { payments: [{ method: "card", amount: 150, cardType: "DMQS VISA CARD" }, { method: "cash", amount: 50, tendered: 50 }] });
const d = (await call("POST", "/future-orders", { type: "takeaway", customerName: "Khalid Omar", customerPhone: "0523344556", collectAt: at(0, 23, 45) })).order;
await call("POST", `/orders/${d.id}/lines`, { itemId: item.id, qty: 1 });
await call("POST", `/orders/${d.id}/pay`, { payments: [{ method: "cash", amount: 85, tendered: 100 }] });
const col = await call("POST", `/future-orders/${d.id}/collect`, {});
await call("POST", `/orders/${d.id}/pay`, { payments: [{ method: "card", amount: col.order.due, cardType: "DMQS VISA CARD" }] });
writeFileSync(new URL("./ids-future.json", import.meta.url), JSON.stringify({ grill: { waiting: a.id, ready: b.id }, bakery: { waiting: c.id, collected: d.id } }));
console.log("future orders done", sql(`select string_agg(kind || ' ' || doc_no || ' ' || status, ' | ') from erp_post`));
