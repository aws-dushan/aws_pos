-- Returns of a whole bill (the Return button): a credit note of kind 'bill', posted to FACTS as a POSTED PSR51 (point of sale
-- return) copied from the bill's POS51, where the company posts refunds so (facts_refunds = 'psr51').
ALTER TABLE credit_note DROP CONSTRAINT credit_note_kind_check;
ALTER TABLE credit_note ADD CONSTRAINT credit_note_kind_check CHECK (kind IN ('items', 'amount', 'bill'));

ALTER TABLE company DROP CONSTRAINT company_facts_refunds_check;
ALTER TABLE company ADD CONSTRAINT company_facts_refunds_check CHECK (facts_refunds IN ('none', 'sr50', 'psr51'));
