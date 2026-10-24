-- One POS 0002 — phase 1: registers (tills), menu with modifiers and branch overrides, orders, payments.
-- Money: numeric(14,2) amounts, rounded half away from zero in the API (Platform/Money.cs). All tables are company-owned (RLS).

-- A register: one till of a branch (REQ HW-02, RPT-01 register sales). A browser set up as a till points at one register.
CREATE TABLE register (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES company,
  branch_id  uuid NOT NULL REFERENCES branch,
  code       text NOT NULL CHECK (code ~ '^[A-Z0-9-]{1,10}$'),
  name       text NOT NULL CHECK (length(trim(name)) > 0),
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (branch_id, code)
);

-- Menu (REQ MNU-01): owned by the company, shared by its branches.
CREATE TABLE menu_category (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES company,
  name       text NOT NULL CHECK (length(trim(name)) > 0),
  name_ar    text NULL,
  tone       text NOT NULL DEFAULT 'fin' CHECK (tone IN ('fin','sales','purch','inv','bp','bank','appr','admin')),
  sort       int NOT NULL DEFAULT 0,
  is_active  boolean NOT NULL DEFAULT true,
  UNIQUE (company_id, name)
);

CREATE TABLE menu_item (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES company,
  category_id   uuid NOT NULL REFERENCES menu_category,
  name          text NOT NULL CHECK (length(trim(name)) > 0),
  name_ar       text NULL,
  description   text NULL,
  price         numeric(14,2) NOT NULL CHECK (price >= 0),
  station       text NOT NULL DEFAULT 'kitchen' CHECK (station IN ('kitchen','bar','none')),
  erp_item_code text NULL,
  sort          int NOT NULL DEFAULT 0,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX menu_item_category ON menu_item (category_id);

-- Modifiers (REQ REG-02): a group (e.g. "Size", min 1 max 1) of options (e.g. "Large +5").
CREATE TABLE modifier_group (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES company,
  name       text NOT NULL CHECK (length(trim(name)) > 0),
  min_select int NOT NULL DEFAULT 0 CHECK (min_select >= 0),
  max_select int NOT NULL DEFAULT 1 CHECK (max_select >= 1),
  CHECK (max_select >= min_select),
  UNIQUE (company_id, name)
);

CREATE TABLE modifier_option (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES company,
  group_id   uuid NOT NULL REFERENCES modifier_group ON DELETE CASCADE,
  name       text NOT NULL CHECK (length(trim(name)) > 0),
  price      numeric(14,2) NOT NULL DEFAULT 0 CHECK (price >= 0),
  sort       int NOT NULL DEFAULT 0,
  is_active  boolean NOT NULL DEFAULT true
);

CREATE TABLE menu_item_modifier (
  company_id uuid NOT NULL REFERENCES company,
  item_id    uuid NOT NULL REFERENCES menu_item ON DELETE CASCADE,
  group_id   uuid NOT NULL REFERENCES modifier_group ON DELETE CASCADE,
  sort       int NOT NULL DEFAULT 0,
  PRIMARY KEY (item_id, group_id)
);

-- Branch overrides (REQ MNU-02): not sold here, a branch price, sold out until a date.
CREATE TABLE branch_item (
  company_id    uuid NOT NULL REFERENCES company,
  branch_id     uuid NOT NULL REFERENCES branch,
  item_id       uuid NOT NULL REFERENCES menu_item ON DELETE CASCADE,
  is_sold       boolean NOT NULL DEFAULT true,
  price         numeric(14,2) NULL CHECK (price >= 0),
  sold_out_date date NULL,
  PRIMARY KEY (branch_id, item_id)
);

-- An order (REQ REG, ORD). Totals are kept on the order, recalculated by the API on every change.
CREATE TABLE pos_order (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES company,
  branch_id        uuid NOT NULL REFERENCES branch,
  register_id      uuid NULL REFERENCES register,
  business_date    date NOT NULL,
  number           int NOT NULL,
  order_type       text NOT NULL CHECK (order_type IN ('dine_in','takeaway','delivery')),
  table_label      text NULL,
  guests           int NULL CHECK (guests > 0),
  customer_name    text NULL,
  customer_phone   text NULL,
  delivery_address text NULL,
  note             text NULL,
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open','paid','void','refunded')),
  discount_pct     numeric(5,2) NOT NULL DEFAULT 0 CHECK (discount_pct BETWEEN 0 AND 100),
  subtotal         numeric(14,2) NOT NULL DEFAULT 0,
  discount_total   numeric(14,2) NOT NULL DEFAULT 0,
  service_charge   numeric(14,2) NOT NULL DEFAULT 0,
  vat              numeric(14,2) NOT NULL DEFAULT 0,
  total            numeric(14,2) NOT NULL DEFAULT 0,
  paid             numeric(14,2) NOT NULL DEFAULT 0,
  refunded         numeric(14,2) NOT NULL DEFAULT 0,
  vat_rate         numeric(5,2) NOT NULL,
  prices_include_vat boolean NOT NULL,
  service_pct      numeric(5,2) NOT NULL DEFAULT 0,
  opened_by        uuid NOT NULL REFERENCES app_user,
  opened_at        timestamptz NOT NULL DEFAULT now(),
  closed_at        timestamptz NULL,
  void_reason      text NULL,
  version          int NOT NULL DEFAULT 1,
  UNIQUE (branch_id, business_date, number)
);
CREATE INDEX pos_order_branch_day ON pos_order (branch_id, business_date, status);

CREATE TABLE order_line (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES company,
  order_id    uuid NOT NULL REFERENCES pos_order ON DELETE CASCADE,
  item_id     uuid NULL REFERENCES menu_item,
  name        text NOT NULL,
  unit_price  numeric(14,2) NOT NULL,              -- item price + chosen options, per unit
  qty         int NOT NULL CHECK (qty > 0),
  modifiers   jsonb NOT NULL DEFAULT '[]',         -- [{ groupId, optionId, group, name, price }]
  note        text NULL,
  station     text NOT NULL DEFAULT 'kitchen',
  sent_qty    int NOT NULL DEFAULT 0 CHECK (sent_qty >= 0),
  line_total  numeric(14,2) NOT NULL DEFAULT 0,    -- unit_price × qty
  vat         numeric(14,2) NOT NULL DEFAULT 0,    -- this line's VAT after the order discount
  is_void     boolean NOT NULL DEFAULT false,
  void_reason text NULL,
  sort        int NOT NULL DEFAULT 0,
  added_by    uuid NOT NULL REFERENCES app_user,
  added_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_line_order ON order_line (order_id);

-- Money in and out (REQ PAY). A refund is a row with kind 'refund' and a positive amount paid back.
CREATE TABLE payment (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES company,
  branch_id     uuid NOT NULL REFERENCES branch,
  register_id   uuid NULL REFERENCES register,
  order_id      uuid NOT NULL REFERENCES pos_order,
  business_date date NOT NULL,
  kind          text NOT NULL DEFAULT 'payment' CHECK (kind IN ('payment','refund')),
  method        text NOT NULL CHECK (method IN ('cash','card','other','voucher','account')),
  amount        numeric(14,2) NOT NULL CHECK (amount > 0),
  tendered      numeric(14,2) NULL,
  change_given  numeric(14,2) NOT NULL DEFAULT 0,
  reference     text NULL,
  reason        text NULL,
  taken_by      uuid NOT NULL REFERENCES app_user,
  at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payment_branch_day ON payment (branch_id, business_date);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['register','menu_category','menu_item','modifier_group','modifier_option','menu_item_modifier','branch_item','pos_order','order_line','payment'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY company_isolation ON %I USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO onepos_app', t);
  END LOOP;
END $$;
GRANT DELETE ON number_series TO onepos_app;
-- Platform reads (sign-in at a till) need the register's branch without a company set.
DROP POLICY company_isolation ON register;
CREATE POLICY company_isolation ON register USING (app_company_id() IS NULL OR company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
