-- One POS 0031: device status per branch (REQ HW-08). Each PC running One POS reports every minute: which till it is, whether
-- its One POS Device Service answers (version), its receipt printer and the printer's state, the last print and last error.
-- The Devices screen lists them: online (seen in the last 2 minutes), offline, problems.
CREATE TABLE device_status (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES company,
  branch_id        uuid NOT NULL REFERENCES branch,
  device_key       text NOT NULL,                 -- this browser's own id (kept on the PC)
  register_id      uuid NULL REFERENCES register,
  machine          text NULL,                     -- the PC's name, from the Device Service
  user_name        text NULL,                     -- who was signed in
  service_version  text NULL,                     -- null: no Device Service answered
  receipt_printer  text NULL,
  printer_state    text NULL,                     -- ready, paper out, offline, error, paused, not found…
  last_print_at    timestamptz NULL,
  last_error       text NULL,
  last_seen        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (branch_id, device_key)
);

ALTER TABLE device_status ENABLE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON device_status USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON device_status TO onepos_app;
