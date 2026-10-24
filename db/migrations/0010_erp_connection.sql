-- One POS 0010 — phase 3 groundwork: each company's ERP connection (REQ ERP-01).
-- The connection string is set by an administrator in Companies & branches and kept encrypted (ASP.NET Data Protection);
-- the browser only ever sees a summary (server, database, login), never the secret.

CREATE TABLE company_erp (
  company_id    uuid PRIMARY KEY REFERENCES company,
  secret        text NOT NULL,                 -- the protected connection string
  summary       text NOT NULL,                 -- "server · database · login", safe to show
  updated_by    uuid NOT NULL REFERENCES app_user,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  tested_at     timestamptz NULL,
  test_ok       boolean NULL,
  test_message  text NULL
);

ALTER TABLE company_erp ENABLE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON company_erp USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON company_erp TO onepos_app;
