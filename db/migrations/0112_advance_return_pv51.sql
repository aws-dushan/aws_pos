-- One POS 0112: a cancelled future order's advances given back, posted to FACTS. Where the company posts advances (QRV51), the
-- cancellation sends ONE PV51 (Advance Return Payment Voucher - POS) for the order: each advance's account back out, 2802 in.
-- Orders cancelled before this aren't sent.

CREATE UNIQUE INDEX erp_post_advance_return ON erp_post (order_id) WHERE kind = 'advance_return';
ALTER TABLE erp_post DROP CONSTRAINT erp_post_kind_check;
ALTER TABLE erp_post ADD CONSTRAINT erp_post_kind_check CHECK (kind IN ('invoice', 'refund', 'wastage', 'repacking', 'return', 'marketing', 'request', 'advance', 'deposit', 'advance_return'));
