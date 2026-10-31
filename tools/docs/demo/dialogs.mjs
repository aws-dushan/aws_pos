// Extra dialogs for the manual (demo copy only). Dialogs are opened and photographed, never confirmed.
import { chromium } from "playwright-core";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
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
const out = fileURLToPath(new URL("./shots/", import.meta.url));
const browser = await chromium.launch({ executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
const opts = { viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1.5, colorScheme: "light", reducedMotion: "reduce", locale: "en-GB", timezoneId: "Asia/Dubai" };
const settle = async (page, ms = 1500) => { await page.waitForLoadState("networkidle").catch(() => {}); await page.waitForTimeout(ms); };
const shot = async (page, name, ms) => { await settle(page, ms); await page.screenshot({ path: out + name + ".png" }); console.log("shot", name); };
const btn = (page, name) => page.getByRole("button", { name, exact: false }).first();
const tryStep = async (name, fn) => { try { await fn(); } catch (e) { console.log("skip", name, e.message.split("\n")[0]); } };

const admin = await browser.newContext(opts);
await stripSignature(admin);
await admin.addInitScript(([c, b]) => localStorage.setItem("onepos.scope", JSON.stringify({ companyId: c, branchId: b })), [ids.company, ids.branch]);
const p = await admin.newPage();
await p.goto(WEB + "/login");
await settle(p);
await p.locator("input").nth(0).fill("admin");
await p.locator("input[type=password]").first().fill("Demo-2026x");
await p.keyboard.press("Enter");
await p.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60000 });

await tryStep("tables", async () => { await p.goto(WEB + "/tables"); await shot(p, "tables", 4000); });
await tryStep("branch-settings", async () => {
  await p.goto(WEB + "/admin/companies"); await settle(p, 2500);
  await p.getByText("Marina Walk, Dubai").first().click(); await shot(p, "branch-settings");
  await p.keyboard.press("Escape");
});
await tryStep("user-dialog", async () => {
  await p.goto(WEB + "/admin/users"); await settle(p, 2500);
  await p.getByText("Sara Ahmed", { exact: true }).first().click(); await shot(p, "user-dialog");
  await p.keyboard.press("Escape");
});
await tryStep("menu-item", async () => {
  await p.goto(WEB + "/menu"); await settle(p, 2500);
  await p.getByText("Edit", { exact: true }).first().click(); await shot(p, "menu-item");
  await p.keyboard.press("Escape");
});
await tryStep("booking", async () => {
  await p.goto(WEB + "/reservations"); await settle(p, 2500);
  await btn(p, "New booking").click(); await shot(p, "booking");
  await p.keyboard.press("Escape");
});
await tryStep("orders-return", async () => {
  await p.goto(WEB + "/orders"); await settle(p, 2500);
  await btn(p, "Return").click(); await shot(p, "orders-return");
  await p.keyboard.press("Escape");
});

// Sara on Till 1: her shift's dialogs
const till = await browser.newContext(opts);
await stripSignature(till);
await till.addInitScript(([c, b, r]) => { localStorage.setItem("onepos.till.branch", b); localStorage.setItem("onepos.till.register", r); localStorage.setItem(`onepos.register.${b}`, r);
  localStorage.setItem("onepos.scope", JSON.stringify({ companyId: c, branchId: b })); }, [ids.company, ids.branch, ids.register]);
const t = await till.newPage();
await t.goto(WEB + "/till"); await settle(t, 2500);
for (const d of "2580") await t.getByRole("button", { name: d, exact: true }).click();
await btn(t, "Sign in").click().catch(() => {});
await t.waitForURL((u) => !u.pathname.startsWith("/till"), { timeout: 60000 }).catch(() => {});
await tryStep("cash", async () => { await t.goto(WEB + "/day"); await settle(t, 2500); await btn(t, "Cash in / out").click(); await shot(t, "cash-dialog"); await t.keyboard.press("Escape"); });
await tryStep("close-shift", async () => { await t.goto(WEB + "/day"); await settle(t, 2500); await btn(t, "Close shift").click(); await shot(t, "close-shift"); await t.keyboard.press("Escape"); });
await tryStep("x-report", async () => { await t.goto(WEB + "/day"); await settle(t, 2500); await btn(t, "X report").click(); await shot(t, "x-report"); await t.keyboard.press("Escape"); });
await browser.close();
