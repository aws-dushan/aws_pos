-- One POS 0111: bank deposits posted to FACTS. Each deposit recorded on a till goes to FACTS as a posted QRV50 (Quick Receipt
-- Voucher): the bank collection account (2322) in, the outlet's cash account out. Deposits recorded before this aren't sent.

-- Per company: off, or each deposit as a posted QRV50. On for companies that already post to FACTS.
ALTER TABLE company ADD COLUMN facts_deposits text NOT NULL DEFAULT 'off' CHECK (facts_deposits IN ('off', 'qrv50'));
UPDATE company SET facts_deposits = 'qrv50' WHERE erp_connector = 'facts';

ALTER TABLE erp_post ADD COLUMN deposit_id uuid NULL REFERENCES bank_deposit;
CREATE UNIQUE INDEX erp_post_deposit ON erp_post (deposit_id) WHERE kind = 'deposit';
ALTER TABLE erp_post DROP CONSTRAINT erp_post_kind_check;
ALTER TABLE erp_post ADD CONSTRAINT erp_post_kind_check CHECK (kind IN ('invoice', 'refund', 'wastage', 'repacking', 'return', 'marketing', 'request', 'advance', 'deposit'));
