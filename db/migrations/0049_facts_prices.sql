-- One POS 0049: outlet prices from FACTS. Each outlet has its own FACTS price type (Price Type Master, MSTR/PTM) holding the
-- price of each item there (STOCK_PRICE). A branch with a price type takes its FACTS items' prices only from FACTS: they
-- can't be changed in One POS, and an item FACTS has no price for can't be sold there. Every price change is kept
-- (item_price_history); bills already rung up keep the price they were sold at (order_line.unit_price).

ALTER TABLE branch ADD COLUMN facts_price_type         text NULL;                -- PTM code in FACTS (STKPRICE_PRICE_DOCNO)
ALTER TABLE branch ADD COLUMN facts_prices_include_vat boolean NOT NULL DEFAULT true; -- false: FACTS prices are before VAT

ALTER TABLE branch_item ADD COLUMN erp_priced   boolean NOT NULL DEFAULT false;  -- the price here comes from FACTS (null = none there)
ALTER TABLE branch_item ADD COLUMN erp_price_at timestamptz NULL;                -- when FACTS' price was last read

CREATE TABLE item_price_history (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES company,
  branch_id  uuid NULL REFERENCES branch,                  -- null: the company price
  item_id    uuid NOT NULL REFERENCES menu_item ON DELETE CASCADE,
  old_price  numeric(14,2) NULL,                           -- null: no price
  new_price  numeric(14,2) NULL,
  source     text NOT NULL CHECK (source IN ('facts','manual')),
  facts_price numeric(14,4) NULL,                          -- the price as in FACTS (before VAT is added, where it is)
  changed_at timestamptz NOT NULL DEFAULT now(),
  changed_by uuid NULL REFERENCES app_user                 -- null: the scheduled sync
);
CREATE INDEX item_price_history_item ON item_price_history (company_id, item_id, changed_at DESC);

ALTER TABLE item_price_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON item_price_history USING (company_id = (SELECT app_company_id())) WITH CHECK (company_id = (SELECT app_company_id()));
GRANT SELECT, INSERT ON item_price_history TO onepos_app;

ALTER TABLE erp_sync DROP CONSTRAINT erp_sync_kind_check;
ALTER TABLE erp_sync ADD CONSTRAINT erp_sync_kind_check CHECK (kind IN ('items','stock','enable_sold','payment_modes','prices'));
