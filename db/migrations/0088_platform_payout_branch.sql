-- One POS 0088: delivery platform payouts per branch. A payout is recorded against the header branch, so what each platform still
-- owes is worked out per branch (all branches: the sum). Payouts recorded before: assigned to the branch that took the most of that
-- platform's money in the payout's period (no period: the 31 days before it was received), else over all time, else the company's
-- first branch. The report can move a payout to another branch.
ALTER TABLE platform_payout ADD COLUMN branch_id uuid NULL REFERENCES branch;

UPDATE platform_payout x SET branch_id = coalesce(
  (select po.branch_id from payment pay join pos_order po on po.id = pay.order_id
   where po.platform_id = x.platform_id and pay.method = 'platform'
     and po.business_date between coalesce(x.period_from, x.received_on - 31) and coalesce(x.period_to, x.received_on)
   group by po.branch_id order by sum(pay.amount) desc limit 1),
  (select po.branch_id from payment pay join pos_order po on po.id = pay.order_id
   where po.platform_id = x.platform_id and pay.method = 'platform'
   group by po.branch_id order by sum(pay.amount) desc limit 1),
  (select b.id from branch b where b.company_id = x.company_id order by b.created_at limit 1));

ALTER TABLE platform_payout ALTER COLUMN branch_id SET NOT NULL;
CREATE INDEX platform_payout_branch ON platform_payout (branch_id, received_on);
