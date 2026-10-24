-- One POS 0006 — phase 2: kitchen (REQ KIT-01 … KIT-05).
-- A station is where food or drink is made (kitchen, bar). Menu items route to a station by their kind (menu_item.station).
-- "Send" turns the new quantities of an order into tickets, one per station; voiding sent items sends a cancel ticket.

CREATE TABLE kitchen_station (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES company,
  branch_id    uuid NOT NULL REFERENCES branch,
  kind         text NOT NULL CHECK (kind IN ('kitchen','bar')),
  name         text NOT NULL CHECK (length(trim(name)) > 0),
  -- The Windows name of this station's ticket printer (installed on the tills); null = kitchen display only.
  printer_name text NULL,
  UNIQUE (branch_id, kind)
);

CREATE TABLE kitchen_ticket (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES company,
  branch_id   uuid NOT NULL REFERENCES branch,
  order_id    uuid NOT NULL REFERENCES pos_order,
  order_number int NOT NULL,
  label       text NOT NULL,
  order_type  text NOT NULL,
  station     text NOT NULL CHECK (station IN ('kitchen','bar')),
  is_cancel   boolean NOT NULL DEFAULT false,
  status      text NOT NULL DEFAULT 'new' CHECK (status IN ('new','preparing','ready','served')),
  sent_by     uuid NOT NULL REFERENCES app_user,
  created_at  timestamptz NOT NULL DEFAULT now(),
  started_at  timestamptz NULL,
  ready_at    timestamptz NULL,
  served_at   timestamptz NULL,
  -- Set by the one till that claims the printing (POST /kitchen/tickets/{id}/claim-print), so a ticket never prints twice.
  printed_at  timestamptz NULL
);
CREATE INDEX kitchen_ticket_board ON kitchen_ticket (branch_id, status, created_at);
CREATE INDEX kitchen_ticket_order ON kitchen_ticket (order_id);

CREATE TABLE kitchen_ticket_line (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES company,
  ticket_id  uuid NOT NULL REFERENCES kitchen_ticket ON DELETE CASCADE,
  qty        int NOT NULL,
  name       text NOT NULL,
  extras     text NULL,
  note       text NULL,
  sort       int NOT NULL DEFAULT 0
);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['kitchen_station','kitchen_ticket','kitchen_ticket_line'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY company_isolation ON %I USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO onepos_app', t);
  END LOOP;
END $$;
