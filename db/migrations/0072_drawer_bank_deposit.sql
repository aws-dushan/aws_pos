-- One POS 0072: a bank deposit taken straight from a drawer is its own cash movement ('deposit'), so every X and Z report shows it as
-- a bank deposit (it leaves the drawer's expected cash like a safe drop). The deposit record keeps the shift it came from; a deposit
-- recorded on Day & shifts (cash from the safe) has none.
ALTER TABLE cash_movement DROP CONSTRAINT IF EXISTS cash_movement_kind_check;
ALTER TABLE cash_movement ADD CONSTRAINT cash_movement_kind_check CHECK (kind IN ('in', 'out', 'drop', 'deposit'));
ALTER TABLE bank_deposit ADD COLUMN shift_id uuid NULL REFERENCES shift;
CREATE INDEX bank_deposit_shift ON bank_deposit (shift_id) WHERE shift_id IS NOT NULL;
