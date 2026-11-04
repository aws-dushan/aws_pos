-- One POS 0094: "Sold as" (0093) is only what is chosen on the item; nothing is picked by itself. Items the sync switched to PCS
-- by itself go back to FACTS' stock unit, and their FACTS stock already read back into it. Items made from a FACTS BOM keep
-- the BOM's unit. Bill lines keep the unit they were sold in (order_line.erp_unit).
WITH back AS (
  SELECT i.id, i.unit_per AS old_per, u.decimals
  FROM menu_item i JOIN item_unit u ON u.item_id = i.id AND upper(u.unit) = upper(i.erp_stock_unit)
  WHERE i.sale_unit IS NULL AND i.erp_unit IS DISTINCT FROM i.erp_stock_unit
    AND NOT EXISTS (SELECT 1 FROM bom b WHERE b.item_code = i.erp_item_code AND b.item_type = i.erp_item_type
                      AND (b.ended_from IS NULL OR b.ended_from > current_date))
), items AS (
  UPDATE menu_item i SET erp_unit = i.erp_stock_unit, unit_per = 1, qty_decimals = b.decimals
  FROM back b WHERE b.id = i.id
  RETURNING i.id, b.old_per
)
UPDATE branch_item bi SET erp_stock = round(bi.erp_stock * it.old_per, 3), erp_in_since_waste = round(bi.erp_in_since_waste * it.old_per, 3)
FROM items it WHERE bi.item_id = it.id;
