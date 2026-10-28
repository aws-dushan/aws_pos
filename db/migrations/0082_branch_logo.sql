-- One POS 0082: the logo is per branch (two brands can share one company): printed at the top of the branch's receipts and credit
-- notes and shown on its customer display. Each branch starts with the company's logo (the same file); the company columns stay
-- unused from here on.
ALTER TABLE branch ADD COLUMN logo_file text NULL;
ALTER TABLE branch ADD COLUMN logo_at timestamptz NULL;

UPDATE branch b SET logo_file = co.logo_file, logo_at = co.logo_at
FROM company co WHERE co.id = b.company_id AND co.logo_file IS NOT NULL;
