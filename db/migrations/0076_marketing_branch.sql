-- One POS 0076: marketing is set per branch, like wastage approval: the One POS user who approves the branch's give-aways, the
-- email requests go to, the FACTS username the approved MCV50 is posted as (one allowed MCV50 "Transaction Posting"), and the FACTS
-- expense account it debits. A branch with an approver and an account has the Marketing tab on Stock. Replaces 0075's company
-- settings (carried over to the company's branches, then dropped).
ALTER TABLE branch ADD COLUMN marketing_approver_id uuid NULL REFERENCES app_user;
ALTER TABLE branch ADD COLUMN marketing_approval_email text NULL;
ALTER TABLE branch ADD COLUMN marketing_facts_user text NULL;
ALTER TABLE branch ADD COLUMN marketing_account text NULL;

UPDATE branch b SET marketing_account = co.facts_marketing_account, marketing_facts_user = co.facts_marketing_user
FROM company co WHERE co.id = b.company_id AND co.facts_marketing_account IS NOT NULL;

ALTER TABLE company DROP COLUMN facts_marketing_account;
ALTER TABLE company DROP COLUMN facts_marketing_user;
