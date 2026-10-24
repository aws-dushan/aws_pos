-- One POS 0064: a customer's pre-approved discount (e.g. 100 % complimentary for the owner and guests, staff meals, a company or
-- VIP account). A manager allowed to (customers.preapprove) sets it once; attaching the customer to a bill then gives that
-- discount on the whole bill with no approval request. No cap; an end date is optional. The bill goes to FACTS as before, with
-- the customer's name and the reason as its party name (FACTS' narration), e.g. "Ahmed Complimentary".
ALTER TABLE customer ADD COLUMN preapproved_pct numeric(5,2) NULL CHECK (preapproved_pct > 0 AND preapproved_pct <= 100);
ALTER TABLE customer ADD COLUMN preapproved_reason text NULL CHECK (preapproved_reason IN ('complimentary', 'owner', 'guest', 'staff', 'company'));
ALTER TABLE customer ADD COLUMN preapproved_until date NULL;
ALTER TABLE customer ADD COLUMN preapproved_by uuid NULL REFERENCES app_user;
ALTER TABLE customer ADD COLUMN preapproved_at timestamptz NULL;

ALTER TABLE pos_order DROP CONSTRAINT IF EXISTS pos_order_discount_source_check;
ALTER TABLE pos_order ADD CONSTRAINT pos_order_discount_source_check CHECK (discount_source IN ('cashier', 'typed', 'platform', 'customer'));
