-- One POS 0053: a user's own limits in a company, over their role's (two cashiers, one role, different discount limits).
-- Keys as the role's limits (maxDiscountPct, maxRefund, maxCashOut): a number is this user's own limit; null is "no limit" for
-- this user; a key not there follows the role.
ALTER TABLE user_company ADD COLUMN limits jsonb NOT NULL DEFAULT '{}';
