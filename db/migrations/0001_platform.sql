-- One POS 0001 — platform: companies, branches, users, roles, audit, numbering, idempotency.
-- Applied by the API's migrator as the owner role. The API itself runs as `onepos_app`,
-- which is NOT a superuser and cannot bypass Row-Level Security (same model as AWS One).

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'onepos_app') THEN
    CREATE ROLE onepos_app LOGIN PASSWORD 'onepos_app_dev' NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;

-- Current company for this transaction (set by the API with set_config(..., true)).
CREATE FUNCTION app_company_id() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.company_id', true), '')::uuid $$;

CREATE TABLE currency (
  code      char(3)  PRIMARY KEY,
  name      text     NOT NULL,
  decimals  smallint NOT NULL CHECK (decimals BETWEEN 0 AND 4)
);
INSERT INTO currency VALUES
  ('AED','UAE Dirham',2), ('SAR','Saudi Riyal',2), ('QAR','Qatari Riyal',2), ('OMR','Omani Rial',3),
  ('BHD','Bahraini Dinar',3), ('KWD','Kuwaiti Dinar',3), ('USD','US Dollar',2);

-- A company: the legal entity. Owns the menu, the roles and the ERP connection (REQ ORG-01).
CREATE TABLE company (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code               text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9]{2,10}$'),
  name               text NOT NULL CHECK (length(trim(name)) > 0),
  legal_name         text NOT NULL CHECK (length(trim(legal_name)) > 0),
  trn                text NULL,
  base_currency      char(3) NOT NULL DEFAULT 'AED' REFERENCES currency,
  vat_rate           numeric(5,2) NOT NULL DEFAULT 5 CHECK (vat_rate BETWEEN 0 AND 100),
  prices_include_vat boolean NOT NULL DEFAULT true,
  erp_connector      text NOT NULL DEFAULT 'none' CHECK (erp_connector IN ('none', 'awsone', 'facts')),
  is_active          boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- A branch: a location that sells (REQ ORG-02, ORG-03).
CREATE TABLE branch (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid NOT NULL REFERENCES company,
  code               text NOT NULL CHECK (code ~ '^[A-Z0-9-]{2,12}$'),
  name               text NOT NULL CHECK (length(trim(name)) > 0),
  address            text NULL,
  phone              text NULL,
  time_zone          text NOT NULL DEFAULT 'Asia/Dubai',
  table_service      boolean NOT NULL DEFAULT true,
  ask_guests         boolean NOT NULL DEFAULT true,
  service_charge_pct numeric(5,2) NOT NULL DEFAULT 0 CHECK (service_charge_pct BETWEEN 0 AND 100),
  receipt_header     text NULL,
  receipt_footer     text NULL,
  day_control        text NOT NULL DEFAULT 'manual' CHECK (day_control IN ('manual', 'automatic', 'cashier')),
  is_active          boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, code)
);

CREATE TABLE app_user (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username      text NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9._-]{2,40}$'),
  display_name  text NOT NULL CHECK (length(trim(display_name)) > 0),
  password_hash text NULL,
  is_admin      boolean NOT NULL DEFAULT false,
  is_active     boolean NOT NULL DEFAULT true,
  failed_logins int NOT NULL DEFAULT 0,
  locked_until  timestamptz NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- A role: named permissions + limits, per company (REQ USR-02, USR-03).
CREATE TABLE role (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES company,
  name        text NOT NULL CHECK (length(trim(name)) > 0),
  permissions text[] NOT NULL DEFAULT '{}',
  limits      jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, name)
);

-- A user's membership of a company: their role there and their till PIN.
-- The PIN is kept as an HMAC (Platform/Pins.cs), unique within the company, so a PIN alone finds its user.
CREATE TABLE user_company (
  user_id    uuid NOT NULL REFERENCES app_user ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES company ON DELETE CASCADE,
  role_id    uuid NOT NULL REFERENCES role,
  pin_lookup text NULL,
  PRIMARY KEY (user_id, company_id),
  UNIQUE (company_id, pin_lookup)
);

-- The branches a user works in (REQ USR-04).
CREATE TABLE user_branch (
  user_id   uuid NOT NULL REFERENCES app_user ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES branch ON DELETE CASCADE,
  PRIMARY KEY (user_id, branch_id)
);

-- Who did what (REQ USR-07). company_id null = platform-level (users, companies).
CREATE TABLE audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id  uuid NULL REFERENCES company,
  branch_id   uuid NULL REFERENCES branch,
  user_id     uuid NULL REFERENCES app_user,
  at          timestamptz NOT NULL DEFAULT now(),
  entity      text NOT NULL,
  entity_id   text NULL,
  action      text NOT NULL,
  data        jsonb NULL
);
CREATE INDEX audit_log_company_at ON audit_log (company_id, at DESC);

-- Numbering: one locked counter row per branch + series (allocated inside the save transaction).
CREATE TABLE number_series (
  company_id uuid NOT NULL REFERENCES company,
  branch_id  uuid NOT NULL REFERENCES branch,
  series     text NOT NULL,
  next_no    bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (branch_id, series)
);

-- Idempotency (REQ ONL-02): a write sent again with the same Idempotency-Key answers the first result and changes nothing.
CREATE TABLE idempotency_key (
  key         text PRIMARY KEY CHECK (length(key) BETWEEN 8 AND 100),
  user_id     uuid NOT NULL REFERENCES app_user,
  method      text NOT NULL,
  path        text NOT NULL,
  status_code int NULL,
  response    text NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idempotency_key_created ON idempotency_key (created_at);

-- Row-Level Security: company-owned tables are only visible for the current company.
ALTER TABLE branch        ENABLE ROW LEVEL SECURITY;
ALTER TABLE role          ENABLE ROW LEVEL SECURITY;
ALTER TABLE number_series ENABLE ROW LEVEL SECURITY;
-- Platform work (no company set) may read branches and roles (sign-in, "my branches"); company work sees its own only.
CREATE POLICY company_isolation ON branch USING (app_company_id() IS NULL OR company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());
CREATE POLICY company_isolation ON role USING (app_company_id() IS NULL OR company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());
CREATE POLICY company_isolation ON number_series USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());

GRANT SELECT ON currency TO onepos_app;
GRANT SELECT, INSERT, UPDATE ON company, branch, app_user, role TO onepos_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON user_company, user_branch TO onepos_app;
GRANT SELECT, INSERT ON audit_log TO onepos_app;
GRANT SELECT, INSERT, UPDATE ON number_series TO onepos_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON idempotency_key TO onepos_app;
