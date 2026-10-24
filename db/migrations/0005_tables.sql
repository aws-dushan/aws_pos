-- One POS 0005 — phase 2: floors and tables (REQ TBL-01 … TBL-08).
-- A dine-in order sits on one or more tables (order_table, one row per table; joined tables = several rows). A table carries at most
-- one open order (unique table_id): rows exist only while the order is open.

CREATE TABLE floor (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES company,
  branch_id  uuid NOT NULL REFERENCES branch,
  name       text NOT NULL CHECK (length(trim(name)) > 0),
  sort       int NOT NULL DEFAULT 0,
  UNIQUE (branch_id, name)
);

CREATE TABLE dining_table (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES company,
  branch_id  uuid NOT NULL REFERENCES branch,
  floor_id   uuid NOT NULL REFERENCES floor,
  name       text NOT NULL CHECK (length(trim(name)) > 0),
  seats      int NOT NULL DEFAULT 4 CHECK (seats BETWEEN 1 AND 40),
  shape      text NOT NULL DEFAULT 'square' CHECK (shape IN ('round','square','rect')),
  x          int NOT NULL CHECK (x >= 0),
  y          int NOT NULL CHECK (y >= 0),
  w          int NOT NULL CHECK (w BETWEEN 1 AND 12),
  h          int NOT NULL CHECK (h BETWEEN 1 AND 12),
  reserved   boolean NOT NULL DEFAULT false,
  is_active  boolean NOT NULL DEFAULT true,
  UNIQUE (branch_id, name)
);

CREATE TABLE order_table (
  company_id uuid NOT NULL REFERENCES company,
  order_id   uuid NOT NULL REFERENCES pos_order ON DELETE CASCADE,
  table_id   uuid NOT NULL REFERENCES dining_table,
  is_primary boolean NOT NULL DEFAULT true,
  PRIMARY KEY (order_id, table_id),
  UNIQUE (table_id)
);

-- Who has the order open right now (REQ TBL-08): one device edits at a time; others see "Open on Till 1 · Sara" and can take over.
-- A lock lapses after 90 seconds without a heartbeat (a till that crashed doesn't block the table).
ALTER TABLE pos_order ADD COLUMN lock_session text NULL;
ALTER TABLE pos_order ADD COLUMN lock_user uuid NULL REFERENCES app_user;
ALTER TABLE pos_order ADD COLUMN lock_label text NULL;
ALTER TABLE pos_order ADD COLUMN lock_at timestamptz NULL;
-- The bill was printed for the table (the floor shows "Bill").
ALTER TABLE pos_order ADD COLUMN bill_printed_at timestamptz NULL;
-- A split order points at the order it was split from.
ALTER TABLE pos_order ADD COLUMN split_from uuid NULL REFERENCES pos_order;
ALTER TABLE pos_order DROP CONSTRAINT pos_order_status_check;
ALTER TABLE pos_order ADD CONSTRAINT pos_order_status_check CHECK (status IN ('open','paid','void','refunded','merged'));

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['floor','dining_table','order_table'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY company_isolation ON %I USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO onepos_app', t);
  END LOOP;
END $$;
