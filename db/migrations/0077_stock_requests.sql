-- One POS 0077: stock requests (STR50). An outlet asks a store for stock (any FACTS item); the request waits for the branch's request
-- approver (a One POS user, the email requests go to, the FACTS username it is posted as), who can change quantities, approve or
-- reject. Approved, it goes to FACTS at once as a POSTED STR50 from the store to the outlet (usp_ONEPOS_PostTransferRequest). The
-- stores an outlet can ask are the company's list, kept by an administrator (FACTS locations). A branch with an approver set has the
-- Requests tab on Stock (off by default).
CREATE TABLE request_store (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES company,
  code        text NOT NULL,                                     -- the FACTS location, e.g. 5ALK1
  name        text NOT NULL,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, code)
);

ALTER TABLE branch ADD COLUMN request_approver_id uuid NULL REFERENCES app_user;
ALTER TABLE branch ADD COLUMN request_approval_email text NULL;
ALTER TABLE branch ADD COLUMN request_facts_user text NULL;

CREATE TABLE stock_request (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES company,
  branch_id      uuid NOT NULL REFERENCES branch,
  number         int NOT NULL,                                   -- REQ-<number>, per branch
  business_date  date NOT NULL,
  store_code     text NOT NULL,
  store_name     text NOT NULL,
  needed_by      date NULL,
  note           text NULL,
  requested_by   uuid NOT NULL REFERENCES app_user,
  requested_at   timestamptz NOT NULL DEFAULT now(),
  approval       text NOT NULL DEFAULT 'waiting' CHECK (approval IN ('waiting', 'approved', 'rejected', 'cancelled')),
  decided_by     uuid NULL REFERENCES app_user,
  decided_at     timestamptz NULL,
  decision_note  text NULL,
  erp_post_id    uuid NULL REFERENCES erp_post,
  erp_status     text NOT NULL DEFAULT 'none' CHECK (erp_status IN ('none', 'pending', 'posted', 'failed')),
  erp_doc        text NULL,                                      -- the posted STR50, e.g. "STR50 9275"
  erp_posted_at  timestamptz NULL,
  UNIQUE (branch_id, number)
);
CREATE INDEX stock_request_branch ON stock_request (branch_id, requested_at);
CREATE INDEX stock_request_waiting ON stock_request (branch_id, requested_at) WHERE approval = 'waiting';

CREATE TABLE stock_request_line (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES company,
  request_id     uuid NOT NULL REFERENCES stock_request ON DELETE CASCADE,
  line           int NOT NULL,                                   -- its line on the STR50
  item_type      text NOT NULL,                                  -- FACTS item
  item_code      text NOT NULL,
  item_name      text NOT NULL,
  unit           text NULL,
  qty            numeric(12,3) NOT NULL CHECK (qty > 0),
  requested_qty  numeric(12,3) NULL,                             -- what was asked, when the approver changed the quantity
  UNIQUE (request_id, line)
);

ALTER TABLE request_store ENABLE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON request_store USING (company_id = (SELECT app_company_id())) WITH CHECK (company_id = (SELECT app_company_id()));
ALTER TABLE stock_request ENABLE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON stock_request USING (company_id = (SELECT app_company_id())) WITH CHECK (company_id = (SELECT app_company_id()));
ALTER TABLE stock_request_line ENABLE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON stock_request_line USING (company_id = (SELECT app_company_id())) WITH CHECK (company_id = (SELECT app_company_id()));
GRANT SELECT, INSERT, UPDATE, DELETE ON request_store, stock_request, stock_request_line TO onepos_app;

ALTER TABLE erp_post DROP CONSTRAINT erp_post_kind_check;
ALTER TABLE erp_post ADD CONSTRAINT erp_post_kind_check CHECK (kind IN ('invoice', 'refund', 'wastage', 'repacking', 'return', 'marketing', 'request'));
ALTER TABLE notice DROP CONSTRAINT IF EXISTS notice_kind_check;
ALTER TABLE notice ADD CONSTRAINT notice_kind_check CHECK (kind IN ('summary', 'alert', 'wastage', 'approval', 'return', 'request'));
