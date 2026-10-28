-- One POS 0080: FACTS item types per branch. The company keeps one catalogue (every type any branch uses comes in from FACTS once), and
-- each branch's menu and register show only items of its own types (e.g. Al Qusais FG + NF, Mercato FG only). Null: the company's.
ALTER TABLE branch ADD COLUMN facts_item_types text NULL;           -- comma-separated FACTS stock types, e.g. 'FG,NF'
ALTER TABLE menu_item ADD COLUMN erp_stock_type text NULL;          -- the FACTS item's stock type (STKMST_STTYPE), filled by the item sync
