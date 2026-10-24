-- One POS 0051: bills of materials for FACTS items, and the daily repacking voucher (RPO50) that turns their raw materials into what
-- was sold. A BOM belongs to a FACTS item of the company (every menu item linked to that code uses it); it has versions, each valid
-- from a date, with the raw materials one unit uses. An item whose FACTS item has a BOM valid that day sells without stock of its
-- own; at day close the branch's sales of such items go to FACTS as one draft RPO50 (finished items in, raw materials out), which
-- finance checks and posts. A version a voucher has used is locked.
CREATE TABLE bom (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES company,
  item_type   text NOT NULL,                       -- FACTS item type (e.g. SMBK)
  item_code   text NOT NULL,                       -- FACTS item code of the finished item (e.g. 502113)
  item_name   text NOT NULL,
  unit        text NOT NULL,                       -- the FACTS unit one sale is counted in (e.g. PCS)
  created_by  uuid NOT NULL REFERENCES app_user,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, item_type, item_code)
);

CREATE TABLE bom_version (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES company,
  bom_id      uuid NOT NULL REFERENCES bom ON DELETE CASCADE,
  valid_from  date NOT NULL,
  note        text NULL,                           -- e.g. "From FACTS BOM 2372"
  created_by  uuid NOT NULL REFERENCES app_user,
  created_at  timestamptz NOT NULL DEFAULT now(),
  locked_at   timestamptz NULL,                    -- used in a repacking voucher: can't change any more
  used_until  date NULL,                           -- the last business day a voucher used it (a new version starts after it)
  UNIQUE (bom_id, valid_from)
);

CREATE TABLE bom_line (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES company,
  version_id  uuid NOT NULL REFERENCES bom_version ON DELETE CASCADE,
  sort        int NOT NULL,
  item_type   text NOT NULL,                       -- FACTS raw material
  item_code   text NOT NULL,
  item_name   text NOT NULL,
  unit        text NOT NULL,
  qty         numeric(18,6) NOT NULL CHECK (qty > 0) -- per ONE unit of the finished item
);
CREATE INDEX bom_line_version ON bom_line (version_id, sort);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['bom','bom_version','bom_line'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY company_isolation ON %I USING (company_id = (SELECT app_company_id())) WITH CHECK (company_id = (SELECT app_company_id()))', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO onepos_app', t);
  END LOOP;
END $$;

-- The daily repacking voucher: off, or a draft for finance to post (as wastage).
ALTER TABLE company ADD COLUMN facts_repacking text NOT NULL DEFAULT 'draft' CHECK (facts_repacking IN ('off', 'draft'));
ALTER TABLE erp_post DROP CONSTRAINT erp_post_kind_check;
ALTER TABLE erp_post ADD CONSTRAINT erp_post_kind_check CHECK (kind IN ('invoice', 'refund', 'wastage', 'repacking'));
CREATE UNIQUE INDEX erp_post_repacking ON erp_post (doc_no) WHERE kind = 'repacking';
