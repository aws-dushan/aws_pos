-- One POS 0028: delivery platform payouts, a company setting (off: payouts are reconciled elsewhere, e.g. in the ERP).
-- On: each payout the platform sends is recorded (amount received, the commission it kept, its statement reference); what a
-- platform still owes = what its orders were paid "by the platform" − received − commission kept, company-wide, to date.
ALTER TABLE company ADD COLUMN platform_payouts boolean NOT NULL DEFAULT false;

CREATE TABLE platform_payout (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES company,
  platform_id   uuid NOT NULL REFERENCES delivery_platform,
  received_on   date NOT NULL,
  period_from   date NULL,
  period_to     date NULL,
  amount        numeric(14,2) NOT NULL CHECK (amount > 0),        -- paid into the bank
  commission    numeric(14,2) NOT NULL DEFAULT 0 CHECK (commission >= 0),   -- kept by the platform, per its statement
  reference     text NULL,
  note          text NULL,
  recorded_by   uuid NOT NULL REFERENCES app_user,
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  voided_at     timestamptz NULL,
  voided_by     uuid NULL REFERENCES app_user,
  CHECK (period_from IS NULL OR period_to IS NULL OR period_from <= period_to)
);
CREATE INDEX platform_payout_platform ON platform_payout (platform_id, received_on);

ALTER TABLE platform_payout ENABLE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON platform_payout USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON platform_payout TO onepos_app;
