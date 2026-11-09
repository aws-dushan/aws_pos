-- One POS 0101: shared number series. Per company and series (INV invoices, CN credit notes) an administrator can switch on one
-- number sequence for all its branches, from a set date and time and a starting number: plain numbers (200000, 200001 …) or,
-- with a prefix, the prefix and 6 digits (CN000001, CN-000002 …). Until that
-- time, or when switched off, each branch keeps its own numbers (INV-EBL-01-000221, CN-EBL-01-000002). The counter starts at the
-- starting number with the first document after the start time and then only goes up; switched off and on again, it continues.
CREATE TABLE company_number_series (
  company_id  uuid NOT NULL REFERENCES company,
  series      text NOT NULL CHECK (series IN ('INV', 'CN')),
  shared      boolean NOT NULL DEFAULT false,
  from_at     timestamptz NULL,                        -- documents from this moment take the shared number
  prefix      text NULL CHECK (prefix ~ '^[A-Za-z0-9-]{1,8}$'),   -- null: plain numbers
  start_no    bigint NULL CHECK (start_no BETWEEN 1 AND 999999999999),
  next_no     bigint NULL,                             -- null until the first shared number is given
  first_at    timestamptz NULL,                        -- when the first shared number was given
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, series),
  CHECK (NOT shared OR (from_at IS NOT NULL AND start_no IS NOT NULL))
);
ALTER TABLE company_number_series ENABLE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON company_number_series USING (company_id = (SELECT app_company_id())) WITH CHECK (company_id = (SELECT app_company_id()));
GRANT SELECT, INSERT, UPDATE ON company_number_series TO onepos_app;
