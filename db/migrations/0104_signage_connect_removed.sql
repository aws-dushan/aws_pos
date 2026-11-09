-- One POS 0104: wireless TVs are no longer connected from One POS (Windows' wireless display can't be driven reliably from a
-- program); the columns 0103 added for it go.
ALTER TABLE signage_device
  DROP COLUMN IF EXISTS nearby, DROP COLUMN IF EXISTS nearby_at, DROP COLUMN IF EXISTS connect_name, DROP COLUMN IF EXISTS connect_at,
  DROP COLUMN IF EXISTS connect_ok, DROP COLUMN IF EXISTS connect_message, DROP COLUMN IF EXISTS connect_done_at;
