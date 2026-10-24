-- One POS 0025: delivery platforms (aggregators: Talabat, Deliveroo, Careem, Noon, Keeta…), entered by hand from the platform's
-- tablet for now. A delivery order can be the platform's (its order number kept); the platform delivers, so no phone or address
-- is needed, and it pays the outlet later (payment method "platform": what the platform owes), less its commission.
CREATE TABLE delivery_platform (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES company,
  name            text NOT NULL CHECK (length(trim(name)) > 0),
  commission_pct  numeric(5,2) NOT NULL DEFAULT 0 CHECK (commission_pct BETWEEN 0 AND 100),
  is_active       boolean NOT NULL DEFAULT true,
  sort            int NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX delivery_platform_name ON delivery_platform (company_id, lower(name));

ALTER TABLE pos_order ADD COLUMN platform_id uuid NULL REFERENCES delivery_platform;
ALTER TABLE pos_order ADD COLUMN platform_ref text NULL;
ALTER TABLE pos_order ADD COLUMN platform_commission numeric(5,2) NULL;   -- the platform's rate when the order was tagged

ALTER TABLE payment DROP CONSTRAINT payment_method_check;
ALTER TABLE payment ADD CONSTRAINT payment_method_check CHECK (method IN ('cash','card','other','voucher','account','points','platform'));

ALTER TABLE delivery_platform ENABLE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON delivery_platform USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON delivery_platform TO onepos_app;
