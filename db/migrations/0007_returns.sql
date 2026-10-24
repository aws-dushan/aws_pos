-- One POS 0007 — tax invoice numbers, returns and credit notes (UAE VAT: a refund of a tax invoice is documented by a tax credit note).
-- A paid order gets a sequential tax invoice number per branch (INV-<branch>-000001). Every refund — items returned or an amount —
-- is a credit note (CN-<branch>-000001) referencing that invoice; its VAT reverses the invoice's VAT in proportion.

ALTER TABLE pos_order ADD COLUMN invoice_no text NULL;
CREATE UNIQUE INDEX pos_order_invoice_no ON pos_order (company_id, invoice_no) WHERE invoice_no IS NOT NULL;

ALTER TABLE order_line ADD COLUMN returned_qty int NOT NULL DEFAULT 0 CHECK (returned_qty >= 0);

-- Returns are allowed up to this many days after the order's business date (0 = the same day); later needs day.manage.
ALTER TABLE branch ADD COLUMN return_days int NOT NULL DEFAULT 0 CHECK (return_days BETWEEN 0 AND 365);

CREATE TABLE credit_note (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES company,
  branch_id     uuid NOT NULL REFERENCES branch,
  order_id      uuid NOT NULL REFERENCES pos_order,
  register_id   uuid NULL REFERENCES register,
  number        text NOT NULL,
  business_date date NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('items','amount')),
  reason        text NOT NULL,
  method        text NOT NULL,
  total         numeric(14,2) NOT NULL CHECK (total > 0),
  vat           numeric(14,2) NOT NULL,
  created_by    uuid NOT NULL REFERENCES app_user,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, number)
);

CREATE TABLE credit_note_line (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES company,
  credit_note_id uuid NOT NULL REFERENCES credit_note ON DELETE CASCADE,
  order_line_id  uuid NOT NULL REFERENCES order_line,
  name           text NOT NULL,
  qty            int NOT NULL CHECK (qty > 0),
  amount         numeric(14,2) NOT NULL,
  vat            numeric(14,2) NOT NULL,
  -- Back to stock (unused, resellable) or wastage; used when stock is linked to the ERP (phase 3).
  restock        boolean NOT NULL DEFAULT false
);

ALTER TABLE payment ADD COLUMN credit_note_id uuid NULL REFERENCES credit_note;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['credit_note','credit_note_line'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY company_isolation ON %I USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO onepos_app', t);
  END LOOP;
END $$;
