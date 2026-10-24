-- One POS 0039: which FACTS procedure saves a bill. Empty: FACTS' own usp_FQAPI_PWA_POS_SaveInvoice (as the outlet POS, no
-- batches). usp_ONEPOS_SaveInvoice: the same, then each line its batch FIFO (db/facts/usp_ONEPOS_SaveInvoice.sql).
ALTER TABLE company ADD COLUMN facts_invoice_proc text;

-- What the procedure said about batches for a bill (lines given one, lines left without).
ALTER TABLE erp_post ADD COLUMN batch_note text;
