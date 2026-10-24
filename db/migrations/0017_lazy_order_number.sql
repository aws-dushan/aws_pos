-- One POS 0017 — an order gets its number when its first item is added, not when it's started: an order started and left
-- empty (thrown away) no longer uses up a number, so the numbers on the day's orders have no gaps from it.

ALTER TABLE pos_order ALTER COLUMN number DROP NOT NULL;
