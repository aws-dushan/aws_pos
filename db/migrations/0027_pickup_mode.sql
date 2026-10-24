-- One POS 0027: the order-ready screen per branch. off: none. auto: no taps (with a kitchen, ready when the kitchen finishes;
-- without one, ready as soon as it's paid). cashier: one tap on the register marks an order ready. Ready numbers leave the
-- screen by themselves after pickup_minutes (nobody marks them collected).
ALTER TABLE branch ADD COLUMN pickup_mode text NOT NULL DEFAULT 'off' CHECK (pickup_mode IN ('off','auto','cashier'));
ALTER TABLE branch ADD COLUMN pickup_minutes int NOT NULL DEFAULT 10 CHECK (pickup_minutes BETWEEN 1 AND 120);
