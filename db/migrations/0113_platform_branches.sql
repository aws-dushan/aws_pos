-- One POS 0113: a delivery platform is switched on per branch. branch_ids lists the branches that take its orders; a branch
-- not in it doesn't see the platform at the register, on Prices or in its menu's platform prices. Existing platforms stay on at
-- every branch the company has today, so nothing changes until a branch is switched off; a new branch starts with none.
ALTER TABLE delivery_platform ADD COLUMN branch_ids uuid[] NOT NULL DEFAULT '{}';

UPDATE delivery_platform p SET branch_ids = coalesce((SELECT array_agg(b.id ORDER BY b.created_at) FROM branch b WHERE b.company_id = p.company_id), '{}');
