// Data dictionary: every table, column, type, length, key and rule, read from a database built from db/migrations.
//   node tools/docs/data-dictionary.mjs     → docs/reference/data-dictionary.md
// Needs Docker. It starts a throwaway postgres:17, applies the migrations in name order (as the API's migrator does), reads
// the catalog and removes the container, so the result is exactly what the migrations make, whatever any real database holds.
// Tables are grouped by the "Main tables by area" table in docs/03-database.md; a table missing there lands under "Other".
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { root, throwawayDb } from "./throwaway-db.mjs";

const db = throwawayDb(), psql = db.psql;
let catalog;
try {
  catalog = JSON.parse(psql(`
    with t as (select c.oid, c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
               where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relname <> 'schema_migration')
    select json_build_object(
      'migrations', ${db.migrations},
      'tables', (select json_agg(json_build_object('name', relname, 'rls', relrowsecurity,
                   'policies', (select count(*) from pg_policy p where p.polrelid = t.oid)) order by relname) from t),
      'columns', (select json_agg(json_build_object('t', t.relname, 'col', a.attname, 'type', format_type(a.atttypid, a.atttypmod),
                   'base', ty.typname, 'mod', a.atttypmod, 'notnull', a.attnotnull, 'gen', a.attgenerated,
                   'def', pg_get_expr(d.adbin, d.adrelid), 'ident', a.attidentity) order by t.relname, a.attnum)
                  from pg_attribute a join t on t.oid = a.attrelid join pg_type ty on ty.oid = a.atttypid
                  left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
                  where a.attnum > 0 and not a.attisdropped),
      'cons', (select json_agg(json_build_object('t', t.relname, 'type', k.contype, 'def', pg_get_constraintdef(k.oid),
                 'cols', (select json_agg(attname order by array_position(k.conkey, attnum)) from pg_attribute where attrelid = k.conrelid and attnum = any(k.conkey)),
                 'ref', fc.relname) order by t.relname, k.contype, k.conname)
               from pg_constraint k join t on t.oid = k.conrelid left join pg_class fc on fc.oid = k.confrelid),
      'uniq', (select json_agg(json_build_object('t', t.relname, 'def', regexp_replace(pg_get_indexdef(i.indexrelid), '^.* USING btree ', ''))
                 order by t.relname, 2)
               from pg_index i join t on t.oid = i.indrelid
               where i.indisunique and not exists (select 1 from pg_constraint k where k.conindid = i.indexrelid)),
      'idx', (select json_agg(json_build_object('t', t.relname, 'name', ic.relname, 'method', am.amname, 'unique', i.indisunique,
                 'primary', i.indisprimary, 'partial', i.indpred is not null,
                 'def', regexp_replace(pg_get_indexdef(i.indexrelid), '^.* USING ', ''),
                 'cols', (select json_agg(a.attname order by k.n) from unnest(i.indkey) with ordinality k(attnum, n)
                          left join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum))
                 order by t.relname, i.indisprimary desc, ic.relname)
               from pg_index i join t on t.oid = i.indrelid join pg_class ic on ic.oid = i.indexrelid join pg_am am on am.oid = ic.relam),
      'views', (select json_agg(c.relname order by c.relname) from pg_class c join pg_namespace n on n.oid = c.relnamespace
                where n.nspname = 'public' and c.relkind in ('v', 'm')))`));
} finally {
  db.stop();
}

// Length / size of a column: declared limits first, then a CHECK on its length, then the type's fixed storage size.
const fixed = { uuid: "16 bytes", timestamptz: "8 bytes", timestamp: "8 bytes", date: "4 bytes", bool: "1 byte", int2: "2 bytes",
  int4: "4 bytes", int8: "8 bytes", float8: "8 bytes", inet: "7 or 19 bytes", time: "8 bytes", interval: "16 bytes" };
