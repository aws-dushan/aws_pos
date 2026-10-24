-- One POS 0037: FACTS' document number is at most 10 characters (its accounts posting keeps 10). A bill goes to FACTS as the
-- branch's prefix and the invoice's serial (INV-EB-QS-000123 -> EBQS000123): letters first, so it never meets Polaris' all-digit
-- numbers, and unique per branch. Filled from the branch code; branches whose prefixes would clash are left to set by hand.
ALTER TABLE branch ADD COLUMN facts_doc_prefix text CHECK (facts_doc_prefix ~ '^[A-Z][A-Z0-9]{1,3}$');

UPDATE branch b SET facts_doc_prefix = p.prefix
FROM (
  SELECT id, prefix, row_number() OVER (PARTITION BY company_id, prefix ORDER BY created_at, id) AS n
  FROM (SELECT id, company_id, created_at, upper(left(regexp_replace(code, '[^A-Za-z0-9]', '', 'g'), 4)) AS prefix FROM branch) x
  WHERE prefix ~ '^[A-Z][A-Z0-9]{1,3}$'
) p
WHERE p.id = b.id AND p.n = 1;

CREATE UNIQUE INDEX branch_facts_doc_prefix ON branch (company_id, facts_doc_prefix) WHERE facts_doc_prefix IS NOT NULL;
