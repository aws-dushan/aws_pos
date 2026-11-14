// Future orders screenshots for the manual and the technical docs (after seed.mjs and future.mjs). Demo copy only: web 3101 → API 5091.
import { chromium } from "playwright-core";
import { fileURLToPath } from "node:url";
import { readFileSync, mkdirSync } from "node:fs";
const WEB = "http://localhost:3101";
const out = fileURLToPath(new URL("./shots/", import.meta.url));
mkdirSync(out, { recursive: true });
const ids = JSON.parse(readFileSync(new URL("./ids.json", import.meta.url), "utf8"));
const f = JSON.parse(readFileSync(new URL("./ids-facts.json", import.meta.url), "utf8"));
const fut = JSON.parse(readFileSync(new URL("./ids-future.json", import.meta.url), "utf8"));
const browser = await chromium.launch({ executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
const opts = { viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1.5, colorScheme: "light", reducedMotion: "reduce", locale: "en-GB", timezoneId: "Asia/Dubai" };
const settle = async (page, ms = 2000) => { await page.waitForLoadState("networkidle").catch(() => {}); await page.waitForTimeout(ms); };
const shot = async (page, name, ms) => { await settle(page, ms); await page.screenshot({ path: out + name + ".png" }); console.log("shot", name); };
const step = async (name, fn) => { try { await fn(); } catch (e) { console.log("skip", name, e.message.split("\n")[0]); } };
const btn = (page, name) => page.getByRole("button", { name, exact: false }).first();

// Logo without the signature line (same as screenshots.mjs).
const brandDir = new URL("../../../web/public/brand/", import.meta.url);
const WORD_Y = { "one-pos-header": ["1583.5", 715.0, 922], "one-pos-horizontal": ["1888.7", 839.2, 1100] };
const strip = (context) => context.route(/\/brand\/(one-pos-[a-z]+)-(light|dark)\.svg/, (route) => {
  const [, kind, tone] = route.request().url().match(/\/brand\/(one-pos-[a-z]+)-(light|dark)\.svg/);
  const [x, from, to] = WORD_Y[kind];
  const svg = readFileSync(new URL(`${kind}-${tone}.svg`, brandDir), "utf8")
    .replace(/<g transform="translate\(0 [\d.]+\) scale\([\d.]+\)">.*?<\/g>/, "").replace(`translate(${x} ${from.toFixed(1)})`, `translate(${x} ${to})`)
    .replaceAll("One POS by AWS Distribution", "One POS");
  return route.fulfill({ status: 200, contentType: "image/svg+xml", body: svg });
});

// Marina Grill's till (Sara, Till 1).
const till = await browser.newContext(opts);
await strip(till);
await till.addInitScript(([c, b, r]) => { localStorage.setItem("onepos.till.branch", b); localStorage.setItem("onepos.till.register", r); localStorage.setItem(`onepos.register.${b}`, r);
  localStorage.setItem("onepos.scope", JSON.stringify({ companyId: c, branchId: b })); localStorage.setItem("onepos.reduced", "1"); }, [ids.company, ids.branch, ids.register]);
const t = await till.newPage();
await t.goto(WEB + "/till"); await settle(t, 2500);
for (const d of "2580") await t.getByRole("button", { name: d, exact: true }).click();
await btn(t, "Sign in").click().catch(() => {});
await t.waitForURL((u) => !u.pathname.startsWith("/till"), { timeout: 60000 }).catch(() => {});

await step("future-orders", async () => {
  await t.goto(WEB + "/future"); await settle(t, 2500);
  await t.getByRole("radio", { name: /All open/ }).click();
  await shot(t, "future-orders", 2500);
});
await step("future-new", async () => {
  await btn(t, "New future order").click(); await settle(t, 800);
  const dlg = t.getByRole("dialog");
  await dlg.locator("input").nth(0).fill("Hessa Al Ali");
  await dlg.locator("input").nth(1).fill("0504455667");
  await dlg.locator("input").last().fill("Name on cake: Hessa, gold candles");
  await shot(t, "future-new", 800);
  await t.keyboard.press("Escape");
});
await step("future-register", async () => { await t.goto(WEB + `/register?order=${fut.grill.waiting}`); await shot(t, "future-register", 3500); });
await step("future-advance", async () => {
  await btn(t, "Take advance").click(); await settle(t, 800);
  await t.getByRole("dialog").getByText("Card", { exact: true }).first().click().catch(() => {});
  await shot(t, "future-advance", 1200);
  await t.keyboard.press("Escape");
});
await step("future-receipt", async () => {
  await t.goto(WEB + "/future"); await settle(t, 2000);
  await t.getByRole("radio", { name: /All open/ }).click(); await settle(t, 1500);
  await t.getByRole("button", { name: "Receipt" }).nth(1).click();
  await shot(t, "future-receipt", 2500);
  await t.getByRole("dialog").evaluate((d) => { for (const el of d.querySelectorAll("*")) if (el.scrollHeight > el.clientHeight + 4) el.scrollTop = el.scrollHeight; });
  await shot(t, "future-receipt-end", 1000);
  await t.keyboard.press("Escape");
});
await step("future-collect", async () => {
  await t.getByRole("radio", { name: /Today/ }).click(); await settle(t, 1500);
  await btn(t, "Collect").click();
  await shot(t, "future-collect", 1000);
  await t.keyboard.press("Escape");
});

// Back office: Demo Bakery (FACTS-linked, no connection) and the branch switch.
const admin = await browser.newContext(opts);
await strip(admin);
await admin.addInitScript(([c, b]) => { localStorage.setItem("onepos.scope", JSON.stringify({ companyId: c, branchId: b })); localStorage.setItem("onepos.reduced", "1"); }, [f.company, f.branch]);
const p = await admin.newPage();
await p.goto(WEB + "/login"); await settle(p, 1500);
await p.locator("input").nth(0).fill("admin");
await p.locator("input[type=password]").first().fill("Demo-2026x");
await p.keyboard.press("Enter");
await p.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60000 });
await step("tech-facts-posting", async () => {
  await p.goto(WEB + "/admin/facts-posting"); await settle(p, 2500);
  await p.getByText("Future orders' advances").first().evaluate((el) => el.scrollIntoView({ block: "center" }));
  await shot(p, "tech-facts-advances", 1500);
  await p.goto(WEB + "/admin/facts-posting"); await shot(p, "tech-facts-posting", 2500);
});
await step("tech-facts-advances-log", async () => {
  await p.getByText("ADV-DBA-01-000001").first().evaluate((el) => el.scrollIntoView({ block: "center" }));
  await shot(p, "tech-facts-advances-log", 1500);
});
await step("future-invoice", async () => {
  await p.goto(WEB + "/future"); await settle(p, 2000);
  await p.getByRole("radio", { name: "Done" }).click(); await settle(p, 1500);
  await p.getByRole("button", { name: "Receipt" }).first().click();
  await shot(p, "future-invoice", 2500);
  await p.getByRole("dialog").evaluate((d) => { for (const el of d.querySelectorAll("*")) if (el.scrollHeight > el.clientHeight + 4) el.scrollTop = el.scrollHeight; });
  await shot(p, "future-invoice-end", 1000);
  await p.keyboard.press("Escape");
});
await step("future-switch", async () => {
  await p.goto(WEB + "/admin/companies"); await settle(p, 2000);
  await p.getByText("Al Qusais, Dubai").first().click(); await settle(p, 1500);
  await p.getByRole("dialog").getByText("Future orders", { exact: true }).first().evaluate((el) => el.scrollIntoView({ block: "center" }));
  await shot(p, "future-switch", 1200);
  await p.keyboard.press("Escape");
});
await browser.close();
