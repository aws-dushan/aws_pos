-- Indexes behind foreign keys whose parent the app deletes, or that are looked up from the parent side.
-- Removing an empty bill (cashier walked away, day end clean-up) checks every table pointing at the bill: erp_post only had
-- indexes for kind = 'invoice' / 'refund', so each removal read the whole posting queue, which grows by one row per bill.
CREATE INDEX IF NOT EXISTS erp_post_order ON erp_post (order_id) WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS erp_post_credit_note ON erp_post (credit_note_id) WHERE credit_note_id IS NOT NULL;
-- Adding an item when the branch blocks short stock sums what the branch sold of that item since the last FACTS stock read
-- (Orders.EnforceStockAsync): without this it read every bill line ever rung (170–220 ms on a year of 5 branches).
CREATE INDEX IF NOT EXISTS order_line_item ON order_line (item_id, order_id);
-- Option groups and floors are deleted from the menu and floor screens; their options, item links and tables are read by group / floor.
CREATE INDEX IF NOT EXISTS modifier_option_group ON modifier_option (group_id);
CREATE INDEX IF NOT EXISTS menu_item_modifier_group ON menu_item_modifier (group_id);
CREATE INDEX IF NOT EXISTS dining_table_floor ON dining_table (floor_id);
