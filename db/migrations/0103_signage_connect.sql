-- One POS 0103: connect wireless TVs from One POS. Each till PC reports the wireless TVs it can see nearby; a manager picks one
-- on TV screens and asks the till to connect it; the till connects, extends the desktop onto it and reports how it went.
ALTER TABLE signage_device
  ADD COLUMN nearby          jsonb NULL,          -- [{ name, connected }] as last reported
  ADD COLUMN nearby_at       timestamptz NULL,
  ADD COLUMN connect_name    text NULL,           -- a manager's request, until the till reports it done
  ADD COLUMN connect_at      timestamptz NULL,
  ADD COLUMN connect_ok      boolean NULL,        -- the last attempt's result
  ADD COLUMN connect_message text NULL,
  ADD COLUMN connect_done_at timestamptz NULL;
