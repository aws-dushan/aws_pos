-- One POS 0009 — phase 2: approvals (REQ APR-01 … APR-04).
-- An action above the cashier's limit (a bigger discount, a refund over the limit or outside the return window, a cash out)
-- waits for someone allowed to do it: a manager's PIN on the same till, or a request a manager approves from anywhere.
-- An approval covers one action of that kind, by that cashier, up to that amount, and is used once.

CREATE TABLE approval (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES company,
  branch_id     uuid NOT NULL REFERENCES branch,
  register_id   uuid NULL REFERENCES register,
  kind          text NOT NULL CHECK (kind IN ('discount','refund','cash_out')),
  order_id      uuid NULL REFERENCES pos_order,
  shift_id      uuid NULL REFERENCES shift,
  amount        numeric(14,2) NOT NULL CHECK (amount >= 0),   -- the discount % for a discount, money otherwise
  late          boolean NOT NULL DEFAULT false,               -- a refund outside the return window (the approver needs day.manage)
  summary       text NOT NULL,
  reason        text NULL,
  requested_by  uuid NOT NULL REFERENCES app_user,
  requested_at  timestamptz NOT NULL DEFAULT now(),
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled','used')),
  via           text NULL CHECK (via IN ('pin','remote')),
  decided_by    uuid NULL REFERENCES app_user,
  decided_at    timestamptz NULL,
  note          text NULL,
  used_at       timestamptz NULL
);
CREATE INDEX approval_pending ON approval (branch_id, status, requested_at);

ALTER TABLE approval ENABLE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON approval USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON approval TO onepos_app;
