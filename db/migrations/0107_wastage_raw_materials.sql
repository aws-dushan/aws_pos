-- One POS 0107: wastage and marketing of raw materials (FACTS items with no menu item).
-- Wastage and marketing of any FACTS item, not only menu items: a raw material (e.g. a carton of oat drink used in recipes)
-- has no menu item, so its line keeps the FACTS item code and item type itself. A menu item's line keeps using item_id.
ALTER TABLE wastage ALTER COLUMN item_id DROP NOT NULL;
ALTER TABLE wastage ADD COLUMN item_code text NULL;
ALTER TABLE wastage ADD COLUMN item_type text NULL;
ALTER TABLE wastage ADD CONSTRAINT wastage_item_check CHECK (item_id IS NOT NULL OR (item_code IS NOT NULL AND item_type IS NOT NULL));
