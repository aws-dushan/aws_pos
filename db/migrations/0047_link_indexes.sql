-- One POS 0047: indexes on links that were only ever followed by reading the whole table. Each grows with the years of history:
-- a shift's X/Z report finding its payments and cash movements, a day's shifts, the kitchen screen's ticket lines, a credit
-- note's lines, a customer's vouchers and bookings, and deleting a bill (the empty-order sweep, day close), where Postgres checks
-- nothing still points at it: without these that check read every bill, voucher move and loyalty move each time.
-- Partial where the link is optional, so the index holds only the rows that have one.
CREATE INDEX IF NOT EXISTS payment_shift ON payment (shift_id) WHERE shift_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS payment_credit_note ON payment (credit_note_id) WHERE credit_note_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS payment_voucher ON payment (voucher_id) WHERE voucher_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS cash_movement_shift ON cash_movement (shift_id);
CREATE INDEX IF NOT EXISTS shift_business_day ON shift (business_day_id);
CREATE INDEX IF NOT EXISTS no_sale_shift ON no_sale (shift_id) WHERE shift_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS approval_shift ON approval (shift_id) WHERE shift_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS bank_deposit_business_day ON bank_deposit (business_day_id) WHERE business_day_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS kitchen_ticket_line_ticket ON kitchen_ticket_line (ticket_id);
CREATE INDEX IF NOT EXISTS credit_note_line_note ON credit_note_line (credit_note_id);
CREATE INDEX IF NOT EXISTS pos_order_split_from ON pos_order (split_from) WHERE split_from IS NOT NULL;
CREATE INDEX IF NOT EXISTS reservation_order ON reservation (order_id) WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS reservation_customer ON reservation (customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS voucher_move_order ON voucher_move (order_id) WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS loyalty_move_order ON loyalty_move (order_id) WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS voucher_customer ON voucher (customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ingredient_move_wastage ON ingredient_move (wastage_id) WHERE wastage_id IS NOT NULL;
