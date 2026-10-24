-- One POS 0045: reports over a month or a year answered from the index alone (no reading of the bill rows themselves): the sales
-- summary, by day, hour, order type and branch from pos_order, by method and by cashier from payment (company_id included: the company check of
-- row-level security reads it too). A year of a busy branch: ~90 ms -> ~25 ms each.
CREATE INDEX pos_order_report ON pos_order (branch_id, business_date)
  INCLUDE (company_id, status, order_type, total, vat, discount_total, service_charge, guests, refunded, closed_at);
CREATE INDEX payment_report ON payment (branch_id, business_date) INCLUDE (company_id, kind, method, amount, taken_by);

-- Index-only reads need the table's pages marked all-visible by vacuum; on these always-growing tables it runs after every 2%
-- of new rows (Postgres' default waits for 20%, which on years of history means months of bills read the slow way).
ALTER TABLE pos_order SET (autovacuum_vacuum_insert_scale_factor = 0.02, autovacuum_vacuum_scale_factor = 0.02);
ALTER TABLE payment SET (autovacuum_vacuum_insert_scale_factor = 0.02, autovacuum_vacuum_scale_factor = 0.02);
ALTER TABLE order_line SET (autovacuum_vacuum_insert_scale_factor = 0.02, autovacuum_vacuum_scale_factor = 0.02);
