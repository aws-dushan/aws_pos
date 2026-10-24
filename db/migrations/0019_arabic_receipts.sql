-- One POS 0019 — phase 6: Arabic on receipts (REQ UX-05). The company's Arabic legal name, the branch's Arabic name and
-- address, and per branch whether receipts are English only or English + Arabic. Each sold line keeps the item's Arabic name
-- as it was when sold (like its English name), so a reprint says the same.

ALTER TABLE company ADD COLUMN legal_name_ar text NULL;
ALTER TABLE branch ADD COLUMN name_ar text NULL;
ALTER TABLE branch ADD COLUMN address_ar text NULL;
ALTER TABLE branch ADD COLUMN receipt_language text NOT NULL DEFAULT 'bilingual' CHECK (receipt_language IN ('en','bilingual'));
ALTER TABLE order_line ADD COLUMN name_ar text NULL;
-- Lines sold before this keep working: their Arabic name comes from the item now.
UPDATE order_line l SET name_ar = i.name_ar FROM menu_item i WHERE i.id = l.item_id AND l.name_ar IS NULL AND i.name_ar IS NOT NULL;
