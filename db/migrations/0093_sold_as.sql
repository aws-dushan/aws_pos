-- One POS 0093: an item from FACTS is sold in one of its FACTS units ("Sold as"). Sprite is kept in LTR but sold by the can:
-- PCS, 1 = 0.33 LTR (FACTS STOCK_UNIT). Bills, returns and wastage go to FACTS in that unit and FACTS converts to its stock unit.
-- Not chosen in One POS: PCS where FACTS has a PCS unit for an item kept in another unit (as the outlet POS sells it), else the
-- stock unit. An item made from a FACTS BOM is sold in its BOM's unit (its repacking counts the bill's quantity in it).
-- menu_item.erp_unit stays the unit it is sold in and sent to FACTS; FACTS stock read into branch_item is in that unit too.
ALTER TABLE menu_item ADD COLUMN erp_stock_unit text NULL;                                          -- FACTS' stock unit (STKMST_UNIT_DOCNO)
ALTER TABLE menu_item ADD COLUMN sale_unit text NULL;                                               -- chosen in One POS (null = as above)
ALTER TABLE menu_item ADD COLUMN unit_per numeric(18,6) NOT NULL DEFAULT 1 CHECK (unit_per > 0);    -- stock units ONE erp_unit is
UPDATE menu_item SET erp_stock_unit = erp_unit WHERE erp_unit IS NOT NULL;

-- Every FACTS unit of an item: its stock unit (per_unit 1) and each conversion, with the decimals FACTS allows in it (UNIT_MASTER).
CREATE TABLE item_unit (
  company_id  uuid NOT NULL REFERENCES company,
  item_id     uuid NOT NULL REFERENCES menu_item ON DELETE CASCADE,
  unit        text NOT NULL,
  per_unit    numeric(18,6) NOT NULL CHECK (per_unit > 0),           -- how much of the stock unit ONE of it is
  decimals    int NOT NULL DEFAULT 0 CHECK (decimals BETWEEN 0 AND 3),
  PRIMARY KEY (item_id, unit)
);
ALTER TABLE item_unit ENABLE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON item_unit USING (company_id = (SELECT app_company_id())) WITH CHECK (company_id = (SELECT app_company_id()));
GRANT SELECT, INSERT, UPDATE, DELETE ON item_unit TO onepos_app;

-- The unit each bill line was sold in: a return goes to FACTS in it even after the item's "Sold as" changes.
ALTER TABLE order_line ADD COLUMN erp_unit text NULL;
UPDATE order_line l SET erp_unit = i.erp_unit FROM menu_item i WHERE i.id = l.item_id AND i.erp_unit IS NOT NULL;

-- A quantity in some FACTS unit of an item, in the unit the item is sold in now (an unknown or missing unit: already in it).
CREATE FUNCTION sold_qty(p_item uuid, p_qty numeric, p_unit text) RETURNS numeric
LANGUAGE sql STABLE AS $$
  select p_qty * coalesce((select u.per_unit from item_unit u where u.item_id = p_item and upper(u.unit) = upper(p_unit)), i.unit_per) / i.unit_per
  from menu_item i where i.id = p_item
$$;

-- 0083's wastage_held, with each wastage in the unit the item is sold in now (it was recorded in the unit of its day).
CREATE OR REPLACE FUNCTION wastage_held(p_branch uuid, p_item uuid, p_stock numeric, p_at timestamptz, p_in numeric) RETURNS numeric
LANGUAGE sql STABLE AS $$
  select coalesce((select sum(sold_qty(w.item_id, w.qty, w.unit)) from wastage w where w.item_id = p_item and w.branch_id = p_branch and w.voided_at is null
                     and w.erp_status = 'posted' and w.erp_matched_at > p_at), 0)
       + least(coalesce((select sum(sold_qty(w.item_id, w.qty, w.unit)) from wastage w where w.item_id = p_item and w.branch_id = p_branch and w.voided_at is null
                           and w.erp_status not in ('none', 'posted')), 0),
               greatest(0, p_stock - coalesce(p_in, 0)))
$$;
