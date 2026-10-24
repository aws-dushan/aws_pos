-- One POS 0032: daily summary and exception alerts (REQ DAY-10), a company setting (off by default). When a branch's day
-- closes: a summary (sales, orders, against the same day last week, cash variance, voids, refunds, no-sales, discounts,
-- wastage) and alerts where a figure is over the company's limits or a shift wasn't counted. Shown in One POS (the bell, to
-- people with reports for that branch) and, where email is set up, emailed to the company's list.
ALTER TABLE company ADD COLUMN alert_settings jsonb NOT NULL DEFAULT '{}';
ALTER TABLE company ADD COLUMN smtp_settings jsonb NULL;          -- host, port, ssl, user, from; the password protected (never returned)

CREATE TABLE notice (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES company,
  branch_id      uuid NOT NULL REFERENCES branch,
  business_date  date NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('summary','alert')),
  title          text NOT NULL,
  lines          jsonb NOT NULL DEFAULT '[]',                    -- [{ label, value, warn }]
  email_status   text NOT NULL DEFAULT 'none' CHECK (email_status IN ('none','pending','sent','failed')),
  email_error    text NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notice_company ON notice (company_id, created_at DESC);
CREATE INDEX notice_email ON notice (email_status) WHERE email_status = 'pending';

CREATE TABLE notice_read (
  company_id  uuid NOT NULL REFERENCES company,
  notice_id   uuid NOT NULL REFERENCES notice ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES app_user,
  read_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (notice_id, user_id)
);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['notice','notice_read'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY company_isolation ON %I USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO onepos_app', t);
  END LOOP;
END $$;
