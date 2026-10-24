-- One POS 0011 — phase 3: each branch's stock location in the company's ERP (FACTS). Stock is read from it, and the branch's
-- returns are posted as STV documents against it. Picked from the ERP's own list when the branch is created or edited.

ALTER TABLE branch ADD COLUMN erp_location_code text NULL;
ALTER TABLE branch ADD COLUMN erp_location_name text NULL;
-- One branch per ERP location within a company.
CREATE UNIQUE INDEX branch_erp_location ON branch (company_id, erp_location_code) WHERE erp_location_code IS NOT NULL;
