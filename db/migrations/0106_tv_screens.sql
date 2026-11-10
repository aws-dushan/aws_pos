-- One POS 0106: TV screens (digital signage), shown by the TV itself. A branch can switch it on; a manager builds designs (slides
-- of menus, offers and pictures, with animations). Any smart TV opens the One POS TV page in its own browser (any Wi-Fi with
-- internet), shows a pairing code, and a manager enters that code on TV screens: the TV is then linked to the branch and plays the
-- design chosen for it. The TV keeps a long random key in its browser; only the key's SHA-256 is stored here.
ALTER TABLE branch ADD COLUMN IF NOT EXISTS signage_enabled boolean NOT NULL DEFAULT false;

CREATE TABLE signage_design (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES company,
  branch_id   uuid NULL REFERENCES branch ON DELETE CASCADE,   -- null: every branch of the company
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  content     jsonb NOT NULL,                                   -- theme and slides, as the designer saves them
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX signage_design_company ON signage_design (company_id, branch_id);
ALTER TABLE signage_design ENABLE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON signage_design USING (company_id = (SELECT app_company_id())) WITH CHECK (company_id = (SELECT app_company_id()));
GRANT SELECT, INSERT, UPDATE, DELETE ON signage_design TO onepos_app;

-- Pictures and videos used in designs (backgrounds, offers, full-screen slides).
CREATE TABLE signage_media (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES company,
  file        text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('image', 'video')),
  name        text NULL,
  bytes       bigint NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX signage_media_company ON signage_media (company_id, created_at);
ALTER TABLE signage_media ENABLE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON signage_media USING (company_id = (SELECT app_company_id())) WITH CHECK (company_id = (SELECT app_company_id()));
GRANT SELECT, INSERT, UPDATE, DELETE ON signage_media TO onepos_app;

-- A TV waiting to be linked: it showed `code` on screen; it expires after 30 minutes. Found by code or by the TV's key without a
-- company, so no row-level security (like receipt links).
CREATE TABLE signage_pairing (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL CHECK (code ~ '^[0-9]{6}$'),
  token_hash  bytea NOT NULL UNIQUE,
  detected    text NULL,                                        -- the TV's system, e.g. "Hisense VIDAA"
  width       int NULL,
  height      int NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);
CREATE INDEX signage_pairing_code ON signage_pairing (code, expires_at);
GRANT SELECT, INSERT, UPDATE, DELETE ON signage_pairing TO onepos_app;

-- A linked TV. Found by its key without a company (the TV page), so no row-level security here; every other query on it is by id
-- and branch inside an endpoint that already checked the company.
CREATE TABLE signage_screen (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES company,
  branch_id     uuid NOT NULL REFERENCES branch ON DELETE CASCADE,
  token_hash    bytea NOT NULL UNIQUE,
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  detected      text NULL,
  is_on         boolean NOT NULL DEFAULT true,
  design_id     uuid NULL REFERENCES signage_design ON DELETE SET NULL,
  width         int NULL,
  height        int NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen     timestamptz NULL
);
CREATE INDEX signage_screen_branch ON signage_screen (branch_id);
CREATE INDEX signage_screen_design ON signage_screen (design_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON signage_screen TO onepos_app;
