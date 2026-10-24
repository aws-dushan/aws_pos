-- One POS 0012 — phase 3: FACTS item and stock sync (REQ ERP-02 … ERP-05). Reads only.
-- Items come from FACTS's STOCK_MASTER (the company's item type and division), grouped by sub-category (STK_GRP2) as menu
-- categories. Prices are not taken from FACTS (to be decided): a new item waits for a price set in One POS and can't be sold
-- before. New items arrive switched off at every branch ("new from FACTS") until a manager switches them on. Stock is read per
-- branch from its FACTS location (STOCK_LOCATION_MASTER).

ALTER TABLE company ADD COLUMN facts_division text NULL;                     -- FACTS division (STKMST_GRP11), e.g. 50 = bakery; null = all
ALTER TABLE company ADD COLUMN facts_item_type text NOT NULL DEFAULT 'FG';   -- STKMST_STTYPE

ALTER TABLE menu_category ADD COLUMN erp_code text NULL;
CREATE UNIQUE INDEX menu_category_erp ON menu_category (company_id, erp_code) WHERE erp_code IS NOT NULL;

CREATE UNIQUE INDEX menu_item_erp ON menu_item (company_id, erp_item_code) WHERE erp_item_code IS NOT NULL;
ALTER TABLE menu_item ADD COLUMN erp_name      text NULL;                    -- the name in FACTS (a renamed item keeps its One POS name)
ALTER TABLE menu_item ADD COLUMN erp_unit      text NULL;
ALTER TABLE menu_item ADD COLUMN needs_price   boolean NOT NULL DEFAULT false; -- no price yet: can't be sold until one is set
ALTER TABLE menu_item ADD COLUMN erp_new       boolean NOT NULL DEFAULT false; -- arrived from FACTS, not reviewed yet
ALTER TABLE menu_item ADD COLUMN erp_removed   boolean NOT NULL DEFAULT false; -- no longer active (or sale-blocked) in FACTS
ALTER TABLE menu_item ADD COLUMN erp_synced_at timestamptz NULL;

ALTER TABLE branch_item ADD COLUMN erp_stock    numeric(14,3) NULL;          -- on hand at the branch's FACTS location
ALTER TABLE branch_item ADD COLUMN erp_stock_at timestamptz NULL;

CREATE TABLE erp_sync (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES company,
  branch_id   uuid NULL REFERENCES branch,
  kind        text NOT NULL CHECK (kind IN ('items','stock','enable_sold')),
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz NULL,
  ok          boolean NULL,
  summary     jsonb NULL,
  message     text NULL,
  by_user     uuid NULL REFERENCES app_user           -- null: the scheduled sync
);
CREATE INDEX erp_sync_recent ON erp_sync (company_id, kind, started_at DESC);

ALTER TABLE erp_sync ENABLE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON erp_sync USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON erp_sync TO onepos_app;
