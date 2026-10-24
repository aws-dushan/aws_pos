-- One POS 0054: a shared drawer. On a till set so (an outlet with one till and several cashiers), the first cashier opens the shift
-- with the float count and every cashier who signs in there sells and takes money in that same shift; each payment keeps who
-- took it, and any of them closes the shift with one count. Off by default: one cashier per drawer, as before.
ALTER TABLE register ADD COLUMN shared_drawer boolean NOT NULL DEFAULT false;
