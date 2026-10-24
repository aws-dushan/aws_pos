-- One POS 0026: the order-ready (pickup) screen (REQ KIT-06). A takeaway or delivery order is Preparing, then Ready, then
-- Collected. With a kitchen: Ready when all its tickets are ready, Collected when they're served. Without one (a café or
-- counter): the cashier marks Ready and Collected at the till.
ALTER TABLE pos_order ADD COLUMN ready_at timestamptz NULL;
ALTER TABLE pos_order ADD COLUMN collected_at timestamptz NULL;
CREATE INDEX pos_order_pickup ON pos_order (branch_id, business_date) WHERE order_type <> 'dine_in' AND collected_at IS NULL;
