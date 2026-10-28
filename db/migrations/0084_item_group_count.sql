-- One POS 0084: how many to choose from an option group can be set per item it is attached to, so one group (e.g. Wrapped Chocolate
-- for Box) serves every box: the box of 12 asks for 12, the box of 6 for 6. Null = the group's own least and most.
ALTER TABLE menu_item_modifier ADD COLUMN min_select int NULL CHECK (min_select >= 0);
ALTER TABLE menu_item_modifier ADD COLUMN max_select int NULL CHECK (max_select >= 1);
ALTER TABLE menu_item_modifier ADD CONSTRAINT menu_item_modifier_count CHECK (max_select IS NULL OR min_select IS NULL OR max_select >= min_select);
