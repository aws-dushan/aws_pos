-- One POS 0102: TV screens (digital signage). A branch can switch it on; each till PC's tray app then shows designs (slides of menus,
-- offers and pictures, with animations) full screen on the TVs connected to that PC. The till finds its TVs by itself and reports them;
-- a manager names each TV, switches it on or off and chooses its design. The tray app reads with a long random token per PC
-- (only its SHA-256 is kept), never a user's session.
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

-- A till PC that shows TV screens: found by its token without a company (like receipt links), so no row-level security here;
-- every query on it is by token hash or by id inside an endpoint that already checked the company.
CREATE TABLE signage_device (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES company,
  branch_id   uuid NOT NULL REFERENCES branch ON DELETE CASCADE,
  device_key  text NOT NULL CHECK (length(device_key) BETWEEN 1 AND 64),
  machine     text NULL,
  token_hash  bytea NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_seen   timestamptz NULL,
  UNIQUE (branch_id, device_key)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON signage_device TO onepos_app;

-- A TV: one screen of one till PC (the PC's own id for the screen: the TV's make, model and serial, or the wireless display's name).
CREATE TABLE signage_screen (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES company,
  branch_id     uuid NOT NULL REFERENCES branch ON DELETE CASCADE,
  device_id     uuid NOT NULL REFERENCES signage_device ON DELETE CASCADE,
  monitor_key   text NOT NULL CHECK (length(monitor_key) BETWEEN 1 AND 200),
  detected_name text NULL,                                       -- what the TV calls itself, e.g. "Hisense VIDAA TV"
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  is_on         boolean NOT NULL DEFAULT true,
  design_id     uuid NULL REFERENCES signage_design ON DELETE SET NULL,
  width         int NULL,
  height        int NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen     timestamptz NULL,
  UNIQUE (device_id, monitor_key)
);
CREATE INDEX signage_screen_branch ON signage_screen (branch_id);
CREATE INDEX signage_screen_design ON signage_screen (design_id);
ALTER TABLE signage_screen ENABLE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON signage_screen USING (company_id = (SELECT app_company_id())) WITH CHECK (company_id = (SELECT app_company_id()));
GRANT SELECT, INSERT, UPDATE, DELETE ON signage_screen TO onepos_app;