const lengthCheck = (checks, col) => {
  for (const c of checks) {
    const re = new RegExp(`(?:char_)?length\\(\\(?${col}\\b[^)]*\\)\\)?\\s*(<=|<|BETWEEN)\\s*(\\d+)(?:\\s+AND\\s+(\\d+))?`, "i");
    const m = c.def.match(re);
    if (m) return m[1].toUpperCase() === "BETWEEN" ? `${m[2]}–${m[3]} chars` : `≤ ${m[1] === "<" ? Number(m[2]) - 1 : m[2]} chars`;
  }
  return null;
};
function size(c, checks) {
  const m = c.type.match(/^(?:character varying|character|varchar|char)\((\d+)\)/);
  if (m) return `${m[1]} chars`;
  const n = c.type.match(/^numeric\((\d+),(\d+)\)/);
  if (n) return `${n[1]} digits, ${n[2]} decimals`;
  if (c.base === "numeric") return "any precision";
  if (["text", "varchar", "bpchar", "_text"].includes(c.base)) return lengthCheck(checks, c.col) ?? "no limit";
  if (["jsonb", "json", "bytea"].includes(c.base)) return lengthCheck(checks, c.col) ?? "variable";
  return fixed[c.base] ?? "";
}
const shortDefault = (d) => !d ? "" : d.replace(/::[a-z ]+(\[\])?/g, "").replace(/^'(.*)'$/, "$1").replace(/\|/g, "\\|");
const esc = (s) => s.replace(/\|/g, "\\|");
// A CHECK in plain words: casts and outer brackets dropped, "x = ANY (ARRAY[…])" as "one of: …".
const balanced = (s) => { let d = 0; for (const ch of s) { d += ch === "(" ? 1 : ch === ")" ? -1 : 0; if (d < 0) return false; } return d === 0; };
const plain = (def) => {
  let s = def.replace(/^CHECK /, "").replace(/::[a-z ]+(\[\])?/g, "");
  while (/^\(.*\)$/.test(s) && balanced(s.slice(1, -1))) s = s.slice(1, -1);
  return s.replace(/\(?(\w+) = ANY \(ARRAY\[(.*?)\]\)\)?/g, (_, c, v) => `${c} one of: ${v.replace(/'/g, "")}`)
    .replace(/\((\w+)\)/g, "$1").replace(/>=/g, "≥").replace(/<=/g, "≤").replace(/<>/g, "≠")
    .replace(/^\((\w+) ≥ ([\d.]+)\) AND \(\1 ≤ ([\d.]+)\)$/, "$1 $2 to $3");
};
const typeName = (t) => t.replace("timestamp with time zone", "timestamptz").replace("timestamp without time zone", "timestamp")
  .replace("character varying", "varchar");

