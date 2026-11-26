-- ONE POS 0115: per branch, the order types it takes and the payment types the till offers for each; whether receipts print
-- after payment; and the order type a delivery platform's orders are (Talabat Kitchen Dine In: dine-in, at its own commission).
-- Dine-in stays with table service; takeaway and delivery have their own switch. Existing branches keep everything as before.
ALTER TABLE branch ADD COLUMN takeaway_on boolean NOT NULL DEFAULT true;
ALTER TABLE branch ADD COLUMN delivery_on boolean NOT NULL DEFAULT true;
-- Per order type, the payment types the till offers: cash, card, other, account, platform (voucher and points follow the company).
ALTER TABLE branch ADD COLUMN pay_methods jsonb NOT NULL DEFAULT
  '{"dine_in":["cash","card","other","account"],"takeaway":["cash","card","other","account"],"delivery":["cash","card","other","account","platform"]}';
ALTER TABLE branch ADD COLUMN print_receipts boolean NOT NULL DEFAULT true;

ALTER TABLE delivery_platform ADD COLUMN order_type text NOT NULL DEFAULT 'delivery'
  CHECK (order_type IN ('dine_in', 'takeaway', 'delivery'));
