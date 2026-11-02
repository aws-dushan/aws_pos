// Query speed: how long the app's everyday queries take on a year of sales, and which indexes they use.
//   node tools/docs/db-benchmark.mjs        → docs/reference/query-speed.md
//   BRANCHES=5 DAYS=365 BILLS=300 (the defaults) set the size: bills per branch per day.
// Needs Docker. Builds a throwaway database from db/migrations (throwaway-db.mjs), fills it with made-up sales, then runs each
// query as the API does (role onepos_app, one company set, row-level security on) with EXPLAIN ANALYZE: once to warm the
// cache, then 5 times, keeping the middle time. Nothing touches a real database.
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { cpus, totalmem } from "node:os";
import { root, throwawayDb } from "./throwaway-db.mjs";

const BRANCHES = Number(process.env.BRANCHES ?? 5), DAYS = Number(process.env.DAYS ?? 365), BILLS = Number(process.env.BILLS ?? 300);
const CO = "00000000-0000-0000-0000-0000000000c0", USER = "00000000-0000-0000-0000-0000000000a0";

// Made-up sales shaped like the real ones (bills spread by a fixed hash, so every run builds the same data): 1–6 lines a bill, one payment, one FACTS posting, every 5th bill with a customer,
// 1 in 200 returned, 2 in 100 void. The last day's postings are still pending.
const seed = `
SET session_replication_role = replica;  -- skip the notice trigger while loading
INSERT INTO company (id, code, name, legal_name) VALUES ('${CO}', 'BENCH', 'Bench', 'Bench LLC');
INSERT INTO app_user (id, username, display_name) VALUES ('${USER}', 'bench', 'Bench');
INSERT INTO branch (id, company_id, code, name) SELECT gen_random_uuid(), '${CO}', 'B' || lpad(b::text, 2, '0'), 'Branch ' || b FROM generate_series(1, ${BRANCHES}) b;
INSERT INTO register (company_id, branch_id, code, name) SELECT company_id, id, 'T1', 'Till 1' FROM branch;
INSERT INTO menu_category (id, company_id, name) VALUES ('00000000-0000-0000-0000-0000000000d0', '${CO}', 'Food');
CREATE TEMP TABLE it AS SELECT k, gen_random_uuid() id, 'Item ' || k AS name, round((5 + random() * 45)::numeric, 2) price FROM generate_series(1, 200) k;
INSERT INTO menu_item (id, company_id, category_id, name, price) SELECT id, '${CO}', '00000000-0000-0000-0000-0000000000d0', name, price FROM it;
CREATE TEMP TABLE cu AS SELECT b.id branch_id, k, gen_random_uuid() id FROM branch b, generate_series(1, 5000) k;
INSERT INTO customer (id, company_id, branch_id, name, phone, phone_key)
  SELECT id, '${CO}', branch_id, 'Customer ' || k, '05' || lpad(k::text, 8, '0'), '05' || lpad(k::text, 8, '0') FROM cu;
CREATE INDEX ON cu (branch_id, k);
INSERT INTO business_day (company_id, branch_id, date, status)
  SELECT '${CO}', b.id, d::date, 'closed' FROM branch b, generate_series(current_date - ${DAYS - 1}, current_date, '1 day') d;
INSERT INTO shift (company_id, branch_id, business_day_id, register_id, user_id, opening_float, float_expected, status)
  SELECT bd.company_id, bd.branch_id, bd.id, r.id, '${USER}', 0, 0, 'closed' FROM business_day bd JOIN register r ON r.branch_id = bd.branch_id;
INSERT INTO pos_order (id, company_id, branch_id, register_id, business_date, number, order_type, status, subtotal, vat, total, paid,
                       vat_rate, prices_include_vat, opened_by, opened_at, closed_at, invoice_no, customer_id)
  SELECT gen_random_uuid(), '${CO}', bd.branch_id, r.id, bd.date, n, (ARRAY['dine_in', 'takeaway', 'delivery'])[1 + x.t3],
         CASE WHEN x.v THEN 'void' ELSE 'paid' END, x.amt, round(x.amt * 5 / 105, 2), x.amt, CASE WHEN x.v THEN 0 ELSE x.amt END,
         5, true, '${USER}', bd.date + time '08:00' + n * interval '2 minutes', bd.date + time '08:05' + n * interval '2 minutes',
         CASE WHEN NOT x.v THEN 'INV-' || b.code || '-' || to_char(bd.date, 'YYMMDD') || lpad(n::text, 4, '0') END, cu.id
  FROM business_day bd JOIN branch b ON b.id = bd.branch_id JOIN register r ON r.branch_id = bd.branch_id
  CROSS JOIN generate_series(1, ${BILLS}) n
  CROSS JOIN LATERAL (SELECT h, round(10 + (h % 19000) / 100.0, 2) amt, h % 3 t3, h % 50 = 7 v,
                             CASE WHEN n % 5 = 0 THEN 1 + h % 5000 END ck
                      FROM (SELECT (n * 7919 + (bd.date - date '2000-01-01') * 104729) % 1000003 AS h) hh) x
  LEFT JOIN cu ON cu.branch_id = bd.branch_id AND cu.k = x.ck;
INSERT INTO order_line (company_id, order_id, item_id, name, unit_price, qty, line_total, vat, added_by, added_at, sort)
  SELECT o.company_id, o.id, it.id, it.name, it.price, s.q, it.price * s.q, round(it.price * s.q * 5 / 105, 2), o.opened_by, o.opened_at, s.i
  FROM pos_order o
  CROSS JOIN LATERAL generate_series(1, 1 + floor(random() * 6 + o.number * 0)::int) g(i)
  CROSS JOIN LATERAL (SELECT g.i AS i, 1 + abs(hashtext(o.id::text || g.i)) % 200 k, 1 + abs(hashtext(g.i || o.id::text)) % 2 q) s
  JOIN it ON it.k = s.k;
INSERT INTO payment (company_id, branch_id, register_id, order_id, business_date, kind, method, amount, taken_by, at, shift_id)
  SELECT o.company_id, o.branch_id, o.register_id, o.id, o.business_date, 'payment', (ARRAY['cash', 'card', 'card', 'platform'])[1 + floor(random() * 4 + o.number * 0)::int],
         o.total, o.opened_by, o.closed_at, s.id
  FROM pos_order o JOIN business_day bd ON bd.branch_id = o.branch_id AND bd.date = o.business_date JOIN shift s ON s.business_day_id = bd.id
  WHERE o.status = 'paid';
INSERT INTO erp_post (company_id, branch_id, kind, order_id, doc_no, business_date, amount, xml, status, posted_at, next_try_at)
  SELECT company_id, branch_id, 'invoice', id, invoice_no, business_date, total, repeat('<Line/>', 40),
         CASE WHEN business_date = current_date THEN 'pending' ELSE 'posted' END, closed_at, closed_at
  FROM pos_order WHERE status = 'paid';
INSERT INTO credit_note (company_id, branch_id, order_id, number, business_date, kind, reason, method, total, vat, created_by)
  SELECT company_id, branch_id, id, 'CN-' || invoice_no, business_date, 'bill', 'Mistake', 'cash', total, vat, opened_by
  FROM pos_order WHERE status = 'paid' AND random() < 0.005;
INSERT INTO sales_day_item (company_id, branch_id, business_date, item_id, name, qty, sales)
  SELECT o.company_id, o.branch_id, o.business_date, l.item_id, max(l.name), sum(l.qty), sum(l.line_total)
  FROM order_line l JOIN pos_order o ON o.id = l.order_id WHERE o.status = 'paid' GROUP BY 1, 2, 3, 4;
-- Stock read from FACTS at midday today for every item at every branch (the afternoon's sales count against it), and one empty bill (as left when a cashier opens a bill and walks away).
INSERT INTO branch_item (company_id, branch_id, item_id, erp_stock, erp_stock_at) SELECT '${CO}', b.id, it.id, 100, current_date + time '12:00' FROM branch b, it;
INSERT INTO pos_order (id, company_id, branch_id, business_date, order_type, vat_rate, prices_include_vat, opened_by)
  SELECT '00000000-0000-0000-0000-0000000000e0', '${CO}', id, current_date, 'takeaway', 5, true, '${USER}' FROM branch WHERE code = 'B01';
SET session_replication_role = origin;
VACUUM ANALYZE;
`;

