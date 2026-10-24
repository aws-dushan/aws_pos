-- One POS 0066: wastage reason "Machine calibration" (e.g. espresso shots poured to set the grinder). Like every wastage it comes
-- off the outlet's stock and goes to FACTS as a transfer to the wastage location; only the reason is new.
ALTER TABLE wastage DROP CONSTRAINT wastage_reason_check;
ALTER TABLE wastage ADD CONSTRAINT wastage_reason_check CHECK (reason IN ('expired','damaged','quality','returned','staff','calibration','other'));
