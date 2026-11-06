-- One POS 0097: cash to bank. Every cash sale is owed to the bank: a branch's balance is its cash sales less cash refunds, less its
-- bank deposits, counted from this date (business days). What isn't deposited carries forward until it is. The float and cash
-- in / out at the till don't change it; shift shortages and overs stay with the shift. Existing branches count from 6 Nov 2026;
-- a new branch from the day it is made.
ALTER TABLE branch ADD COLUMN cash_bank_from date NOT NULL DEFAULT current_date;
UPDATE branch SET cash_bank_from = DATE '2026-11-06';

-- Amounts added to what a branch owes the bank that are not cash sales (e.g. cash held from before One POS), each with a remark.
-- Entered by hand on the database; the page shows them in their own column.
CREATE TABLE cash_bank_adjustment (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES company,
  branch_id   uuid NOT NULL REFERENCES branch,
  date        date NOT NULL,                                   -- the business day it counts on
  amount      numeric(14,2) NOT NULL CHECK (amount <> 0),      -- added to what is owed (negative: taken off)
  remark      text NOT NULL CHECK (length(trim(remark)) > 0),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cash_bank_adjustment_branch ON cash_bank_adjustment (branch_id, date);
ALTER TABLE cash_bank_adjustment ENABLE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON cash_bank_adjustment USING (company_id = (SELECT app_company_id())) WITH CHECK (company_id = (SELECT app_company_id()));
GRANT SELECT ON cash_bank_adjustment TO onepos_app;

-- European Bakery Mercato held AED 5.00 in cash from before One POS started (put in the drawer as a cash in on 6 Nov); it is owed to
-- the bank too.
INSERT INTO cash_bank_adjustment (company_id, branch_id, date, amount, remark)
  SELECT company_id, id, DATE '2026-11-06', 5.00, 'Cash balance from before One POS started' FROM branch WHERE code = 'EBL-02';
