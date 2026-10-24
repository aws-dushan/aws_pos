-- One POS 0068: discount approval codes by email. A discount request sent to a manager emails each of the branch's discount approval
-- addresses its own 6-digit code. The manager either signs in and approves, or gives the code to the cashier: typed at the till,
-- it approves a discount on that order up to the requested %, once, within 24 hours. The code is kept in plain text only until its
-- email goes out (never shown under the bell); after that only its hash is kept.
CREATE TABLE approval_code (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES company,
  approval_id uuid NOT NULL REFERENCES approval ON DELETE CASCADE,
  email       text NOT NULL,
  code        text NULL,                 -- until emailed
  code_hash   text NOT NULL,             -- sha256 of "<approval id>:<code>"
  created_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz NULL,
  used_at     timestamptz NULL
);
CREATE INDEX approval_code_approval ON approval_code (approval_id);
ALTER TABLE approval_code ENABLE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON approval_code USING (company_id = (SELECT app_company_id())) WITH CHECK (company_id = (SELECT app_company_id()));
GRANT SELECT, INSERT, UPDATE, DELETE ON approval_code TO onepos_app;

-- Approved with a code: whose email the code was sent to (there is no signed-in approver).
ALTER TABLE approval DROP CONSTRAINT IF EXISTS approval_via_check;
ALTER TABLE approval ADD CONSTRAINT approval_via_check CHECK (via IN ('pin','remote','code'));
ALTER TABLE approval ADD COLUMN approved_email text NULL;

-- The approval email of a request: sent one address at a time, each with its own code.
ALTER TABLE notice ADD COLUMN approval_id uuid NULL REFERENCES approval ON DELETE SET NULL;
