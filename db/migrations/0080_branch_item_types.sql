-- One POS 0080: what is taken from FACTS is set per branch: its item types (FACTS stock types, e.g. FG, NF), item master (e.g. SMBK) and
-- division. The company keeps one catalogue (whatever any branch needs comes in from FACTS once), and each branch's menu and register
-- show only items matching its own settings. Existing branches start with the company's settings (no longer edited at company level).
ALTER TABLE branch ADD COLUMN facts_item_types text NULL;           -- comma-separated FACTS stock types, e.g. 'FG,NF'; null = FG
ALTER TABLE branch ADD COLUMN facts_item_master text NULL;          -- FACTS item master (STKMST_DOCTYPE), e.g. SMBK; null = any
ALTER TABLE branch ADD COLUMN facts_division text NULL;             -- FACTS division (STKMST_GRP11), e.g. 50; null = any
ALTER TABLE menu_item ADD COLUMN erp_stock_type text NULL;          -- the FACTS item's stock type (STKMST_STTYPE), filled by the item sync
ALTER TABLE menu_item ADD COLUMN erp_division text NULL;            -- its division (STKMST_GRP11), filled by the item sync

UPDATE branch b SET facts_item_types = co.facts_item_type, facts_item_master = co.facts_item_master, facts_division = co.facts_division
FROM company co WHERE co.id = b.company_id AND co.erp_connector = 'facts';
