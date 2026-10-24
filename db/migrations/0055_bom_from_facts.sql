-- One POS 0055: BOMs come from FACTS — the outlet bills of materials (BOMO50, "Bill of Materials Outlet - Bakery"), read with the
-- regular FACTS sync. Each item takes its newest BOMO50, as quantities for one unit; when FACTS changes it, a new version starts
-- that day (days already sent to FACTS keep the version they were sent with). One POS shows them; finance changes them in FACTS.
ALTER TABLE bom ADD COLUMN facts_doc text NULL;            -- e.g. "BOMO50 1004"
ALTER TABLE bom ADD COLUMN synced_at timestamptz NULL;
ALTER TABLE bom ALTER COLUMN created_by DROP NOT NULL;     -- null: made by the FACTS sync
ALTER TABLE bom_version ALTER COLUMN created_by DROP NOT NULL;

ALTER TABLE erp_sync DROP CONSTRAINT erp_sync_kind_check;
ALTER TABLE erp_sync ADD CONSTRAINT erp_sync_kind_check CHECK (kind IN ('items','stock','enable_sold','payment_modes','prices','boms'));
