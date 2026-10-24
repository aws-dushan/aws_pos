-- One POS 0024: what a branch does when a recipe's ingredients run short (REQ INV-02).
-- allow: sell anyway (stock goes below zero, flagged on the Ingredients screen); warn: the register marks the item and warns
-- when it's added; block: an item can't be added once the order would need more of an ingredient than the branch has.
ALTER TABLE branch ADD COLUMN short_stock text NOT NULL DEFAULT 'allow' CHECK (short_stock IN ('allow','warn','block'));
