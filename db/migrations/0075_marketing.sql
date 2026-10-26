-- One POS 0075: marketing give-aways. Finished goods given away for marketing (tasting, promotion, influencers, gifts) are recorded on
-- Stock like wastage (a wastage row of kind 'marketing': the till's stock drops, the branch's wastage approver approves), but approved
-- they go to FACTS as a POSTED MCV50 at the outlet (usp_ONEPOS_PostConsumption: batch cost to the marketing expense account), not a
-- transfer to the wastage location. Switched on per company by setting that expense account; posted in FACTS as facts_marketing_user
-- (a user allowed MCV50 "Transaction Posting"), else as the branch approver's FACTS username.
ALTER TABLE wastage ADD COLUMN kind text NOT NULL DEFAULT 'wastage' CHECK (kind IN ('wastage', 'marketing'));
ALTER TABLE wastage DROP CONSTRAINT wastage_reason_check;
ALTER TABLE wastage ADD CONSTRAINT wastage_reason_check
  CHECK (reason IN ('expired','damaged','quality','returned','staff','calibration','other','tasting','promotion','influencer','gift'));

ALTER TABLE erp_post DROP CONSTRAINT erp_post_kind_check;
ALTER TABLE erp_post ADD CONSTRAINT erp_post_kind_check CHECK (kind IN ('invoice', 'refund', 'wastage', 'repacking', 'return', 'marketing'));

ALTER TABLE company ADD COLUMN facts_marketing_account text NULL;   -- FACTS expense account the MCV50 debits (e.g. 8003); null = marketing off
ALTER TABLE company ADD COLUMN facts_marketing_user text NULL;      -- FACTS user who posts it; null = the branch approver's FACTS username
