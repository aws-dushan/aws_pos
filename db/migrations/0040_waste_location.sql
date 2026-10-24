-- One POS 0040: the branch's FACTS wastage location (e.g. WEBQS for Al Qusais). Finance moves the day's wastage there (STV
-- transfers); One POS reads those transfers and matches them to the wastage the branch recorded.
ALTER TABLE branch ADD COLUMN erp_waste_location text;

-- Which transfer line a wastage line was matched to, and when (the register's stock left counts wastage until FACTS' stock does).
ALTER TABLE wastage ADD COLUMN erp_doc_line int;
ALTER TABLE wastage ADD COLUMN erp_matched_at timestamptz;
UPDATE wastage SET erp_matched_at = recorded_at WHERE erp_status = 'posted';
