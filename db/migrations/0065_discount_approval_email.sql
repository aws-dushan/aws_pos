-- One POS 0065: discount approval by email. Per branch: the addresses a discount request goes to when the cashier sends it to a
-- manager (no PIN at the till). It is also under the bell and on the Approvals page, as before. Empty: no email, as before.
ALTER TABLE branch ADD COLUMN discount_approval_emails text[] NULL;

ALTER TABLE notice DROP CONSTRAINT IF EXISTS notice_kind_check;
ALTER TABLE notice ADD CONSTRAINT notice_kind_check CHECK (kind IN ('summary', 'alert', 'wastage', 'approval'));
