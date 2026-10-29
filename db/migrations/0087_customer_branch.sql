-- One POS 0087: customers per branch. Each branch has its own customers: the register finds, and a paid order creates, a customer
-- of the order's branch only, and the Customers page lists the header branch's. The same phone can be a customer at two branches.
-- Existing customers: their home branch is where most of their orders were (then their latest booking, the branch of whoever added
-- them, the company's first branch). One who also ordered or booked at other branches is copied to each of those, and those
-- orders and bookings move to that copy. Loyalty points, their history and vouchers stay with the home branch's customer.
ALTER TABLE customer ADD COLUMN branch_id uuid NULL REFERENCES branch;

UPDATE customer c SET branch_id = coalesce(
  (select o.branch_id from pos_order o where o.customer_id = c.id group by o.branch_id order by count(*) desc, max(o.opened_at) desc limit 1),
  (select r.branch_id from reservation r where r.customer_id = c.id order by r.starts_at desc limit 1),
  (select ub.branch_id from user_branch ub join branch b on b.id = ub.branch_id where ub.user_id = c.created_by and b.company_id = c.company_id order by b.created_at limit 1),
  (select b.id from branch b where b.company_id = c.company_id order by b.created_at limit 1));

CREATE TEMP TABLE customer_copy ON COMMIT DROP AS
  select gen_random_uuid() as new_id, c.id as old_id, x.branch_id
  from customer c
  join (select customer_id, branch_id from pos_order where customer_id is not null
        union select customer_id, branch_id from reservation where customer_id is not null) x on x.customer_id = c.id
  where x.branch_id <> c.branch_id;

INSERT INTO customer (id, company_id, branch_id, name, phone, phone_key, email, address, notes, is_active, created_at, created_by,
                      preapproved_pct, preapproved_reason, preapproved_until, preapproved_by, preapproved_at)
  select cc.new_id, c.company_id, cc.branch_id, c.name, c.phone, c.phone_key, c.email, c.address, c.notes, c.is_active, c.created_at, c.created_by,
         c.preapproved_pct, c.preapproved_reason, c.preapproved_until, c.preapproved_by, c.preapproved_at
  from customer_copy cc join customer c on c.id = cc.old_id;

UPDATE pos_order o SET customer_id = cc.new_id FROM customer_copy cc WHERE o.customer_id = cc.old_id AND o.branch_id = cc.branch_id;
UPDATE reservation r SET customer_id = cc.new_id FROM customer_copy cc WHERE r.customer_id = cc.old_id AND r.branch_id = cc.branch_id;

ALTER TABLE customer ALTER COLUMN branch_id SET NOT NULL;
DROP INDEX customer_phone;
CREATE UNIQUE INDEX customer_phone ON customer (branch_id, phone_key) WHERE phone_key IS NOT NULL;
DROP INDEX customer_name;
CREATE INDEX customer_name ON customer (branch_id, lower(name));
