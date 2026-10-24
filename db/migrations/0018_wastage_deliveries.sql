-- One POS 0018 — phase 4 stock: wastage and incoming deliveries (REQ INV-04, INV-06).
-- Wastage: what a branch throws away (item, quantity, reason), counted in the business day. For a branch linked to FACTS it
-- waits to be posted as a transfer to the outlet's wastage location (posting to FACTS is switched on later; nothing is
-- written to FACTS now). Deliveries: transfers into the branch's FACTS location, read from FACTS; the branch checks each one
-- in and notes differences here.

CREATE TABLE wastage (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES company,
  branch_id      uuid NOT NULL REFERENCES branch,
  business_date  date NOT NULL,
  item_id        uuid NOT NULL REFERENCES menu_item,
  name           text NOT NULL,
  qty            numeric(12,3) NOT NULL CHECK (qty > 0),
  unit           text NULL,
  reason         text NOT NULL CHECK (reason IN ('expired','damaged','quality','returned','staff','other')),
  note           text NULL,
  cost_value     numeric(14,2) NULL,             -- at the item's price when recorded (an indication, not the ERP cost)
  erp_status     text NOT NULL DEFAULT 'none' CHECK (erp_status IN ('none','pending','posted','failed')),
  erp_doc        text NULL,                       -- the ERP document once posted (e.g. STV50 8114)
  recorded_by    uuid NOT NULL REFERENCES app_user,
  recorded_at    timestamptz NOT NULL DEFAULT now(),
  voided_at      timestamptz NULL,
  voided_by      uuid NULL REFERENCES app_user
);
CREATE INDEX wastage_day ON wastage (branch_id, business_date);

CREATE TABLE delivery_check (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES company,
  branch_id      uuid NOT NULL REFERENCES branch,
  erp_doc_type   text NOT NULL,                   -- e.g. STV50
  erp_doc_no     text NOT NULL,
  checked_by     uuid NOT NULL REFERENCES app_user,
  checked_at     timestamptz NOT NULL DEFAULT now(),
  all_ok         boolean NOT NULL,
  differences    jsonb NULL,                      -- [{ code, name, sent, received, note }]
  note           text NULL,
  UNIQUE (branch_id, erp_doc_type, erp_doc_no)
);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['wastage','delivery_check'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY company_isolation ON %I USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO onepos_app', t);
  END LOOP;
END $$;
