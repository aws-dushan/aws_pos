-- One POS 0015 — phase 4: customers (REQ CUS-01 … CUS-04). Optional on every order. A customer is found by phone at the
-- register (or attached by name); a paid order with a new phone number and a name creates one. Visits and spend come from
-- their paid orders.

CREATE TABLE customer (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES company,
  name        text NOT NULL CHECK (length(trim(name)) > 0),
  phone       text NULL,                       -- as entered
  phone_key   text NULL,                       -- digits, UAE numbers as 05XXXXXXXX: what lookups match on
  email       text NULL,
  address     text NULL,
  notes       text NULL,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid NULL REFERENCES app_user
);
CREATE UNIQUE INDEX customer_phone ON customer (company_id, phone_key) WHERE phone_key IS NOT NULL;
CREATE INDEX customer_name ON customer (company_id, lower(name));

ALTER TABLE pos_order ADD COLUMN customer_id uuid NULL REFERENCES customer;
CREATE INDEX pos_order_customer ON pos_order (customer_id) WHERE customer_id IS NOT NULL;

ALTER TABLE customer ENABLE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON customer USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON customer TO onepos_app;
