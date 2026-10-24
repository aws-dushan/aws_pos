-- One POS 0033: per-action rules on roles (REQ USR-06). Each sensitive action (discount, refund, cash out, void, no-sale) is,
-- for a role: allowed up to the role's limit (above it needs approval), always needs approval, or allowed and listed on the
-- exceptions report. The rules live with the role's limits (limits.rules); voids and no-sales can now be approved too.
ALTER TABLE approval DROP CONSTRAINT approval_kind_check;
ALTER TABLE approval ADD CONSTRAINT approval_kind_check CHECK (kind IN ('discount','refund','cash_out','void','no_sale'));
