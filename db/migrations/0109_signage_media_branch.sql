-- One POS 0109: TV pictures and videos belong to one branch. Each branch sees, uses and removes only its own uploads.
-- Existing uploads go to the branch they were added at (the audit record), else the branch of a design or TV that uses them,
-- else the company's first branch. Files and ids stay the same, so what TVs play now does not change.
ALTER TABLE signage_media ADD COLUMN branch_id uuid NULL REFERENCES branch ON DELETE CASCADE;

UPDATE signage_media m SET branch_id = coalesce(
  (SELECT a.branch_id FROM audit_log a
     WHERE a.company_id = m.company_id AND a.entity = 'signage_media' AND a.entity_id = m.id::text AND a.action = 'created' AND a.branch_id IS NOT NULL
     ORDER BY a.at LIMIT 1),
  (SELECT d.branch_id FROM signage_design d
     WHERE d.company_id = m.company_id AND d.branch_id IS NOT NULL AND position(m.id::text IN d.content::text) > 0
     ORDER BY d.created_at LIMIT 1),
  (SELECT s.branch_id FROM signage_screen s JOIN signage_design d ON d.id = s.design_id
     WHERE s.company_id = m.company_id AND position(m.id::text IN d.content::text) > 0
     ORDER BY s.created_at LIMIT 1),
  (SELECT b.id FROM branch b WHERE b.company_id = m.company_id ORDER BY b.created_at LIMIT 1));

DELETE FROM signage_media WHERE branch_id IS NULL;   -- only a company without branches; nothing can use it
ALTER TABLE signage_media ALTER COLUMN branch_id SET NOT NULL;

DROP INDEX signage_media_company;
CREATE INDEX signage_media_branch ON signage_media (branch_id, created_at);
