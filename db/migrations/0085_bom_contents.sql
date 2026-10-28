-- One POS 0085: an item made from a FACTS BOM can have its contents chosen at the till (e.g. a box of chocolates): the cashier
-- enters how many of each BOM material go in, up to the most the item holds. The bill's repacking (RPO50) then takes those
-- materials out instead of the BOM's fixed quantities. Materials kept in KG are counted in pieces where FACTS has a PCS unit
-- for them (STOCK_UNIT); FACTS converts back to its base unit when it posts.
ALTER TABLE menu_item ADD COLUMN bom_contents boolean NOT NULL DEFAULT false;
ALTER TABLE menu_item ADD COLUMN contents_max numeric(12,3) NULL CHECK (contents_max > 0);  -- the most it holds, in the units counted (null = any)

-- A FACTS item's alternative unit: how much of its base unit ONE of it is (Belgica: 1 PCS = 0.0125 KG), read from FACTS STOCK_UNIT.
CREATE TABLE material_unit (
  company_id  uuid NOT NULL REFERENCES company,
  item_code   text NOT NULL,
  unit        text NOT NULL,
  base_unit   text NOT NULL,
  per_unit    numeric(18,6) NOT NULL CHECK (per_unit > 0),
  synced_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, item_code, unit)
);
ALTER TABLE material_unit ENABLE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON material_unit USING (company_id = (SELECT app_company_id())) WITH CHECK (company_id = (SELECT app_company_id()));
GRANT SELECT, INSERT, UPDATE, DELETE ON material_unit TO onepos_app;
