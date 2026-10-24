-- One POS 0038: a Finance role in every company: FACTS posting (log, push, re-push, wastage posted in FACTS), reports and the
-- branch dashboard. Head office roles, which have every permission, get the new one too.
INSERT INTO role (company_id, name, permissions, limits)
SELECT c.id, 'Finance', ARRAY['facts.post', 'reports.view', 'dashboard.branch'], '{"maxDiscountPct": 0, "maxRefund": 0, "maxCashOut": 0}'::jsonb
FROM company c
WHERE NOT EXISTS (SELECT 1 FROM role r WHERE r.company_id = c.id AND r.name = 'Finance');

UPDATE role SET permissions = array_append(permissions, 'facts.post')
WHERE name = 'Head office' AND NOT ('facts.post' = ANY (permissions));
