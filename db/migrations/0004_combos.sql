-- One POS 0004 — combos and set menus (REQ REG-03). A combo is a menu item marked is_combo whose option groups offer other menu
-- items (modifier_option.item_id): "Choose a main", "Choose a drink". The chosen component keeps its item, so the kitchen ticket
-- goes to that item's station (phase 2) and stock comes off for that item (phase 3).
ALTER TABLE menu_item ADD COLUMN is_combo boolean NOT NULL DEFAULT false;
ALTER TABLE modifier_option ADD COLUMN item_id uuid NULL REFERENCES menu_item;
