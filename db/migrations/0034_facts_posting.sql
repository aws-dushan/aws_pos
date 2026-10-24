-- One POS 0034: posting sales to FACTS (REQ ERP-05, ERP-06), the way the outlet POS (Polaris) does it: each paid bill goes to
-- FACTS' usp_FQAPI_PWA_POS_SaveInvoice as XML and becomes a POS51 document. Off until an administrator switches posting on for
-- the company AND a branch has a start date (the day Polaris stops there). Refunds: a company setting (not posted, or an SR50
-- credit note through a FACTS procedure the FACTS developer provides). Wastage isn't posted: finance posts it in FACTS and
-- notes the document here. Card payments carry the FACTS card type the cashier picked.

ALTER TABLE menu_item ADD COLUMN erp_item_type text NULL;            -- FACTS item document type (STKMST_DOCTYPE, e.g. SMBK)
ALTER TABLE company ADD COLUMN facts_posting boolean NOT NULL DEFAULT false;
ALTER TABLE company ADD COLUMN facts_refunds text NOT NULL DEFAULT 'none' CHECK (facts_refunds IN ('none','sr50'));
ALTER TABLE company ADD COLUMN facts_refund_proc text NULL;           -- FACTS procedure that saves an SR50 from our XML
ALTER TABLE branch ADD COLUMN facts_post_from date NULL;              -- bills of this business day on are posted; null = not posted
ALTER TABLE payment ADD COLUMN card_type text NULL;                   -- FACTS payment method (PM_DESC) of a card payment

-- FACTS payment methods of each branch's location (PAYMENT_METHOD, read-only sync): cash, the card types, the delivery platforms.
CREATE TABLE erp_payment_mode (
  company_id  uuid NOT NULL REFERENCES company,
  branch_id   uuid NOT NULL REFERENCES branch,
  code        text NOT NULL,          -- PM_DOCNO, e.g. ERBQSVISACARD
  name        text NOT NULL,          -- PM_DESC, e.g. ERBQS VISA CARD (what the posting sends)
  kind        text NOT NULL CHECK (kind IN ('cash','card','platform')),
  label       text NOT NULL,          -- what the cashier sees: VISA CARD, Talabat…
  synced_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (branch_id, code)
);

-- The posting queue: one row per bill (and per credit note when refunds are posted), with the exact XML sent.
CREATE TABLE erp_post (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES company,
  branch_id       uuid NOT NULL REFERENCES branch,
  kind            text NOT NULL CHECK (kind IN ('invoice','refund')),
  order_id        uuid NOT NULL REFERENCES pos_order,
  credit_note_id  uuid NULL REFERENCES credit_note,
  doc_no          text NOT NULL,                     -- the invoice / credit note number sent (FACTS SAL_DOCNO)
  business_date   date NOT NULL,
  amount          numeric(14,2) NOT NULL,
  xml             text NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','posted','failed','waiting','skipped')),
  attempts        int NOT NULL DEFAULT 0,
  last_error      text NULL,
  facts_doc       text NULL,                         -- what FACTS answered (its document number)
  next_try_at     timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  posted_at       timestamptz NULL
);
CREATE UNIQUE INDEX erp_post_invoice ON erp_post (order_id) WHERE kind = 'invoice';
CREATE UNIQUE INDEX erp_post_refund ON erp_post (credit_note_id) WHERE kind = 'refund';
CREATE INDEX erp_post_due ON erp_post (next_try_at) WHERE status = 'pending';

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['erp_payment_mode','erp_post'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY company_isolation ON %I USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO onepos_app', t);
  END LOOP;
END $$;
