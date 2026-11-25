-- One POS 0114: the FACTS payment method a delivery platform's bills post with, chosen per branch (e.g. Talabat at ERBQS →
-- "ERBQS TALABAT"). Before this the posting matched the platform's first word against the branch's FACTS payment methods;
-- that match fills the choice for every branch the platform is on at, so posting goes on exactly as before.
CREATE TABLE platform_payment_mode (
  company_id   uuid NOT NULL REFERENCES company,
  platform_id  uuid NOT NULL REFERENCES delivery_platform ON DELETE CASCADE,
  branch_id    uuid NOT NULL REFERENCES branch ON DELETE CASCADE,
  mode_code    text NOT NULL,          -- erp_payment_mode.code (PM_DOCNO) at that branch
  PRIMARY KEY (platform_id, branch_id)
);

INSERT INTO platform_payment_mode (company_id, platform_id, branch_id, mode_code)
SELECT p.company_id, p.id, b.bid, m.code
FROM delivery_platform p
CROSS JOIN LATERAL unnest(p.branch_ids) AS b(bid)
CROSS JOIN LATERAL (
  SELECT x.code FROM erp_payment_mode x
  WHERE x.branch_id = b.bid AND x.kind = 'platform' AND x.label ILIKE '%' || split_part(trim(p.name), ' ', 1) || '%'
  ORDER BY x.code LIMIT 1) m;

ALTER TABLE platform_payment_mode ENABLE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON platform_payment_mode USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON platform_payment_mode TO onepos_app;
