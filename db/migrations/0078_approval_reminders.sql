-- One POS 0078: approval reminders. Wastage, marketing give-aways, returns and stock requests still waiting for their approver after
-- the company's hours (default 12) are emailed to that approver, all in one email, at most once every that many hours per approver,
-- and only within the sending hours (default 08:00 to 22:00, branch time). Settings live in company.alert_settings.
ALTER TABLE wastage ADD COLUMN reminded_at timestamptz NULL;          -- the last reminder that listed it
ALTER TABLE stock_return ADD COLUMN reminded_at timestamptz NULL;
ALTER TABLE stock_request ADD COLUMN reminded_at timestamptz NULL;

-- When each approver was last reminded (so they get at most one reminder in the hours set).
CREATE TABLE approval_reminder (
  company_id  uuid NOT NULL REFERENCES company,
  user_id     uuid NOT NULL REFERENCES app_user,
  sent_at     timestamptz NOT NULL,
  PRIMARY KEY (company_id, user_id)
);
ALTER TABLE approval_reminder ENABLE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON approval_reminder USING (company_id = (SELECT app_company_id())) WITH CHECK (company_id = (SELECT app_company_id()));
GRANT SELECT, INSERT, UPDATE, DELETE ON approval_reminder TO onepos_app;

ALTER TABLE notice DROP CONSTRAINT IF EXISTS notice_kind_check;
ALTER TABLE notice ADD CONSTRAINT notice_kind_check CHECK (kind IN ('summary', 'alert', 'wastage', 'approval', 'return', 'request', 'reminder'));
