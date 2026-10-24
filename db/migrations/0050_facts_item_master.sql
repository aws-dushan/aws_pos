-- One POS 0050: FACTS items can be taken by item master (STKMST_DOCTYPE, e.g. SMBK = Stock Master - European Bakery) instead of
-- by division. European Bakery's café items (Café Latte, Cappuccino, …) are SMBK finished goods without a division, so the
-- division 50 filter left them out; a bakery company now takes all its SMBK finished goods, whatever their division.
ALTER TABLE company ADD COLUMN facts_item_master text NULL;   -- STKMST_DOCTYPE; null = any item master

UPDATE company SET facts_item_master = 'SMBK', facts_division = NULL
WHERE erp_connector = 'facts' AND facts_division = '50' AND facts_item_type = 'FG';