// Areas from docs/03-database.md: "| Area | `t1`, `t2`, `prefix*` |".
const dbDoc = readFileSync(join(root, "docs", "03-database.md"), "utf8");
const areas = [...dbDoc.split("## Main tables by area")[1].split("\n## ")[0].matchAll(/^\| ([^|`]+?) \| (.*`.*) \|$/gm)]
  .map((m) => ({ area: m[1].trim(), patterns: [...m[2].matchAll(/`([a-z_*]+)`/g)].map((p) => p[1]) }));
const areaOf = (t) => areas.find((a) => a.patterns.some((p) => p.endsWith("*") ? t.startsWith(p.slice(0, -1)) : p === t))?.area ?? "Other";

const by = (list, t) => (list ?? []).filter((x) => x.t === t);
const tables = catalog.tables;
const totalCols = catalog.columns.length;
let md = `# Data dictionary\n\n<!-- Generated by tools/docs/data-dictionary.mjs. Do not edit by hand. -->\n\n`;
md += `Every table made by the ${catalog.migrations} files in \`db/migrations\`: ${tables.length} tables, ${totalCols} columns. `;
md += `How the tables are normalised and why the types were chosen is in [Database](03-database.md).\n\n`;
md += `- **Type** is the PostgreSQL type. **Length** is the most a value may hold: a declared length, a CHECK on the length, the digits and decimals of a \`numeric\`, or the fixed storage size. \`text\` with "no limit" has no limit in the database (see Database → Field types and lengths).\n`;
md += `- **Allowed values** is a CHECK on that one column. Rules on several columns, and unique keys over several columns, are listed under the table.\n`;
md += `- **Null**: "no" means the column must have a value. **Key**: PK primary key, FK → the table it points at, UQ unique.\n`;
md += `- **RLS**: the table is shared by all companies and each company sees only its own rows.\n`;
md += `- **Indexes**: every index on the table, its columns in order (a partial index shows its WHERE). Why they are built this way is in Database → Indexes and speed.\n`;
// A foreign key is backed when an index starts with its columns (in any order), so deleting or joining on the parent is quick.
// A partial index counts only when its WHERE is just "column IS NOT NULL", which every lookup of a parent's rows satisfies.
const backed = (f) => by(catalog.idx, f.t).some((i) => (!i.partial || f.cols.every((c) => i.def.includes(`WHERE (${c} IS NOT NULL)`)))
  && f.cols.every((c) => i.cols.slice(0, f.cols.length).includes(c)));
const fks = catalog.cons.filter((c) => c.type === "f");
const idxStats = { indexes: catalog.idx.length, unique: catalog.idx.filter((i) => i.unique).length, partial: catalog.idx.filter((i) => i.partial).length,
  fks: fks.length, backed: fks.filter(backed).length, unbacked: fks.filter((f) => !backed(f)).map((f) => `${f.t}.${f.cols.join("+")} → ${f.ref}`) };
md += `\n${idxStats.indexes} indexes (${idxStats.unique} unique, ${idxStats.partial} partial). ${idxStats.backed} of the ${idxStats.fks} foreign keys start an index.\n`;
for (const area of [...areas.map((a) => a.area), "Other"]) {
  const list = tables.filter((t) => areaOf(t.name) === area);
  if (!list.length) continue;
  md += `\n## ${area}\n`;
  for (const t of list) {
    const cols = by(catalog.columns, t.name), cons = by(catalog.cons, t.name), checks = cons.filter((c) => c.type === "c");
    const pk = cons.find((c) => c.type === "p")?.cols ?? [];
    const key = (col) => [
      pk.includes(col) ? (pk.length > 1 ? "PK (part)" : "PK") : "",
      ...cons.filter((c) => c.type === "f" && c.cols.includes(col)).map((c) => `FK → ${c.ref}`),
      cons.some((c) => c.type === "u" && c.cols.length === 1 && c.cols[0] === col) ? "UQ" : "",
    ].filter(Boolean).join(", ");
    md += `\n### ${t.name}\n\n${t.rls ? "RLS" : "No RLS"} · ${cols.length} columns${pk.length ? ` · primary key (${pk.join(", ")})` : ""}\n\n`;
    // A CHECK on one column is shown on its row (without the column's name); one on several columns under Rules.
    const own = (col) => checks.filter((k) => k.cols?.length === 1 && k.cols[0] === col)
      .map((k) => plain(k.def).replace(new RegExp(`^${col} (?=one of|[≥≤<>=≠]|BETWEEN|IS|~|[\\d.]+ to )`), "")).join("; ");
    md += `| Column | Type | Length | Null | Default | Key | Allowed values |\n| --- | --- | --- | --- | --- | --- | --- |\n`;
    for (const c of cols)
      md += `| \`${c.col}\` | ${esc(typeName(c.type))} | ${size(c, checks)} | ${c.notnull ? "no" : "yes"} | ${c.gen === "s" ? "computed" : c.ident ? "identity" : esc(shortDefault(c.def))} | ${key(c.col)} | ${esc(own(c.col))} |\n`;
    const multi = cons.filter((c) => (c.type === "u" && c.cols.length > 1) || (c.type === "f" && c.cols.length > 1));
    const rules = [
      ...multi.map((c) => c.def),
      ...by(catalog.uniq, t.name).map((u) => `UNIQUE ${u.def}`),
      ...checks.filter((c) => c.cols?.length !== 1).map((c) => plain(c.def)),
      ...cons.filter((c) => c.type === "x").map((c) => c.def),
    ];
    if (rules.length) md += `\nRules:\n\n${rules.map((r) => `- \`${r.replace(/`/g, "'")}\``).join("\n")}\n`;
    const idx = by(catalog.idx, t.name);
    if (idx.length) md += `\nIndexes:\n\n${idx.map((i) => `- \`${i.def.replace(/^btree /, "")}\`${i.primary ? " primary key" : i.unique ? " unique" : ""}${i.method !== "btree" ? ` (${i.method})` : ""}`).join("\n")}\n`;
  }
}
if (catalog.views?.length) md += `\n## Views\n\n${catalog.views.map((v) => `\`${v}\``).join(", ")}\n`;

mkdirSync(join(root, "docs", "reference"), { recursive: true });
writeFileSync(join(root, "docs", "reference", "data-dictionary.md"), md);
console.log(`Wrote docs/reference/data-dictionary.md (${tables.length} tables, ${totalCols} columns)`);
console.log(JSON.stringify(idxStats, null, 1));
if (process.env.DICT_JSON) writeFileSync(process.env.DICT_JSON, JSON.stringify(catalog));
