-- One POS 0062: delivery platform prices from FACTS. A platform is linked to its FACTS customer (e.g. Talabat = AR-D0005); its
-- items' prices are that customer's prices in FACTS: the price type on the customer account (ACMST_PRICE_TYPE_DOCNO), read with
-- the regular price sync. A delivery bill for a linked platform is rung up at those prices (dine-in, takeaway and own delivery
-- keep the outlet's); an item FACTS has no price for on that platform can't be sold on it. Bills post to FACTS as before.
ALTER TABLE delivery_platform ADD COLUMN facts_customer text NULL;        -- FACTS customer account, e.g. AR-D0005
ALTER TABLE delivery_platform ADD COLUMN facts_customer_name text NULL;
ALTER TABLE delivery_platform ADD COLUMN facts_price_type text NULL;      -- the customer's price type at the last sync (e.g. E-com)
ALTER TABLE delivery_platform ADD COLUMN facts_price_at timestamptz NULL; -- when its prices were last read

-- The platform's price per item, as in FACTS (before VAT is added where the branch's FACTS prices are before VAT).
CREATE TABLE platform_item_price (
  company_id   uuid NOT NULL REFERENCES company,
  platform_id  uuid NOT NULL REFERENCES delivery_platform ON DELETE CASCADE,
  item_id      uuid NOT NULL REFERENCES menu_item ON DELETE CASCADE,
  facts_price  numeric(14,4) NOT NULL CHECK (facts_price > 0),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (platform_id, item_id)
);
ALTER TABLE platform_item_price ENABLE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON platform_item_price USING (company_id = (SELECT app_company_id())) WITH CHECK (company_id = (SELECT app_company_id()));
GRANT SELECT, INSERT, UPDATE, DELETE ON platform_item_price TO onepos_app;

-- Price history covers platform prices too (branch null, platform set).
ALTER TABLE item_price_history ADD COLUMN platform_id uuid NULL REFERENCES delivery_platform ON DELETE CASCADE;
