-- One POS 0097: cash to bank. Every cash sale is owed to the bank: a branch's balance is its cash sales less cash refunds, less its
-- bank deposits, counted from this date (business days). What isn't deposited carries forward until it is. The float and cash
-- paid out at the till don't change it; shift shortages and overs stay with the shift. Existing branches count from 6 Nov 2026;
-- a new branch from the day it is made.
ALTER TABLE branch ADD COLUMN cash_bank_from date NOT NULL DEFAULT current_date;
UPDATE branch SET cash_bank_from = DATE '2026-11-06';
