-- One POS 0023 — phase 4: recipes and ingredient stock (REQ INV-01, INV-02, INV-03).
-- An ingredient has a unit and a cost per unit. A menu item (and a modifier option, e.g. "Extra cheese") has a recipe: how much
-- of each ingredient one of it uses. A paid order takes its recipes off the branch's ingredient stock; an item returned "back to
-- stock" puts them back; wasted menu items take them off. The branch receives ingredients, throws them away, and counts them
-- (the count sets what's on hand; the difference is kept as the count's variance).

CREATE TABLE ingredient (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES company,
  name        text NOT NULL CHECK (length(trim(name)) > 0),
  unit        text NOT NULL CHECK (unit IN ('kg','g','l','ml','pcs')),
  cost        numeric(14,4) NOT NULL DEFAULT 0 CHECK (cost >= 0),      -- per unit
  par_level   numeric(14,3) NULL CHECK (par_level >= 0),               -- below this on hand it shows as low
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ingredient_name ON ingredient (company_id, lower(name));

CREATE TABLE recipe_line (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES company,
  item_id        uuid NULL REFERENCES menu_item ON DELETE CASCADE,
  option_id      uuid NULL REFERENCES modifier_option ON DELETE CASCADE,
  ingredient_id  uuid NOT NULL REFERENCES ingredient,
  qty            numeric(12,4) NOT NULL CHECK (qty > 0),               -- in the ingredient's unit, for one
  CHECK ((item_id IS NULL) <> (option_id IS NULL))
);
CREATE UNIQUE INDEX recipe_line_item ON recipe_line (item_id, ingredient_id) WHERE item_id IS NOT NULL;
CREATE UNIQUE INDEX recipe_line_option ON recipe_line (option_id, ingredient_id) WHERE option_id IS NOT NULL;

CREATE TABLE branch_ingredient (
  company_id     uuid NOT NULL REFERENCES company,
  branch_id      uuid NOT NULL REFERENCES branch,
  ingredient_id  uuid NOT NULL REFERENCES ingredient,
  on_hand        numeric(14,3) NOT NULL DEFAULT 0,                      -- can go below zero: sales don't wait for a delivery
  counted_at     timestamptz NULL,
  PRIMARY KEY (branch_id, ingredient_id)
);

CREATE TABLE ingredient_move (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES company,
  branch_id      uuid NOT NULL REFERENCES branch,
  ingredient_id  uuid NOT NULL REFERENCES ingredient,
  business_date  date NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('sale','return','waste','receive','count','adjust')),
  qty            numeric(14,3) NOT NULL,                                -- + into stock, − out of it
  cost           numeric(14,4) NOT NULL DEFAULT 0,                       -- the ingredient's cost per unit at the time
  order_id       uuid NULL REFERENCES pos_order,
  wastage_id     uuid NULL REFERENCES wastage,
  note           text NULL,
  by_user        uuid NULL REFERENCES app_user,
  at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ingredient_move_branch ON ingredient_move (branch_id, business_date);
CREATE INDEX ingredient_move_ingredient ON ingredient_move (ingredient_id, at);
CREATE INDEX ingredient_move_order ON ingredient_move (order_id) WHERE order_id IS NOT NULL;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['ingredient','recipe_line','branch_ingredient','ingredient_move'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY company_isolation ON %I USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO onepos_app', t);
  END LOOP;
END $$;
