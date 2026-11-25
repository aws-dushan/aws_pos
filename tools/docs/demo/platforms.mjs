// Delivery platforms for the manual (demo copy only): a second branch, made-up FACTS payment methods for both branches,
// platforms on at different branches, then the Delivery platforms page and the platform dialog. Run after seed.mjs.
import { chromium } from "playwright-core";
import { readFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const API = "http://localhost:5091/api";
const WEB = "http://localhost:3101";
const ids = JSON.parse(readFileSync(new URL("./ids.json", import.meta.url), "utf8"));
let cookie = "";
async function call(method, path, body) {
  const h = { "Content-Type": "application/json", Cookie: cookie, "Idempotency-Key": crypto.randomUUID(), "X-Company-Id": ids.company, "X-Branch-Id": ids.branch };
  const r = await fetch(API + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const set = r.headers.getSetCookie?.() ?? [];
  if (set.length) cookie = set.map((c) => c.split(";")[0]).join("; ");
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} ${r.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
}
await call("POST", "/auth/login", { username: "admin", password: "Demo-2026x" });

// A second branch, so the dialog has branches to choose from.
const branches = await call("GET", `/companies/${ids.company}/branches`);
const jbr = branches.find((b) => b.name === "JBR") ?? await call("POST", `/companies/${ids.company}/branches`, { code: "JBR", name: "JBR", address: "The Walk, JBR, Dubai",
  timeZone: "Asia/Dubai", tableService: false, askGuests: false, serviceChargePct: 0, dayControl: "manual", kitchenEnabled: true, returnDays: 0,
  defaultFloat: 500, varianceTolerance: 10, openOrdersAtClose: "carry", returnsEnabled: true, pickupMode: "auto" });

// Made-up FACTS payment methods for both branches (the demo has no FACTS; these only fill the dialog's choice).
const modes = [["MRN", ids.branch], ["JBR", jbr.id]].flatMap(([loc, b]) => [["CASH", "cash"], ["VISA CARD", "card"], ["Talabat", "platform"], ["Deliveroo", "platform"], ["Careem", "platform"], ["Noon", "platform"]]
  .map(([label, kind]) => `('${ids.company}','${b}','${loc}${label.replace(/ /g, "").toUpperCase()}','${loc} ${label}','${kind}','${label}')`));
execFileSync("docker", ["exec", "-i", "onepos-docs-db", "psql", "-q", "-U", "onepos_owner", "-d", "onepos"], {
  input: `insert into erp_payment_mode (company_id, branch_id, code, name, kind, label) values ${modes.join(",")} on conflict do nothing;`,
});

// Talabat and Careem at both branches, Deliveroo only at Dubai Marina, Noon Food only at JBR (greyed out at Dubai Marina).
const list = await call("GET", "/platforms");
const want = [["Talabat", 25, [ids.branch, jbr.id]], ["Deliveroo", 28, [ids.branch]], ["Careem", 22, [ids.branch, jbr.id]], ["Noon Food", 20, [jbr.id]]];
for (const [name, pct, on] of want) {
  const word = name.split(" ")[0].toUpperCase();
  const pm = Object.fromEntries(on.map((b) => [b, `${b === ids.branch ? "MRN" : "JBR"}${word}`]));
  const old = list.find((p) => p.name === name);
  const body = { name, commissionPct: pct, bankFeePct: 2.5, branchIds: on, paymentModes: pm };
  if (old) await call("PUT", `/platforms/${old.id}`, body); else await call("POST", "/platforms", body);
}

const out = fileURLToPath(new URL("./shots/", import.meta.url));
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1.5, colorScheme: "light", reducedMotion: "reduce", locale: "en-GB", timezoneId: "Asia/Dubai" });
await ctx.addInitScript(([c, b]) => { localStorage.setItem("onepos.scope", JSON.stringify({ companyId: c, branchId: b })); localStorage.setItem("onepos.reduced", "1"); }, [ids.company, ids.branch]);
const p = await ctx.newPage();
const settle = async (ms = 2500) => { await p.waitForLoadState("networkidle").catch(() => {}); await p.waitForTimeout(ms); };
await p.goto(WEB + "/login");
await settle(1000);
await p.locator("input").nth(0).fill("admin");
await p.locator("input[type=password]").first().fill("Demo-2026x");
await p.keyboard.press("Enter");
await p.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60000 });
await p.goto(WEB + "/admin/platforms");
await settle();
await p.screenshot({ path: out + "platforms.png" });
console.log("shot platforms");
await p.getByText("Talabat", { exact: true }).first().click();
await settle();
await p.screenshot({ path: out + "platform-dialog.png" });
console.log("shot platform-dialog");
await browser.close();
