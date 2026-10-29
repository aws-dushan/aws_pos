-- One POS 0089: the bell updates live. Every new notice (day summaries and alerts, approval requests, wastage, returns, stock
-- requests, reminders) signals 'onepos_notice' with its company and branch when its transaction commits; the API listens and tells
-- that company's open screens to re-read their bell (Notices.Listener).
CREATE FUNCTION notice_notify() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('onepos_notice', NEW.company_id::text || ':' || NEW.branch_id::text);
  RETURN NULL;
END $$;

CREATE TRIGGER notice_notify AFTER INSERT ON notice FOR EACH ROW EXECUTE FUNCTION notice_notify();
