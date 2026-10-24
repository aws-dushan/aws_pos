-- One POS 0070: returns to the location of origin (the factory's good location). Two kinds:
--   variance: a delivery checked in with less than was sent; the difference goes back by itself to where the delivery came from.
--   manual:   the Returns tab; an item goes back to where its latest delivery came from.
-- Each line waits for the branch's wastage approver; approved, it goes to FACTS at once as a POSTED STV50 from the outlet to that
-- location (usp_ONEPOS_PostWastageTransfer: batches FIFO, FACTS' own approval, as the approver's FACTS username). Rejected or
-- cancelled, it never goes.
CREATE TABLE stock_return (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL REFERENCES company,
  branch_id         uuid NOT NULL REFERENCES branch,
  business_date     date NOT NULL,
  source            text NOT NULL CHECK (source IN ('variance', 'manual')),
  delivery_doc_type text NOT NULL,                     -- the delivery it goes back against (FACTS transfer, e.g. STV50 8114)
  delivery_doc_no   text NOT NULL,
  delivery_line     int NOT NULL,                      -- its line on that transfer
  to_location       text NOT NULL,                     -- the delivery's from-location: where it goes back to
  item_type         text NOT NULL,                     -- FACTS item
  item_code         text NOT NULL,
  item_name         text NOT NULL,
  unit              text NULL,
  qty               numeric(12,3) NOT NULL CHECK (qty > 0),
  requested_qty     numeric(12,3) NULL,                -- what was asked, when the approver changed the quantity
  reason            text NOT NULL,
  note              text NULL,
  recorded_by       uuid NOT NULL REFERENCES app_user,
  recorded_at       timestamptz NOT NULL DEFAULT now(),
  approval          text NOT NULL DEFAULT 'waiting' CHECK (approval IN ('waiting', 'approved', 'rejected', 'cancelled')),
  decided_by        uuid NULL REFERENCES app_user,
  decided_at        timestamptz NULL,
  decision_note     text NULL,
  erp_post_id       uuid NULL REFERENCES erp_post,
  erp_status        text NOT NULL DEFAULT 'none' CHECK (erp_status IN ('none', 'pending', 'posted', 'failed')),
  erp_doc           text NULL,                         -- the posted STV50
  erp_posted_at     timestamptz NULL
);
CREATE INDEX stock_return_branch ON stock_return (branch_id, recorded_at);
CREATE INDEX stock_return_delivery ON stock_return (branch_id, delivery_doc_type, delivery_doc_no);
CREATE INDEX stock_return_waiting ON stock_return (branch_id, recorded_at) WHERE approval = 'waiting';

ALTER TABLE stock_return ENABLE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON stock_return USING (company_id = (SELECT app_company_id())) WITH CHECK (company_id = (SELECT app_company_id()));
GRANT SELECT, INSERT, UPDATE, DELETE ON stock_return TO onepos_app;

ALTER TABLE erp_post DROP CONSTRAINT erp_post_kind_check;
ALTER TABLE erp_post ADD CONSTRAINT erp_post_kind_check CHECK (kind IN ('invoice', 'refund', 'wastage', 'repacking', 'return'));
ALTER TABLE notice DROP CONSTRAINT IF EXISTS notice_kind_check;
ALTER TABLE notice ADD CONSTRAINT notice_kind_check CHECK (kind IN ('summary', 'alert', 'wastage', 'approval', 'return'));
