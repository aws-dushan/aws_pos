-- One POS 0036: the automatic day close warns first. At closing time every till of the branch counts down a minute; anyone on a
-- shift can delay it (customers still waiting) by close_delay_minutes at a time, up to close_delay_max_minutes past the set time.
ALTER TABLE branch ADD COLUMN close_delay_minutes int NOT NULL DEFAULT 15 CHECK (close_delay_minutes BETWEEN 5 AND 60);
ALTER TABLE branch ADD COLUMN close_delay_max_minutes int NOT NULL DEFAULT 120 CHECK (close_delay_max_minutes BETWEEN 0 AND 480);

-- closing_at: the countdown is on and the day closes at this moment. delayed_until: closing waits until then. delayed_minutes: in all.
ALTER TABLE business_day ADD COLUMN closing_at timestamptz;
ALTER TABLE business_day ADD COLUMN delayed_until timestamptz;
ALTER TABLE business_day ADD COLUMN delayed_minutes int NOT NULL DEFAULT 0;
