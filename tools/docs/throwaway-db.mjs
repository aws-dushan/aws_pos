// A throwaway PostgreSQL 17 in Docker with db/migrations applied in name order, as the API's migrator does.
// Used by data-dictionary.mjs and db-benchmark.mjs, so what they report is exactly what the migrations make.
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function throwawayDb(extraArgs = []) {
  const name = `onepos-docs-db-${process.pid}`;
  const docker = (args, input) => execFileSync("docker", args, { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 256 << 20 });
  const psql = (sql) => docker(["exec", "-i", name, "psql", "-v", "ON_ERROR_STOP=1", "-q", "-At", "-U", "onepos_owner", "-d", "onepos"], sql);
  docker(["run", "-d", "--rm", "--name", name, "-e", "POSTGRES_USER=onepos_owner", "-e", "POSTGRES_PASSWORD=docs", "-e", "POSTGRES_DB=onepos", ...extraArgs, "postgres:17"]);
  try {
    for (let i = 0; ; i++) {
      try { docker(["exec", name, "psql", "-U", "onepos_owner", "-d", "onepos", "-c", "select 1"]); break; }
      catch (e) { if (i > 60) throw e; execFileSync(process.execPath, ["-e", "setTimeout(()=>{},1000)"]); }
    }
    const dir = join(root, "db", "migrations");
    // UPTO=0091 stops after that migration, e.g. to time queries before a later index migration.
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql") && (!process.env.UPTO || f.slice(0, 4) <= process.env.UPTO)).sort();
    for (const f of files) {
      try { psql(`BEGIN;\n${readFileSync(join(dir, f), "utf8")}\n;COMMIT;`); }
      catch (e) { throw new Error(`Migration ${f} failed: ${e.stderr || e.message}`); }
    }
    return { psql, migrations: files.length, stop: () => { try { docker(["rm", "-f", name]); } catch { /* already gone */ } } };
  } catch (e) {
    try { docker(["rm", "-f", name]); } catch { /* already gone */ }
    throw e;
  }
}
