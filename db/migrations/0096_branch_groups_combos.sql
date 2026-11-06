-- One POS 0096: option groups and combos belong to one branch: the branch they are made at. Only that branch sees, sells and
-- changes them; each branch makes its own (the same name may be used at several branches). FACTS items stay shared: a group on a
-- FACTS item is asked for it only at the group's branch.
--
-- The groups and combos made so far were all made at European Bakery Mercato (EBL-02), so they all go there. In a company without
-- an EBL-02 branch they go to its first branch by code. Bills keep what was sold.
ALTER TABLE modifier_group ADD COLUMN branch_id uuid NULL REFERENCES branch;
ALTER TABLE menu_item ADD COLUMN branch_id uuid NULL REFERENCES branch;                 -- a combo's branch; null on shared items

CREATE TEMP TABLE m96_home AS
  SELECT c.id AS company_id,
         coalesce((SELECT b.id FROM branch b WHERE b.company_id = c.id AND b.code = 'EBL-02'),
                  (SELECT b.id FROM branch b WHERE b.company_id = c.id ORDER BY b.code LIMIT 1)) AS branch_id
  FROM company c;

UPDATE modifier_group g SET branch_id = h.branch_id FROM m96_home h WHERE h.company_id = g.company_id;
UPDATE menu_item i SET branch_id = h.branch_id FROM m96_home h WHERE h.company_id = i.company_id AND i.is_combo;
-- A combo is sold only at its branch.
UPDATE branch_item bi SET is_sold = false FROM menu_item i WHERE i.id = bi.item_id AND i.is_combo AND bi.branch_id <> i.branch_id;
DROP TABLE m96_home;

-- A company with groups but no branch can't keep them (none exists on the servers; a company is set up with a branch).
DELETE FROM modifier_group WHERE branch_id IS NULL;
ALTER TABLE modifier_group ALTER COLUMN branch_id SET NOT NULL;
ALTER TABLE modifier_group DROP CONSTRAINT modifier_group_company_id_name_key;
ALTER TABLE modifier_group ADD CONSTRAINT modifier_group_branch_name UNIQUE (branch_id, name);
-- New combos always have a branch (NOT VALID: a combo of a company without a branch, if any, is left as it is).
ALTER TABLE menu_item ADD CONSTRAINT menu_item_combo_branch CHECK (NOT is_combo OR branch_id IS NOT NULL) NOT VALID;
CREATE INDEX menu_item_branch ON menu_item (branch_id) WHERE branch_id IS NOT NULL;
