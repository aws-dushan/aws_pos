-- One POS 0016 — phase 4: table reservations (REQ TBL-07). A booking holds one or more tables for a time window; a table
-- can't be double-booked. Seating the booking opens the dine-in order on its tables with the customer attached.

CREATE TABLE reservation (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES company,
  branch_id     uuid NOT NULL REFERENCES branch,
  customer_id   uuid NULL REFERENCES customer,
  name          text NOT NULL CHECK (length(trim(name)) > 0),
  phone         text NULL,
  guests        int NOT NULL CHECK (guests BETWEEN 1 AND 200),
  starts_at     timestamptz NOT NULL,
  ends_at       timestamptz NOT NULL,
  status        text NOT NULL DEFAULT 'booked' CHECK (status IN ('booked','seated','cancelled','no_show')),
  note          text NULL,
  order_id      uuid NULL REFERENCES pos_order,
  created_by    uuid NOT NULL REFERENCES app_user,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX reservation_day ON reservation (branch_id, starts_at);

CREATE TABLE reservation_table (
  company_id     uuid NOT NULL REFERENCES company,
  reservation_id uuid NOT NULL REFERENCES reservation ON DELETE CASCADE,
  table_id       uuid NOT NULL REFERENCES dining_table,
  PRIMARY KEY (reservation_id, table_id)
);
CREATE INDEX reservation_table_table ON reservation_table (table_id);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['reservation','reservation_table'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY company_isolation ON %I USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO onepos_app', t);
  END LOOP;
END $$;
