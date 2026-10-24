-- One POS 0030: digital receipts (REQ PAY-05). A paid order's receipt can carry a QR code to a public page with the receipt
-- (branch setting, off by default). The link is a long random token; this lookup (token → company and order) is read before a
-- company is known, so it has no company row-level policy. The receipt itself is then read inside the company as usual.
CREATE TABLE receipt_link (
  token       text PRIMARY KEY,
  company_id  uuid NOT NULL REFERENCES company,
  order_id    uuid NOT NULL UNIQUE REFERENCES pos_order,
  created_at  timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON receipt_link TO onepos_app;
