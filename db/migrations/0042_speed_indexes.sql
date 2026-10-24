-- One POS 0042: indexes for speed with years of bills (measured on a branch with two years, ~220k bills).
-- Bills by branch and close time: what was sold since the FACTS stock read (the register's "left"), the item stock check.
CREATE INDEX IF NOT EXISTS pos_order_branch_closed ON pos_order (branch_id, closed_at) WHERE status IN ('paid', 'refunded');
-- Refund lines by the bill line they refund (items-sold report, returns).
CREATE INDEX IF NOT EXISTS credit_note_line_order_line ON credit_note_line (order_line_id);
-- Credit notes by bill (receipts, the sales report's refunds).
CREATE INDEX IF NOT EXISTS credit_note_order ON credit_note (order_id);
-- The audit trail of a document (who gave a discount, the exceptions report, an order's history).
CREATE INDEX IF NOT EXISTS audit_log_entity ON audit_log (entity, entity_id);
-- Approvals of a bill (the exceptions report: who approved a discount or refund).
CREATE INDEX IF NOT EXISTS approval_order ON approval (order_id) WHERE order_id IS NOT NULL;
-- Wastage of an item at a branch that FACTS doesn't count yet (the register's "left").
CREATE INDEX IF NOT EXISTS wastage_branch_item ON wastage (branch_id, item_id) WHERE voided_at IS NULL;
-- Payments of a bill (receipts, refunds, the bill's detail).
CREATE INDEX IF NOT EXISTS payment_order ON payment (order_id);
