-- One POS 0052: discounts (approved 19-10-2026, "One POS - Discounts for approval").
--   Promotions: automatic, set up in the back office: % off, AED off each, or a fixed price, on all items / categories / items,
--     from a date (an end date is optional), on some days and hours, at some branches, in store and/or on delivery platforms.
--   Cashier discounts: a ready-made list (% or AED, on the bill or one item), each limited to chosen roles, a name/reason if needed.
--   On top of these the till takes a typed discount (within the role's limit) and, on a platform's order, the platform's offer.
-- An item never gets two discounts: it gets the bigger of its own (promotion, item discount) and its share of the bill discount.
CREATE TABLE discount (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES company,
  kind         text NOT NULL CHECK (kind IN ('promotion', 'cashier')),
  name         text NOT NULL,
  type         text NOT NULL CHECK (type IN ('pct', 'amount', 'price')),   -- % off · AED off (each item; the bill for a bill discount) · fixed price
  value        numeric(14,2) NOT NULL CHECK (value >= 0),
  -- Promotions: which items.
  applies_to   text NOT NULL DEFAULT 'all' CHECK (applies_to IN ('all', 'categories', 'items')),
  category_ids uuid[] NOT NULL DEFAULT '{}',
  item_ids     uuid[] NOT NULL DEFAULT '{}',
  -- Cashier discounts: the whole bill or one item.
  target       text NOT NULL DEFAULT 'bill' CHECK (target IN ('bill', 'item')),
  role_ids     uuid[] NOT NULL DEFAULT '{}',      -- cashier discounts: who may give it (empty = anyone allowed to discount)
  needs_note   boolean NOT NULL DEFAULT false,    -- cashier discounts: a name or reason is required (e.g. the staff member)
  -- When and where (promotions).
  valid_from   date NOT NULL DEFAULT current_date,
  valid_to     date NULL,                         -- empty: no end date
  days         smallint[] NOT NULL DEFAULT '{}',  -- ISO days 1 (Mon) … 7 (Sun); empty = every day
  time_from    time NULL,
  time_to      time NULL,
  branch_ids   uuid[] NOT NULL DEFAULT '{}',      -- empty = every branch
  channel      text NOT NULL DEFAULT 'all' CHECK (channel IN ('all', 'instore', 'platforms', 'platform')),
  platform_id  uuid NULL REFERENCES delivery_platform,
  is_active    boolean NOT NULL DEFAULT true,
  created_by   uuid NOT NULL REFERENCES app_user,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (type <> 'pct' OR value <= 100),
  CHECK (kind <> 'cashier' OR type <> 'price'),
  CHECK (valid_to IS NULL OR valid_to >= valid_from)
);
CREATE INDEX discount_company ON discount (company_id, kind) WHERE is_active;

-- A line's own discount (a promotion when it was added, or one the cashier gave), kept as given so it holds while the bill is open.
ALTER TABLE order_line ADD COLUMN disc_source text NULL CHECK (disc_source IN ('promotion', 'cashier', 'typed'));
ALTER TABLE order_line ADD COLUMN disc_id     uuid NULL;                    -- the promotion or cashier discount
ALTER TABLE order_line ADD COLUMN disc_name   text NULL;                    -- shown under the item, e.g. "Happy hour"
ALTER TABLE order_line ADD COLUMN disc_type   text NULL CHECK (disc_type IN ('pct', 'amount', 'price'));
ALTER TABLE order_line ADD COLUMN disc_value  numeric(14,2) NULL;
ALTER TABLE order_line ADD COLUMN disc_note   text NULL;
ALTER TABLE order_line ADD COLUMN disc_by     uuid NULL REFERENCES app_user;
-- The discount the line actually got (the bigger of its own and its share of the bill discount), worked out with the bill.
ALTER TABLE order_line ADD COLUMN discount    numeric(14,2) NOT NULL DEFAULT 0;

-- The bill discount: % (discount_pct, as before) or AED (discount_amount), with its name, note and who gave it.
ALTER TABLE pos_order ADD COLUMN discount_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0);
ALTER TABLE pos_order ADD COLUMN discount_source text NULL CHECK (discount_source IN ('cashier', 'typed', 'platform'));
ALTER TABLE pos_order ADD COLUMN discount_id     uuid NULL;
ALTER TABLE pos_order ADD COLUMN discount_name   text NULL;
ALTER TABLE pos_order ADD COLUMN discount_note   text NULL;
ALTER TABLE pos_order ADD COLUMN discount_by     uuid NULL REFERENCES app_user;
-- A platform's offer the platform pays: noted for reconciliation, not a discount for the outlet.
ALTER TABLE pos_order ADD COLUMN platform_funded numeric(14,2) NOT NULL DEFAULT 0 CHECK (platform_funded >= 0);

-- Bills made before: their bill discount spread over their lines (by value), so refunds, reports and FACTS read each line's
-- discount from the line from now on. The last line of a bill takes the rounding remainder.
WITH spread AS (
  SELECT l.id, o.discount_total, o.subtotal, l.line_total,
         round(o.discount_total * l.line_total / nullif(o.subtotal, 0), 2) AS share,
         row_number() OVER (PARTITION BY l.order_id ORDER BY l.sort DESC, l.id DESC) AS from_last,
         sum(round(o.discount_total * l.line_total / nullif(o.subtotal, 0), 2)) OVER (PARTITION BY l.order_id) AS shares
  FROM order_line l JOIN pos_order o ON o.id = l.order_id
  WHERE o.discount_total > 0 AND o.subtotal > 0 AND NOT l.is_void
)
UPDATE order_line l SET discount = s.share + CASE WHEN s.from_last = 1 THEN s.discount_total - s.shares ELSE 0 END
FROM spread s WHERE s.id = l.id;

ALTER TABLE discount ENABLE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON discount USING (company_id = (SELECT app_company_id())) WITH CHECK (company_id = (SELECT app_company_id()));
GRANT SELECT, INSERT, UPDATE, DELETE ON discount TO onepos_app;
