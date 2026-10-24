-- One POS 0063: a delivery platform's bank fee (%), besides its commission: what the platform (or its payment gateway) keeps for
-- card/online payments. Both come off what it pays the outlet. Each order keeps the rates of when it was tagged; a recorded payout
-- notes the bank fee kept, like the commission kept.
ALTER TABLE delivery_platform ADD COLUMN bank_fee_pct numeric(5,2) NOT NULL DEFAULT 0 CHECK (bank_fee_pct BETWEEN 0 AND 100);
ALTER TABLE pos_order ADD COLUMN platform_bank_fee numeric(5,2) NULL;      -- the platform's bank fee rate when the order was tagged
ALTER TABLE platform_payout ADD COLUMN bank_fee numeric(14,2) NOT NULL DEFAULT 0 CHECK (bank_fee >= 0);
