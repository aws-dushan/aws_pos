// Demo data for the user manual's screenshots. Runs ONLY against a throwaway demo copy of One POS:
//   docker run -d --name onepos-docs-db -e POSTGRES_DB=onepos -e POSTGRES_USER=onepos_owner -e POSTGRES_PASSWORD=onepos_owner_dev -p 5440:5432 postgres:17
//   API on :5091 with ConnectionStrings__Owner/App pointing at port 5440 (see tools/docs/demo/README.md), web: ONEPOS_API_URL=http://localhost:5091 npx next dev -p 3101
//   node tools/docs/demo/seed.mjs      then   node tools/docs/demo/screenshots.mjs && node tools/docs/demo/dialogs.mjs
import { writeFileSync } from "node:fs";
const API = "http://localhost:5091/api";
if (!API.includes(":5091")) throw new Error("demo API only");
let cookie = "";
const ctx = {};
async function call(method, path, body, extra = {}) {
  const h = { "Content-Type": "application/json", Cookie: cookie, "Idempotency-Key": crypto.randomUUID(), ...extra };
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
const step = process.argv[2] ?? "all";
const PW = "Demo-2026x";

try { await call("POST", "/auth/login", { username: "admin", password: "admin123" }); await call("POST", "/me/password", { current: "admin123", next: PW }); }
catch { await call("POST", "/auth/login", { username: "admin", password: PW }); }
const me = await call("GET", "/me");
console.log("signed in", Object.keys(me));
if (step === "me") { console.log(JSON.stringify(me).slice(0, 1500)); console.log(JSON.stringify(await call("GET", "/companies")).slice(0, 1500)); process.exit(0); }

const companies = await call("GET", "/companies");
let co = companies.find((c) => c.name === "Marina Grill");
if (!co) co = await call("POST", "/companies", { code: "MGR", name: "Marina Grill", legalName: "Marina Grill Restaurants LLC", legalNameAr: "مارينا جريل للمطاعم ذ.م.م",
  trn: "100234567800003", baseCurrency: "AED", vatRate: 5, pricesIncludeVat: true, erpConnector: "none" });
ctx.company = co.id;
const branches = await call("GET", `/companies/${co.id}/branches`);
let br = branches.find((b) => b.name === "Dubai Marina");
if (!br) br = await call("POST", `/companies/${co.id}/branches`, { code: "MRN", name: "Dubai Marina", address: "Marina Walk, Dubai", phone: "04 555 0101",
  timeZone: "Asia/Dubai", tableService: true, askGuests: true, serviceChargePct: 0, dayControl: "manual", kitchenEnabled: true, returnDays: 0,
  defaultFloat: 500, varianceTolerance: 10, openOrdersAtClose: "carry", nameAr: "دبي مارينا", addressAr: "ممشى المارينا، دبي", returnsEnabled: true, pickupMode: "auto" });
ctx.branch = br.id;
console.log("company", co.id, "branch", br.id);
writeFileSync(new URL("./ctx.json", import.meta.url), JSON.stringify({ company: co.id, branch: br.id }));
if (step === "company") process.exit(0);

// Staff and till
const roles = await call("GET", `/companies/${co.id}/roles`);
const role = (n) => roles.find((r) => r.name === n).id;
const users = await call("GET", `/companies/${co.id}/users`);
const addUser = async (username, displayName, r, pin, password) => users.find((u) => u.username === username) ??
  await call("POST", `/companies/${co.id}/users`, { username, displayName, roleId: role(r), branchIds: [br.id], pin, password });
await addUser("sara", "Sara Ahmed", "Cashier", "2580");
await addUser("ravi", "Ravi Kumar", "Waiter", "3691");
await addUser("chef", "Chef Ana", "Kitchen", "4826");
await addUser("omar", "Omar Haddad", "Branch manager", "7395", "Manager-2026x");
await addUser("fatima", "Fatima Noor", "Finance", null, "Finance-2026x");
const regs = await call("GET", `/branches/${br.id}/registers`);
let reg = regs.find((r) => r.code === "T1") ?? await call("POST", `/branches/${br.id}/registers`, { code: "T1", name: "Till 1" });
if (!regs.find((r) => r.code === "T2")) await call("POST", `/branches/${br.id}/registers`, { code: "T2", name: "Till 2" });
console.log("staff + tills");

// Menu
const menu = await call("GET", "/menu");
const cats = {};
for (const [name, nameAr] of [["Burgers", "برجر"], ["Pizza", "بيتزا"], ["Salads", "سلطات"], ["Drinks", "مشروبات"], ["Desserts", "حلويات"]])
  cats[name] = (menu.categories ?? []).find((c) => c.name === name)?.id ?? (await call("POST", "/menu/categories", { name, nameAr, isActive: true })).id;
const groups = {};
const haveGroups = menu.modifierGroups ?? menu.groups ?? menu.modifier_groups ?? [];
const addGroup = async (name, min, max, options) => groups[name] = haveGroups.find((g) => g.name === name)?.id ??
  (await call("POST", "/menu/modifier-groups", { name, minSelect: min, maxSelect: max, options: options.map(([n, p]) => ({ name: n, price: p })) })).id;
await addGroup("Cooking", 1, 1, [["Medium", 0], ["Well done", 0]]);
await addGroup("Extras", 0, 3, [["Extra cheese", 4], ["Bacon", 6], ["Jalapeños", 3]]);
await addGroup("Size", 1, 1, [["Regular", 0], ["Large", 5]]);
const items = [
  ["Burgers", "Classic Beef Burger", "برجر لحم كلاسيك", 42, "kitchen", ["Cooking", "Extras"]],
  ["Burgers", "Chicken Burger", "برجر دجاج", 38, "kitchen", ["Extras"]],
  ["Burgers", "Mushroom Swiss Burger", "برجر مشروم", 46, "kitchen", ["Cooking", "Extras"]],
  ["Pizza", "Margherita", "مارجريتا", 39, "kitchen", []],
  ["Pizza", "Pepperoni", "بيبروني", 45, "kitchen", ["Extras"]],
  ["Pizza", "Four Cheese", "أربعة أجبان", 48, "kitchen", []],
  ["Salads", "Caesar Salad", "سلطة سيزر", 32, "kitchen", []],
  ["Salads", "Greek Salad", "سلطة يونانية", 30, "kitchen", []],
  ["Drinks", "Fresh Orange Juice", "عصير برتقال", 18, "bar", ["Size"]],
  ["Drinks", "Lemon Mint", "ليمون بالنعناع", 20, "bar", ["Size"]],
  ["Drinks", "Cappuccino", "كابتشينو", 16, "bar", []],
  ["Drinks", "Mineral Water", "مياه معدنية", 6, "bar", []],
  ["Desserts", "Chocolate Fondant", "فوندان شوكولاتة", 28, "kitchen", []],
  ["Desserts", "Cheesecake", "تشيز كيك", 26, "kitchen", []],
];
const have = menu.items ?? [];
const ids = {};
for (const [cat, name, nameAr, price, station, gs] of items) {
  ids[name] = have.find((i) => i.name === name)?.id ?? (await call("POST", "/menu/items", { categoryId: cats[cat], name, nameAr, price, station,
    isActive: true, groupIds: gs.map((g) => groups[g]) })).id;
  await call("PUT", `/menu/items/${ids[name]}/branch`, { isSold: true });
}
writeFileSync(new URL("./ids.json", import.meta.url), JSON.stringify({ company: co.id, branch: br.id, register: reg.id, items: ids, groups }));
console.log("menu", Object.keys(ids).length);
if (step === "menu") process.exit(0);

// Floor plan
const floors = await call("GET", "/floor").catch(() => []);
const flList = Array.isArray(floors) ? floors : floors.floors ?? [];
let floor = flList.find((f) => f.name === "Main hall") ?? await call("POST", "/floors", { name: "Main hall", sort: 1 });
const tablesNow = Array.isArray(floors) ? [] : floors.tables ?? [];
const tableIds = {};
const layout = [["T1", 2, "round", 1, 1], ["T2", 2, "round", 4, 1], ["T3", 4, "square", 7, 1], ["T4", 4, "square", 10, 1],
  ["T5", 6, "rect", 1, 5], ["T6", 4, "square", 6, 5], ["T7", 8, "rect", 9, 5], ["T8", 2, "round", 14, 1]];
for (const [name, seats, shape, x, y] of layout) {
  const ex = tablesNow.find((t) => t.name === name);
  tableIds[name] = ex?.id ?? (await call("POST", "/tables", { floorId: floor.id, name, seats, shape, x, y, w: shape === "rect" ? 4 : 2, h: 2 })).id;
}
console.log("tables", Object.keys(tableIds).length);

if (step !== "orders") {
// Customers, discounts, reservation
for (const c of [["Layla Hassan", "0501234567", "layla@example.com", "Marina Gate 1, apt 1203", "Allergic to nuts"],
  ["John Carter", "0559876543", null, "JBR Sadaf 4, apt 905", null], ["Aisha Rahman", "0524567890", null, null, "Prefers window table"]])
  await call("POST", "/customers", { name: c[0], phone: c[1], email: c[2], address: c[3], notes: c[4] }).catch((e) => console.log("cust", e.message.slice(0, 80)));
await call("POST", "/discounts", { kind: "promotion", name: "Happy hour drinks", type: "pct", value: 20, appliesTo: "categories", categoryIds: [cats.Drinks],
  timeFrom: "15:00", timeTo: "18:00", branchIds: [br.id], channel: "all", isActive: true }).catch((e) => console.log("disc", e.message.slice(0, 160)));
await call("POST", "/discounts", { kind: "cashier", name: "Staff meal", type: "pct", value: 50, target: "bill", needsNote: true, branchIds: [br.id], isActive: true })
  .catch((e) => console.log("disc2", e.message.slice(0, 160)));
const tonight = new Date(); tonight.setHours(20, 0, 0, 0);
await call("POST", "/reservations", { name: "Aisha Rahman", phone: "0524567890", guests: 4, startsAt: tonight.toISOString(), durationMin: 90, tableIds: [tableIds.T6], note: "Birthday" })
  .catch((e) => console.log("resv", e.message.slice(0, 160)));
await call("POST", "/day/open").catch((e) => console.log("day", e.message.slice(0, 120)));
}
writeFileSync(new URL("./ids.json", import.meta.url), JSON.stringify({ company: co.id, branch: br.id, register: reg.id, items: ids, groups, tables: tableIds }));
console.log("setup done");
const tables = tableIds;

if (step === "setup") process.exit(0);

// The till: Sara signs in with her PIN on Till 1 and works a lunch service
const m2 = await call("GET", "/menu");
cookie = ""; ctx.register = reg.id;
await call("POST", "/auth/pin", { branchId: br.id, pin: "2580", registerId: reg.id });
const counts = { "200": 1, "100": 2, "50": 1, "20": 2, "10": 1 };
await call("POST", "/shifts/open", { openingFloat: 500, counts }).catch((e) => console.log("shift", e.message.slice(0, 150)));
const dayNow = await call("GET", "/day");
const shift = (dayNow.shifts ?? []).find((x) => x.status === "open") ?? null;
console.log("day keys", Object.keys(dayNow), shift?.id);
const opt = (name) => { for (const g of m2.modifierGroups ?? m2.groups ?? []) for (const o of g.options ?? []) if (o.name === name) return o.id; throw new Error("no option " + name); };
const order = async (open, lines, pay, send = true) => {
  const o = (await call("POST", "/orders", open)).order;
  for (const [item, qty, opts, note] of lines) await call("POST", `/orders/${o.id}/lines`, { itemId: ids[item], qty, optionIds: (opts ?? []).map(opt), note });
  if (send) await call("POST", `/orders/${o.id}/send`);
  if (pay) {
    const d = await call("GET", `/orders/${o.id}`);
    const total = d.order.total;
    await call("POST", `/orders/${o.id}/pay`, { payments: pay === "cash" ? [{ method: "cash", amount: total, tendered: Math.ceil(total / 50) * 50 }] : [{ method: pay, amount: total, reference: "4417" }] });
  }
  return o;
};
await order({ type: "takeaway" }, [["Classic Beef Burger", 2, ["Medium", "Extra cheese"]], ["Fresh Orange Juice", 2, ["Regular"]]], "cash");
await order({ type: "takeaway" }, [["Margherita", 1], ["Mineral Water", 2]], "card");
await order({ type: "delivery", customerName: "Layla Hassan", customerPhone: "0501234567", deliveryAddress: "Marina Gate 1, apt 1203" }, [["Pepperoni", 1, ["Bacon"]], ["Caesar Salad", 1], ["Lemon Mint", 2, ["Large"]]], "card");
await order({ type: "dine_in", tableId: tables.T5, guests: 5 }, [["Mushroom Swiss Burger", 2, ["Well done"]], ["Four Cheese", 1], ["Greek Salad", 2], ["Cappuccino", 3]], "cash");
await order({ type: "takeaway" }, [["Chicken Burger", 1, [], "No mayo"], ["Cheesecake", 1]], "cash");
await order({ type: "dine_in", tableId: tables.T2, guests: 2 }, [["Classic Beef Burger", 1, ["Well done"]], ["Caesar Salad", 1], ["Lemon Mint", 2, ["Regular"]]], null);
await order({ type: "dine_in", tableId: tables.T3, guests: 4 }, [["Pepperoni", 2], ["Chocolate Fondant", 2], ["Fresh Orange Juice", 4, ["Large"]]], null);
await order({ type: "takeaway" }, [["Mushroom Swiss Burger", 1, ["Medium"]], ["Cappuccino", 1]], null);
await order({ type: "dine_in", tableId: tables.T7, guests: 6 }, [["Four Cheese", 2], ["Margherita", 1], ["Mineral Water", 6]], null);
if (shift) await call("POST", `/shifts/${shift.id ?? shift.shiftId}/cash`, { kind: "drop", amount: 200, reason: "Safe drop" }).catch((e) => console.log("drop", e.message.slice(0, 120)));
writeFileSync(new URL("./ids.json", import.meta.url), JSON.stringify({ company: co.id, branch: br.id, register: reg.id, items: ids, groups, tables: tableIds, shift: shift?.id }));
console.log("orders done");

// A FACTS-linked demo company for the technical docs' FACTS screens (no connection string: nothing is read or posted).
cookie = ""; ctx.register = undefined;
await call("POST", "/auth/login", { username: "admin", password: PW });
const all = await call("GET", "/companies");
let fco = all.find((c) => c.name === "Demo Bakery") ?? await call("POST", "/companies", { code: "DBK", name: "Demo Bakery", legalName: "Demo Bakery LLC",
  trn: "100987654300003", baseCurrency: "AED", vatRate: 5, pricesIncludeVat: true, erpConnector: "facts" });
ctx.company = fco.id; ctx.branch = undefined;
const fbr = (await call("GET", `/companies/${fco.id}/branches`)).find((b) => b.name === "Al Qusais") ?? await call("POST", `/companies/${fco.id}/branches`, {
  code: "QS", name: "Al Qusais", address: "Al Qusais, Dubai", timeZone: "Asia/Dubai", tableService: false, kitchenEnabled: false, dayControl: "manual",
  erpLocationCode: "DMQS", erpLocationName: "Demo Al Qusais outlet", erpWasteLocation: "DMWQS", factsPriceType: "OP1", factsItemTypes: "FG", returnsEnabled: true });
writeFileSync(new URL("./ids-facts.json", import.meta.url), JSON.stringify({ company: fco.id, branch: fbr.id }));
console.log("facts company", fco.id, fbr.id);
