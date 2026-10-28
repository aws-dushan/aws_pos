-- One POS 0081: an option can take its price from FACTS: it is linked to a menu item, and the register charges that item's live price
-- at the branch (its FACTS price type, or the platform's FACTS price on a platform's bill) instead of the price typed on the option.
ALTER TABLE modifier_option ADD COLUMN facts_price boolean NOT NULL DEFAULT false;
