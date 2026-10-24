-- One POS 0044: items sold, summed per branch and business day once the day is over, so a report over months or a year reads
-- one row per item per day instead of every bill line ever rung (it stays as fast in year five as in year one).
-- A day's rows are rebuilt when an item is returned from one of its bills, and dropped when the day is reopened.
CREATE TABLE sales_day_item (
  company_id    uuid NOT NULL REFERENCES company,
  branch_id     uuid NOT NULL REFERENCES branch,
  business_date date NOT NULL,
  item_id       uuid NULL,                 -- the menu item (its category is looked up when reporting)
  name          text NOT NULL,             -- the name as rung on the bill
  qty           numeric NOT NULL,          -- sold less returned
  sales         numeric NOT NULL           -- each line's share of what the bill was paid, less what was refunded on it
);
CREATE INDEX sales_day_item_day ON sales_day_item (branch_id, business_date);

-- The days summed so far (a day with no sales has a row here and none above).
CREATE TABLE sales_day_built (
  company_id    uuid NOT NULL REFERENCES company,
  branch_id     uuid NOT NULL REFERENCES branch,
  business_date date NOT NULL,
  built_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (branch_id, business_date)
);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['sales_day_item','sales_day_built'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY company_isolation ON %I USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO onepos_app', t);
  END LOOP;
END $$;