const db = throwawayDb(["--shm-size=1g"]);  // room for parallel hash joins while loading
let results, counts, size;
try {
  const t0 = Date.now();
  db.psql(seed);
  console.log(`Loaded in ${Math.round((Date.now() - t0) / 1000)} s`);
  const one = (sql) => db.psql(sql).trim();
  counts = JSON.parse(one(`select json_object_agg(t, n) from (select relname t, n_live_tup n from pg_stat_user_tables
    where relname in ('pos_order','order_line','payment','erp_post','customer','credit_note','sales_day_item')) x`));
  size = one(`select pg_size_pretty(pg_database_size(current_database()))`);
  const branch = one(`select id from branch where code = 'B01'`);
  const day = one(`select current_date - 1`);
  const bill = one(`select id from pos_order where branch_id = '${branch}' and business_date = '${day}' and number = ${Math.ceil(BILLS / 2)} and status = 'paid'`);
  const invoice = one(`select invoice_no from pos_order where id = '${bill}'`);
  const shift = one(`select s.id from shift s join business_day d on d.id = s.business_day_id where d.branch_id = '${branch}' and d.date = '${day}'`);
  const customer = one(`select customer_id from pos_order where customer_id is not null and branch_id = '${branch}' group by 1 order by count(*) desc limit 1`);
  const returned = one(`select order_id from credit_note limit 1`);
  const item = one(`select id from menu_item order by name limit 1`);

  // The queries, as the API runs them (shortened where the select list only adds columns, never rows or joins).
  const queries = [
    ["Till: the day's bills list", "Orders.cs GET /orders", `
      select o.*, r.name as register_name, u.display_name as opened_by_name,
             (select coalesce(sum(qty), 0) from order_line l where l.order_id = o.id and not l.is_void)::int as items
      from pos_order o left join register r on r.id = o.register_id left join app_user u on u.id = o.opened_by
      where o.branch_id = '${branch}' and o.business_date = '${day}' order by o.opened_at desc limit 500`],
    ["Till: search the day's bills", "Orders.cs GET /orders?q=", `
      select o.id, o.number, o.total from pos_order o
      where o.branch_id = '${branch}' and o.business_date = '${day}'
        and (o.number::text like '%15%' or o.customer_name ilike '%15%' or o.table_label ilike '%15%') order by o.opened_at desc limit 500`],
    ["Open a bill with its lines and payments", "Orders.cs GET /orders/{id}", `
      select (select row_to_json(o) from pos_order o where o.id = '${bill}'),
             (select json_agg(l order by l.sort) from order_line l where l.order_id = '${bill}'),
             (select json_agg(p) from payment p where p.order_id = '${bill}')`],
    ["Find a bill by its invoice number", "Finance invoices, receipts", `
      select id, total from pos_order where company_id = '${CO}' and invoice_no = '${invoice}'`],
    ["Day end X/Z: takings by payment type", "Days.cs day report", `
      select method, count(*), sum(amount) from payment
      where branch_id = '${branch}' and business_date = '${day}' and kind = 'payment' group by method`],
    ["Close a shift: its takings", "Shifts.cs", `
      select method, sum(amount) from payment where shift_id = '${shift}' group by method`],
    ["Sales report: one branch, one month", "Reports.cs Summary", `
      select count(*), sum(total), sum(vat), sum(discount_total) from pos_order
      where branch_id = '${branch}' and business_date between current_date - 30 and current_date and status in ('paid', 'refunded')`],
    ["Sales report: all branches, whole year", "Reports.cs Summary", `
      select branch_id, count(*), sum(total), sum(vat) from pos_order
      where business_date between current_date - 365 and current_date and status in ('paid', 'refunded') group by branch_id`],
    ["Item sales: all branches, whole year", "SalesSummary.cs", `
      select item_id, max(name), sum(qty), sum(sales) from sales_day_item
      where business_date between current_date - 365 and current_date group by item_id order by 4 desc limit 50`],
    ["Customer by phone number", "Customers.cs", `
      select id, name from customer where branch_id = '${branch}' and phone_key = '0500001234'`],
    ["Customer search by part of the name", "Customers.cs", `
      select id, name from customer where branch_id = '${branch}' and lower(name) like '%omer 12%' limit 50`],
    ["A customer's bills", "Customers.cs history", `
      select id, number, total, business_date from pos_order where customer_id = '${customer}' order by opened_at desc limit 50`],
    ["FACTS queue: next documents to send", "FactsPosting.cs sender", `
      select id from erp_post where status = 'pending' and next_try_at <= now() order by next_try_at limit 20`],
    ["FACTS status of a bill", "FactsPosting.cs", `
      select status from erp_post where order_id = '${bill}' and kind = 'invoice'`],
    ["Add an item: stock left (sold since the last FACTS stock read)", "Orders.cs EnforceStockAsync", `
      select bi.erp_stock - coalesce((select sum(l.qty) from order_line l join pos_order po on po.id = l.order_id
                                      where l.item_id = i.id and po.branch_id = b.id and not l.is_void
                                        and po.status in ('paid','refunded') and po.closed_at > bi.erp_stock_at), 0)
      from branch b join branch_item bi on bi.branch_id = b.id join menu_item i on i.id = bi.item_id
      where b.id = '${branch}' and i.id = '${item}'`],
    ["Remove an empty bill (with every reference checked)", "Orders.cs, Days.cs day end", `
      delete from pos_order where id = '00000000-0000-0000-0000-0000000000e0'`, true],
    ["Returns of a bill", "Returns.cs", `
      select id, number, total from credit_note where order_id = '${returned}'`],
  ];

  // A change (the delete) runs in a transaction that is rolled back, so every run finds the same rows. Its time includes
  // the foreign-key checks it fires.
  const asApp = (sql, change) => `${change ? "begin;\n" : ""}set role onepos_app; select set_config('app.company_id', '${CO}', false);
explain (analyze, buffers, format json) ${sql};${change ? "\nrollback;" : ""}`;
  const nodes = (n, out = []) => { out.push(n); (n.Plans ?? []).forEach((p) => nodes(p, out)); return out; };
  results = queries.map(([label, where, sql, change]) => {
    db.psql(asApp(sql, change));  // warm
    const runs = [...Array(5)].map(() => JSON.parse(db.psql(asApp(sql, change)).trim().split("\n").filter((l) => l.startsWith("[") || l.startsWith(" ") || l.startsWith("]") || l.startsWith("{")).join("\n"))[0]);
    const ms = runs.map((r) => r["Execution Time"] + r["Planning Time"]).sort((a, b) => a - b)[2];
    const all = nodes(runs[0].Plan);
    const used = [...new Set(all.filter((n) => n["Index Name"]).map((n) => `${n["Index Name"]}${n["Node Type"] === "Index Only Scan" ? " (index only)" : ""}`))];
    const seq = [...new Set(all.filter((n) => n["Node Type"] === "Seq Scan").map((n) => n["Relation Name"]))];
    // The slowest foreign-key check a delete fired (each is its own lookup in the table that points here).
    const fk = (runs[2].Triggers ?? []).sort((x, y) => y.Time - x.Time)[0];
    return { label, where, ms, rows: runs[0].Plan["Actual Rows"], used, seq, fk: fk && `slowest check ${fk["Constraint Name"]} ${fk.Time.toFixed(2)} ms` };
  });
} finally {
  db.stop();
}

