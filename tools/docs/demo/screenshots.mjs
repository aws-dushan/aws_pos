// Screenshots for the user manual, from the throwaway demo copy only (web 3101 → API 5091, demo data).
import { chromium } from "playwright-core";
import { fileURLToPath } from "node:url";
import { readFileSync, mkdirSync } from "node:fs";
// The screenshots show the One POS logo without its "by AWS Distribution" line: the logo files are served with the signature
// removed and the wordmark moved down level with the symbol (as on the PDF covers). The app itself is unchanged.
import { readFileSync as readBrand } from "node:fs";
const brandDir = new URL("../../../web/public/brand/", import.meta.url);
const WORD_Y = { "one-pos-header": [715.0, 922], "one-pos-horizontal": [839.2, 1100] };
async function stripSignature(context) {
  await context.route(/\/brand\/(one-pos-[a-z]+)-(light|dark)\.svg/, async (route) => {
    const [, kind, tone] = route.request().url().match(/\/brand\/(one-pos-[a-z]+)-(light|dark)\.svg/);
    const [from, to] = WORD_Y[kind];
    const svg = readBrand(new URL(`${kind}-${tone}.svg`, brandDir), "utf8")
      .replace(/<g transform="translate\(0 [\d.]+\) scale\([\d.]+\)">.*?<\/g>/, "")
      .replace(`translate(${kind === "one-pos-header" ? "1583.5" : "1888.7"} ${from.toFixed(1)})`, `translate(${kind === "one-pos-header" ? "1583.5" : "1888.7"} ${to})`)
      .replaceAll("One POS by AWS Distribution", "One POS");
    await route.fulfill({ status: 200, contentType: "image/svg+xml", body: svg });
  });
}
const WEB = "http://localhost:3101";
const ids = JSON.parse(readFileSync(new URL("./ids.json", import.meta.url), "utf8"));
const out = fileURLToPath(new URL("./shots/", import.meta.url));  // then copied into docs/manual/images as JPEG
mkdirSync(out, { recursive: true });
const only = process.argv.slice(2);
const want = (n) => !only.length || only.includes(n);
const browser = await chromium.launch({ executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
const opts = { viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1.5, colorScheme: "light", reducedMotion: "reduce", locale: "en-GB", timezoneId: "Asia/Dubai" };
const settle = async (page, ms = 1200) => { await page.waitForLoadState("networkidle").catch(() => {}); await page.waitForTimeout(ms); };
const shot = async (page, name, o = {}) => { await settle(page, o.wait ?? 1200); await page.screenshot({ path: out + name + ".png", ...o.clip ? { clip: o.clip } : {} }); console.log("shot", name); };
const btn = (page, name) => page.getByRole("button", { name, exact: false }).first();

// Back office: the admin, working at Dubai Marina
const admin = await browser.newContext(opts);
await stripSignature(admin);
await admin.addInitScript(([c, b]) => { localStorage.setItem("onepos.scope", JSON.stringify({ companyId: c, branchId: b })); localStorage.setItem("onepos.reduced", "1"); }, [ids.company, ids.branch]);
const p = await admin.newPage();
await p.goto(WEB + "/login");
if (want("login")) await shot(p, "login");
await p.locator("input").nth(0).fill("admin");
await p.locator("input[type=password]").first().fill("Demo-2026x");
await p.keyboard.press("Enter");
await p.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60000 });
const pages = [["dashboard", "/"], ["floor", "/floor"], ["reservations", "/reservations"], ["kitchen", "/kitchen"], ["day", "/day"], ["approvals", "/approvals"],
  ["orders", "/orders"], ["stock", "/stock"], ["reports", "/reports"], ["customers", "/customers"], ["discounts", "/discounts"], ["menu", "/menu"],
  ["tables", "/tables"], ["paper", "/paper"], ["platform-report", "/platforms"], ["companies", "/admin/companies"], ["users", "/admin/users"],
  ["roles", "/admin/roles"], ["devices", "/devices"], ["branding", "/branding"], ["alerts", "/admin/alerts"], ["audit", "/admin/audit"], ["platforms", "/admin/platforms"]];
for (const [name, path] of pages) if (want(name)) { await p.goto(WEB + path); await shot(p, name, { wait: 2500 }); }

// The till: Till 1 at Dubai Marina, Sara's PIN
const till = await browser.newContext(opts);
await stripSignature(till);
await till.addInitScript(([c, b, r]) => { localStorage.setItem("onepos.till.branch", b); localStorage.setItem("onepos.till.register", r); localStorage.setItem(`onepos.register.${b}`, r);
  localStorage.setItem("onepos.scope", JSON.stringify({ companyId: c, branchId: b })); localStorage.setItem("onepos.reduced", "1"); }, [ids.company, ids.branch, ids.register]);
const t = await till.newPage();
await t.goto(WEB + "/till");
await settle(t, 2500);
for (const d of "25") await t.getByRole("button", { name: d, exact: true }).click();
if (want("till-pin")) await shot(t, "till-pin");
for (const d of "80") await t.getByRole("button", { name: d, exact: true }).click();
await btn(t, "Sign in").click().catch(() => {});
await t.waitForURL((u) => !u.pathname.startsWith("/till"), { timeout: 60000 }).catch(() => {});
await t.goto(WEB + "/register");
if (want("register-start")) await shot(t, "register-start", { wait: 3000 });
await btn(t, "Takeaway").click();
await settle(t);
await t.getByText("Classic Beef Burger", { exact: true }).first().click();
if (want("register-options")) await shot(t, "register-options");
await t.getByText("Medium", { exact: true }).first().click();
await t.getByText("Extra cheese", { exact: true }).first().click();
await btn(t, "Add").click();
await t.getByText("Caesar Salad", { exact: true }).first().click();
await t.getByText("Lemon Mint", { exact: true }).first().click();
await t.getByText("Regular", { exact: true }).first().click().catch(() => {});
await btn(t, "Add").click().catch(() => {});
if (want("register-order")) await shot(t, "register-order");
await btn(t, "Discount").click();
if (want("register-discount")) await shot(t, "register-discount");
await t.keyboard.press("Escape");
await btn(t, "Pay").click();
if (want("register-pay")) await shot(t, "register-pay");
await t.keyboard.press("Escape");
await browser.close();
