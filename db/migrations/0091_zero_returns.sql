-- A 0.00 bill can be returned (its items back on stock, a PSR51 in FACTS): its return record totals 0.00 and isn't a tax credit note.
ALTER TABLE credit_note DROP CONSTRAINT credit_note_total_check;
ALTER TABLE credit_note ADD CONSTRAINT credit_note_total_check CHECK (total >= 0);
