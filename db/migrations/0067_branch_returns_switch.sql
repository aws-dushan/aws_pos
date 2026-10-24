-- One POS 0067: returns (credit notes for paid orders) can be switched on or off per branch, in Companies & branches. Off until
-- it is decided how returns go to FACTS; while off, the Orders page has no Return button and the API refuses returns and refunds.
ALTER TABLE branch ADD COLUMN returns_enabled boolean NOT NULL DEFAULT false;
