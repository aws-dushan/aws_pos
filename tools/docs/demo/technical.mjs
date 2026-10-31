// Screens for the technical docs (FACTS-linked demo company, no connection) and the user manual's diagrams as pictures
// for the online manual. Demo copy only: web 3101 → API 5091.
import { chromium } from "playwright-core";
import { fileURLToPath } from "node:url";
import { readFileSync, mkdirSync } from "node:fs";
const WEB = "http://localhost:3101";
const out = fileURLToPath(new URL("./shots/", import.meta.url));
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
const opts = { viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1.5, colorScheme: "light", reducedMotion: "reduce", locale: "en-GB", timezoneId: "Asia/Dubai" };
const settle = async (page, ms = 2500) => { await page.waitForLoadState("networkidle").catch(() => {}); await page.waitForTimeout(ms); };
const shot = async (page, name) => { await settle(page); await page.screenshot({ path: out + name + ".png" }); console.log("shot", name); };
const tryStep = async (name, fn) => { try { await fn(); } catch (e) { console.log("skip", name, e.message.split("\n")[0]); } };

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

const onlyDiagrams = process.argv.includes("--diagrams");
const f = JSON.parse(readFileSync(new URL("./ids-facts.json", import.meta.url), "utf8"));
const admin = await browser.newContext(opts);
await strip(admin);
await admin.addInitScript(([c, b]) => localStorage.setItem("onepos.scope", JSON.stringify({ companyId: c, branchId: b })), [f.company, f.branch]);
const p = await admin.newPage();
await p.goto(WEB + "/login"); await settle(p, 1500);
await p.locator("input").nth(0).fill("admin");
await p.locator("input[type=password]").first().fill("Demo-2026x");
await p.keyboard.press("Enter");
await p.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60000 });
if (!onlyDiagrams) {
await tryStep("facts-posting", async () => { await p.goto(WEB + "/admin/facts-posting"); await shot(p, "tech-facts-posting"); });
await tryStep("facts-branch", async () => {
  await p.goto(WEB + "/admin/companies"); await settle(p);
  await p.getByText("Al Qusais, Dubai").first().click(); await settle(p, 1500);
  await p.getByText("FACTS stock location").first().evaluate((el) => el.scrollIntoView({ block: "start" })); await shot(p, "tech-facts-branch");
  await p.keyboard.press("Escape");
});
await tryStep("facts-connection", async () => {
  await p.goto(WEB + "/admin/companies"); await settle(p);
  await p.getByRole("button", { name: "FACTS connection" }).first().click(); await shot(p, "tech-facts-connection");
  await p.keyboard.press("Escape");
});

}

// The manual's diagrams, one picture each, for the online manual.
const md = readFileSync(new URL("../../../docs/manual/user-manual.md", import.meta.url), "utf8");
const diagrams = [...md.matchAll(/```mermaid\r?\n([\s\S]*?)```/g)].map((m) => m[1].replace(/\r/g, ""));
const d = await (await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 })).newPage();
await d.setContent(`<html><body style="margin:0;background:#fff;font-family:'Segoe UI',sans-serif"><div id="g"></div>
  <script src="https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.min.js"></script></body></html>`);
await d.waitForFunction(() => window.mermaid);
console.log("diagrams found", diagrams.length);
for (const [i, code] of diagrams.entries()) {
  await d.evaluate(async (c) => {
    mermaid.initialize({ startOnLoad: false, theme: "neutral" });
    const { svg } = await mermaid.render("m" + Date.now(), c);
    document.getElementById("g").innerHTML = `<div id="box" style="display:inline-block;padding:24px;background:#fff">${svg}</div>`;
    const el = document.querySelector("#box svg"), vb = el.viewBox.baseVal;
    el.style.maxWidth = "none"; el.setAttribute("width", vb.width); el.setAttribute("height", vb.height);
  }, code);
  await d.locator("#box").screenshot({ path: out + `diagram-${i + 1}.png` });
  console.log("diagram", i + 1);
}
await browser.close();
