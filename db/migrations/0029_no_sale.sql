-- One POS 0029: no-sale (REQ HW-04, RPT-03). Opening the cash drawer without a sale needs pos.nosale and a reason; each one is
-- kept (who, which till and shift, when, why) for the exceptions report and the day's Z report.
CREATE TABLE no_sale (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES company,
  branch_id      uuid NOT NULL REFERENCES branch,
  register_id    uuid NULL REFERENCES register,
  shift_id       uuid NULL REFERENCES shift,
  business_date  date NOT NULL,
  reason         text NOT NULL CHECK (length(trim(reason)) > 0),
  by_user        uuid NOT NULL REFERENCES app_user,
  at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX no_sale_day ON no_sale (branch_id, business_date);

ALTER TABLE no_sale ENABLE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON no_sale USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON no_sale TO onepos_app;
