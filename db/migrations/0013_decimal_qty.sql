-- One POS 0013 — decimal quantities (REQ REG-07): half a cake, 0.350 kg of bread. FACTS allows decimals per unit
-- (UNIT_MASTER.UNIT_DECIMAL); an item takes its unit's decimals (0 = whole units only, as for items made in One POS).

ALTER TABLE order_line ALTER COLUMN qty TYPE numeric(12,3);
ALTER TABLE order_line ALTER COLUMN sent_qty TYPE numeric(12,3);
ALTER TABLE order_line ALTER COLUMN returned_qty TYPE numeric(12,3);
ALTER TABLE kitchen_ticket_line ALTER COLUMN qty TYPE numeric(12,3);
ALTER TABLE credit_note_line ALTER COLUMN qty TYPE numeric(12,3);

ALTER TABLE menu_item ADD COLUMN qty_decimals int NOT NULL DEFAULT 0 CHECK (qty_decimals BETWEEN 0 AND 3);
