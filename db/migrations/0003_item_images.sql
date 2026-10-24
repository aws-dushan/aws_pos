-- One POS 0003 — menu item photos (shown on the register tiles). The file lives on disk (config Images:Root, else data/images);
-- image_at changes with every upload, so the address changes and no till shows a stale cached photo.
ALTER TABLE menu_item ADD COLUMN image_file text NULL;
ALTER TABLE menu_item ADD COLUMN image_at timestamptz NULL;
