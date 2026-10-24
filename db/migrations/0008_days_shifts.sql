-- One POS 0008 — phase 2: business days and shifts (REQ DAY-01 … DAY-10).
-- A branch sells inside an open business day; its date stays the same across midnight. Each cashier works a shift on a register
-- with its own counted float; cash in / out is recorded; the shift closes with a blind count, and the variance against what the
-- system expects is accepted within the branch's tolerance or waits for a manager's approval. The day closes with a Z report.

ALTER TABLE branch ADD COLUMN auto_open_time  time NOT NULL DEFAULT '10:00';
ALTER TABLE branch ADD COLUMN auto_close_time time NOT NULL DEFAULT '03:00';
ALTER TABLE branch ADD COLUMN variance_tolerance numeric(14,2) NOT NULL DEFAULT 5 CHECK (variance_tolerance >= 0);
ALTER TABLE branch ADD COLUMN default_float numeric(14,2) NOT NULL DEFAULT 500 CHECK (default_float >= 0);
-- What day close does with orders still open: carry them into the next day, or void those never sent to the kitchen and carry the rest.
ALTER TABLE branch ADD COLUMN open_orders_at_close text NOT NULL DEFAULT 'carry' CHECK (open_orders_at_close IN ('carry','void_unsent'));
-- Kitchen on/off per branch (a café or counter makes orders where they're paid): off = no tickets, no Send, no kitchen display.
ALTER TABLE branch ADD COLUMN kitchen_enabled boolean NOT NULL DEFAULT true;

CREATE TABLE business_day (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES company,
  branch_id   uuid NOT NULL REFERENCES branch,
  date        date NOT NULL,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  opened_at   timestamptz NOT NULL DEFAULT now(),
  opened_by   uuid NULL REFERENCES app_user,           -- null: opened automatically
  closed_at   timestamptz NULL,
  closed_by   uuid NULL REFERENCES app_user,
  z_report    jsonb NULL,
  reopened    int NOT NULL DEFAULT 0,
  UNIQUE (branch_id, date)
);
-- At most one open day per branch.
CREATE UNIQUE INDEX business_day_one_open ON business_day (branch_id) WHERE status = 'open';

CREATE TABLE shift (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES company,
  branch_id       uuid NOT NULL REFERENCES branch,
  business_day_id uuid NOT NULL REFERENCES business_day,
  register_id     uuid NOT NULL REFERENCES register,
  user_id         uuid NOT NULL REFERENCES app_user,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','needs_approval','not_counted')),
  opened_at       timestamptz NOT NULL DEFAULT now(),
  opening_float   numeric(14,2) NOT NULL CHECK (opening_float >= 0),
  float_expected  numeric(14,2) NOT NULL,
  opening_counts  jsonb NULL,
  closed_at       timestamptz NULL,
  expected_cash   numeric(14,2) NULL,
  counted_cash    numeric(14,2) NULL,
  closing_counts  jsonb NULL,
  variance        numeric(14,2) NULL,
  note            text NULL,
  approved_by     uuid NULL REFERENCES app_user,
  approved_at     timestamptz NULL,
  z_report        jsonb NULL
);
-- One open shift per person and per register.
CREATE UNIQUE INDEX shift_one_open_user ON shift (branch_id, user_id) WHERE status = 'open';
CREATE UNIQUE INDEX shift_one_open_register ON shift (register_id) WHERE status = 'open';

CREATE TABLE cash_movement (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES company,
  shift_id    uuid NOT NULL REFERENCES shift,
  kind        text NOT NULL CHECK (kind IN ('in','out','drop')),
  amount      numeric(14,2) NOT NULL CHECK (amount > 0),
  reason      text NOT NULL,
  by_user     uuid NOT NULL REFERENCES app_user,
  at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE bank_deposit (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES company,
  branch_id       uuid NOT NULL REFERENCES branch,
  business_day_id uuid NOT NULL REFERENCES business_day,
  amount          numeric(14,2) NOT NULL CHECK (amount > 0),
  bag_no          text NULL,
  taken_by        text NOT NULL,
  recorded_by     uuid NOT NULL REFERENCES app_user,
  at              timestamptz NOT NULL DEFAULT now()
);

-- Money is counted in the shift that took or paid it.
ALTER TABLE payment ADD COLUMN shift_id uuid NULL REFERENCES shift;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['business_day','shift','cash_movement','bank_deposit'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY company_isolation ON %I USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO onepos_app', t);
  END LOOP;
END $$;
