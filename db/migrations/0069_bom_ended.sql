-- One POS 0069: a BOM from FACTS that FACTS no longer has active (made inactive or deleted there) ends from a date: from then its item
-- isn't made to order any more and sells from its own stock again. Its versions stay as they are (locked ones were used in vouchers).
-- Active in FACTS again clears it.
ALTER TABLE bom ADD COLUMN ended_from date NULL;
