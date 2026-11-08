-- One POS 0099: a till's first shift of the day is counted against the till's last closing count (from an earlier day). A different
-- count needs a reason; the shift keeps what it was compared with, so the reports show the difference. Only for business days from
-- the branch's opening_check_from date: shifts before it have no comparison and their reports stay as they were.
ALTER TABLE branch ADD COLUMN opening_check_from date NOT NULL DEFAULT DATE '2026-11-09';
ALTER TABLE shift
  ADD COLUMN last_close numeric(14,2) NULL,
  ADD COLUMN last_close_at timestamptz NULL,
  ADD COLUMN last_close_by text NULL,
  ADD COLUMN last_close_counted boolean NULL,
  ADD COLUMN opening_reason text NULL;
