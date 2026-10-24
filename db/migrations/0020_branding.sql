-- One POS 0020 — branding: the company logo (printed at the top of receipts and credit notes, shown on screen and the
-- customer display), what a branch's receipt header shows, and the pictures the customer display shows between orders.

ALTER TABLE company ADD COLUMN logo_file text NULL;
ALTER TABLE company ADD COLUMN logo_at timestamptz NULL;
ALTER TABLE company ADD COLUMN email text NULL;
ALTER TABLE company ADD COLUMN website text NULL;

-- What the receipt header and footer show at this branch (the free header / footer lines and the language already exist):
-- {"showLogo":true,"showLegalName":true,"showAddress":true,"showPhone":true,"showTrn":true,"showEmail":false,"showWebsite":false,
--  "showCashier":true,"showCustomer":true,"showTable":true}
ALTER TABLE branch ADD COLUMN receipt_settings jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Pictures on the customer display between orders, in order, each for some seconds; for the whole company or one branch.
CREATE TABLE display_image (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES company,
  branch_id   uuid NULL REFERENCES branch,           -- null: every branch
  file        text NOT NULL,
  caption     text NULL,
  seconds     int NOT NULL DEFAULT 8 CHECK (seconds BETWEEN 3 AND 120),
  sort        int NOT NULL DEFAULT 0,
  is_active   boolean NOT NULL DEFAULT true,
  starts_on   date NULL,                             -- shown from / until (a promotion's dates), both optional
  ends_on     date NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX display_image_company ON display_image (company_id, sort);

ALTER TABLE display_image ENABLE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON display_image USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON display_image TO onepos_app;
