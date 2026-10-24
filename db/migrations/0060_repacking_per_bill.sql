-- One POS 0060: BOM items' repacking can go to FACTS per bill, posted: each paid bill's made-to-order items as one RPO50, batches
-- given FIFO and posted by FACTS' own approval (procedure usp_ONEPOS_PostRepacking), sent just before the bill itself so the sale
-- finds the finished items' batches. 'draft' stays: the day's items as one draft RPO50 at the day's close.
ALTER TABLE company DROP CONSTRAINT IF EXISTS company_facts_repacking_check;
ALTER TABLE company ADD CONSTRAINT company_facts_repacking_check CHECK (facts_repacking IN ('off', 'draft', 'posted'));
