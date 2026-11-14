-- One POS 0110: future orders - taken now with an advance, collected (and invoiced) on a later day.
-- A future order is an order with a collection time. While it waits, every payment on it is an advance: it counts in the shift
-- and day it was taken, and the order stays open even when paid in full. Collecting moves the order to that day; the balance is
-- paid as usual and the bill is invoiced then. Cancelling refunds the advances and voids the order.

-- Per branch: the Future orders page is on or off.
ALTER TABLE branch ADD COLUMN future_orders boolean NOT NULL DEFAULT false;

-- Per company: advances posted to FACTS (off: the bill takes them as normal payments; qrv51: each advance as a QRV51 to
-- POS customer advances, the bill then paid by ADVANCE).
ALTER TABLE company ADD COLUMN facts_advances text NOT NULL DEFAULT 'off' CHECK (facts_advances IN ('off', 'qrv51'));

ALTER TABLE pos_order ADD COLUMN collect_at timestamptz NULL;
ALTER TABLE pos_order ADD COLUMN future_status text NULL CHECK (future_status IN ('waiting', 'collected', 'cancelled'));
ALTER TABLE pos_order ADD COLUMN future_ref text NULL;          -- FO-<branch>-000001, the number the customer is given
CREATE INDEX pos_order_future ON pos_order (branch_id, collect_at) WHERE future_status IS NOT NULL;

-- An advance (and an advance given back on cancelling): its own number (ADV-<branch>-000001), the document FACTS gets.
ALTER TABLE payment ADD COLUMN is_advance boolean NOT NULL DEFAULT false;
ALTER TABLE payment ADD COLUMN advance_no text NULL;

ALTER TABLE erp_post ADD COLUMN payment_id uuid NULL REFERENCES payment;
CREATE UNIQUE INDEX erp_post_advance ON erp_post (payment_id) WHERE kind = 'advance';
ALTER TABLE erp_post DROP CONSTRAINT erp_post_kind_check;
ALTER TABLE erp_post ADD CONSTRAINT erp_post_kind_check CHECK (kind IN ('invoice', 'refund', 'wastage', 'repacking', 'return', 'marketing', 'request', 'advance'));
