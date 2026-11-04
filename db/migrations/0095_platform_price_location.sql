-- One POS 0095: delivery platform prices by FACTS location. FACTS keeps a platform's price lists (CPL50) per location (e.g. ERBQS
-- European Bakery Al Qusais, PRDQS Preda Al Qusais). Each branch names whose lists it uses ("Platform prices from", a FACTS
-- location code); a branch without it has no platform prices. Prices are kept per platform and location, refilled by the price sync.
ALTER TABLE branch ADD COLUMN facts_platform_location text NULL;

-- Prices read so far ignored the location: they are dropped and the next price sync reads them per location.
DELETE FROM platform_item_price;
ALTER TABLE platform_item_price ADD COLUMN location text NOT NULL;
ALTER TABLE platform_item_price DROP CONSTRAINT platform_item_price_pkey;
ALTER TABLE platform_item_price ADD PRIMARY KEY (platform_id, location, item_id);

-- Price history of platform prices names the location the list was for (null on rows from before).
ALTER TABLE item_price_history ADD COLUMN location text NULL;
