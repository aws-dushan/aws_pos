-- One POS 0100: selling prices set in One POS (Prices page) and posted in FACTS. Per branch, the FACTS user the prices are posted as
-- (one FACTS lets post OSMPI and CPL50). A posting is a price change: its outlet prices go as one OSMPI (FACTS' outlet price
-- import, price type of the branch) and its platform prices as one CPL50 (customer price list) per platform, at the branch's
-- platform price location; each document is saved and posted in FACTS straight away. The price sync then reads them back as for
-- prices entered in FACTS by hand.
ALTER TABLE branch ADD COLUMN facts_price_user text NULL;

-- Who may post prices: every role that manages branches (branch managers, head office) for now; it can be given to others in Roles.
UPDATE role SET permissions = array_append(permissions, 'prices.post')
WHERE 'branch.manage' = ANY (permissions) AND NOT ('prices.post' = ANY (permissions));

CREATE TABLE price_change (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES company,
  branch_id   uuid NOT NULL REFERENCES branch,
  remark      text NULL,
  facts_user  text NOT NULL,                                  -- the FACTS user it was posted as
  created_by  uuid NOT NULL REFERENCES app_user,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX price_change_branch ON price_change (branch_id, created_at DESC);

-- One FACTS document of a price change. lines: [{itemId, code, type, name, old, new}] with old/new the selling prices (VAT included)
-- and factsPrice the value written to FACTS.
CREATE TABLE price_change_doc (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES company,
  change_id    uuid NOT NULL REFERENCES price_change ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('outlet', 'platform')),
  platform_id  uuid NULL REFERENCES delivery_platform,
  price_type   text NULL,                                     -- outlet: the FACTS price type (OP1 …)
  customer     text NULL,                                     -- platform: its FACTS customer
  location     text NULL,                                     -- platform: the FACTS location of the list
  reference    text NOT NULL,                                 -- what FACTS keeps on the document (a retry finds it by this)
  lines        jsonb NOT NULL,
  status       text NOT NULL DEFAULT 'posting' CHECK (status IN ('posting', 'posted', 'failed')),
  facts_doc_type text NULL,
  facts_doc    text NULL,
  error        text NULL,
  attempts     integer NOT NULL DEFAULT 0,
  posted_at    timestamptz NULL,
  CHECK ((kind = 'outlet') = (platform_id IS NULL))
);
CREATE INDEX price_change_doc_change ON price_change_doc (change_id);

ALTER TABLE price_change ENABLE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON price_change USING (company_id = (SELECT app_company_id())) WITH CHECK (company_id = (SELECT app_company_id()));
ALTER TABLE price_change_doc ENABLE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON price_change_doc USING (company_id = (SELECT app_company_id())) WITH CHECK (company_id = (SELECT app_company_id()));
GRANT SELECT, INSERT, UPDATE, DELETE ON price_change, price_change_doc TO onepos_app;
