-- One POS 0022 — phase 5: gift vouchers and loyalty points (REQ CUS-02, CUS-03).
-- A voucher has a code and a balance; paying by voucher takes from its balance (part payments too); a refund can be given as a
-- new voucher (store credit). Loyalty: a customer on a paid order earns points at the company's rate; points pay (part of) a
-- bill at the company's value per point; a refund takes back the points that share of the order earned.

CREATE TABLE voucher (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES company,
  code           text NOT NULL,
  initial_value  numeric(14,2) NOT NULL CHECK (initial_value > 0),
  balance        numeric(14,2) NOT NULL CHECK (balance >= 0),
  reason         text NOT NULL CHECK (reason IN ('goodwill','promotion','sold','refund')),
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  expires_on     date NULL,
  customer_id    uuid NULL REFERENCES customer,
  note           text NULL,
  issued_branch  uuid NULL REFERENCES branch,
  issued_by      uuid NOT NULL REFERENCES app_user,
  issued_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, code)
);

CREATE TABLE voucher_move (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES company,
  voucher_id  uuid NOT NULL REFERENCES voucher,
  kind        text NOT NULL CHECK (kind IN ('issue','redeem','refund','cancel')),
  amount      numeric(14,2) NOT NULL,              -- + adds to the balance, − takes from it
  order_id    uuid NULL REFERENCES pos_order,
  branch_id   uuid NULL REFERENCES branch,
  by_user     uuid NOT NULL REFERENCES app_user,
  at          timestamptz NOT NULL DEFAULT now(),
  note        text NULL
);
CREATE INDEX voucher_move_voucher ON voucher_move (voucher_id, at);

-- Both are off until an administrator switches them on for the company.
ALTER TABLE company ADD COLUMN vouchers_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE company ADD COLUMN loyalty_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE company ADD COLUMN loyalty_points_per_unit numeric(10,4) NOT NULL DEFAULT 1 CHECK (loyalty_points_per_unit >= 0);   -- points per 1.00 spent
ALTER TABLE company ADD COLUMN loyalty_point_value numeric(10,4) NOT NULL DEFAULT 0.05 CHECK (loyalty_point_value >= 0);        -- money per point
ALTER TABLE company ADD COLUMN loyalty_min_redeem int NOT NULL DEFAULT 100 CHECK (loyalty_min_redeem >= 0);

ALTER TABLE customer ADD COLUMN points int NOT NULL DEFAULT 0;

CREATE TABLE loyalty_move (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES company,
  customer_id  uuid NOT NULL REFERENCES customer,
  kind         text NOT NULL CHECK (kind IN ('earn','redeem','reverse','refund','adjust')),
  points       int NOT NULL,                       -- + earned / given back, − spent / taken back
  order_id     uuid NULL REFERENCES pos_order,
  branch_id    uuid NULL REFERENCES branch,
  by_user      uuid NOT NULL REFERENCES app_user,
  at           timestamptz NOT NULL DEFAULT now(),
  note         text NULL
);
CREATE INDEX loyalty_move_customer ON loyalty_move (customer_id, at);

-- Paying with points, and which voucher a payment used / a refund was given as.
ALTER TABLE payment DROP CONSTRAINT payment_method_check;
ALTER TABLE payment ADD CONSTRAINT payment_method_check CHECK (method IN ('cash','card','other','voucher','account','points'));
ALTER TABLE payment ADD COLUMN voucher_id uuid NULL REFERENCES voucher;
ALTER TABLE payment ADD COLUMN points int NULL;
ALTER TABLE credit_note ADD COLUMN voucher_id uuid NULL REFERENCES voucher;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['voucher','voucher_move','loyalty_move'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY company_isolation ON %I USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO onepos_app', t);
  END LOOP;
END $$;
