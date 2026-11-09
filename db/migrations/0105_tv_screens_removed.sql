-- One POS 0105: TV screens (digital signage) is removed: its tables and the branch switch go. Picture and video files under
-- data/images/<company>/signage-* are no longer used.
DROP TABLE IF EXISTS signage_screen;
DROP TABLE IF EXISTS signage_device;
DROP TABLE IF EXISTS signage_design;
DROP TABLE IF EXISTS signage_media;
ALTER TABLE branch DROP COLUMN IF EXISTS signage_enabled;