const n = (x) => Number(x).toLocaleString("en-GB");
const fmt = (ms) => ms < 1 ? `${ms.toFixed(2)} ms` : ms < 100 ? `${ms.toFixed(1)} ms` : `${Math.round(ms)} ms`;
let md = `# Query speed\n\n<!-- Generated by tools/docs/db-benchmark.mjs. Do not edit by hand. -->\n\n`;
md += `The everyday queries of One POS timed on a database built from the migrations and filled with a year of made-up sales: `;
md += `${BRANCHES} branches × ${BILLS} bills a day × ${DAYS} days. Why the indexes are built this way is in [Database](03-database.md).\n\n`;
md += `| Table | Rows |\n| --- | --- |\n${Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([t, c]) => `| \`${t}\` | ${n(c)} |`).join("\n")}\n\n`;
md += `Database size ${size}. Run on a desktop PC (${cpus().length} threads, ${Math.round(totalmem() / 2 ** 30)} GB) with PostgreSQL 17's default settings `;
md += `(128 MB shared buffers) in Docker; the live database server has more memory. Each query runs as the API runs it: as \`onepos_app\` with row-level security on. `;
md += `**Time** is the middle of 5 runs after one warm-up, planning included, measured inside the database (the network adds about 1 ms).\n\n`;
md += `| Query | Time | Rows | Indexes used | Full table read |\n| --- | --- | --- | --- | --- |\n`;
for (const r of results)
  md += `| ${r.label}<br><small>${r.where}</small> | **${fmt(r.ms)}** | ${n(r.rows)} | ${r.used.map((u) => `\`${u}\``).join(", ") || (r.fk ? "" : "none")}${r.fk ? ` ${r.fk}` : ""} | ${r.seq.map((s) => `\`${s}\``).join(", ") || "none"} |\n`;
mkdirSync(join(root, "docs", "reference"), { recursive: true });
writeFileSync(join(root, "docs", "reference", "query-speed.md"), md);
console.log(md);
