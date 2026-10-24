-- One POS 0021 — "Report a problem" (as AWS One 0172): the in-app issue channel for staff and testers.
--   * feedback: one report. Written from any screen (top bar, Alt R, user menu): what the user wrote plus what the app adds by
--     itself — the screen, the company, branch and till, the user, the browser and screen size, the app version and the errors the
--     browser met in the last two hours. Status New → In progress → Fixed / Won't fix, an assignee (an administrator), comments.
--     Platform data like audit_log: company_id is context, not isolation (no RLS, no FK), so reports stay when a company goes;
--     the company's and branch's code and name are copied onto the report for that reason. Administrators see every report;
--     everyone else only their own (checked by the API).
--   * feedback_comment: the conversation (reporter and administrators), append-only.
--   * feedback_file: the screenshot (taken in the browser, no outside service) and attached files, stored next to the images
--     (Images:Root, under feedback/…). Files are never erased.
--   * Changes (status, assignee, priority) are audited on the platform trail (entity 'feedback').

CREATE SEQUENCE feedback_number_seq;
GRANT USAGE ON SEQUENCE feedback_number_seq TO onepos_app;

CREATE TABLE feedback (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number         text NOT NULL UNIQUE,                         -- FB-000001 (automatic)
  user_id        uuid NOT NULL REFERENCES app_user,
  company_id     uuid NULL,                                    -- context only
  company_code   text NULL,
  company_name   text NULL,
  branch_id      uuid NULL,                                    -- context only
  branch_code    text NULL,
  branch_name    text NULL,
  register_name  text NULL,                                    -- the till it was sent from
  kind           text NOT NULL DEFAULT 'problem' CHECK (kind IN ('problem', 'question', 'idea')),
  severity       text NOT NULL DEFAULT 'normal' CHECK (severity IN ('blocker', 'major', 'normal', 'minor')),
  title          text NOT NULL CHECK (length(btrim(title)) BETWEEN 3 AND 200),
  description    text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 8000),
  steps          text NULL CHECK (steps IS NULL OR length(steps) <= 8000),
  page_path      text NULL CHECK (page_path IS NULL OR length(page_path) <= 2000),
  page_title     text NULL CHECK (page_title IS NULL OR length(page_title) <= 300),
  browser        text NULL CHECK (browser IS NULL OR length(browser) <= 1000),
  screen         text NULL CHECK (screen IS NULL OR length(screen) <= 60),
  app_version    text NULL,
  client_errors  text[] NOT NULL DEFAULT '{}',                 -- what went wrong in the browser shortly before (newest first)
  status         text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'in_progress', 'fixed', 'wont_fix')),
  assignee_id    uuid NULL REFERENCES app_user,
  resolution     text NULL CHECK (resolution IS NULL OR length(resolution) <= 4000),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  closed_at      timestamptz NULL
);
CREATE INDEX feedback_created ON feedback (created_at DESC);
CREATE INDEX feedback_open ON feedback (status, created_at DESC) WHERE status IN ('new', 'in_progress');
CREATE INDEX feedback_user ON feedback (user_id, created_at DESC);

CREATE TABLE feedback_comment (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  feedback_id  uuid NOT NULL REFERENCES feedback,
  user_id      uuid NOT NULL REFERENCES app_user,
  body         text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 8000),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX feedback_comment_feedback ON feedback_comment (feedback_id, id);

CREATE TABLE feedback_file (
  id            uuid PRIMARY KEY,
  feedback_id   uuid NOT NULL REFERENCES feedback,
  kind          text NOT NULL CHECK (kind IN ('screenshot', 'attachment')),
  file_name     text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 200),
  content_type  text NOT NULL,
  size_bytes    bigint NOT NULL CHECK (size_bytes > 0),
  sha256        text NOT NULL,
  storage_key   text NOT NULL,                                 -- feedback/yyyy/MM/<id>.<ext>, under Images:Root
  uploaded_by   uuid NOT NULL REFERENCES app_user,
  uploaded_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX feedback_file_feedback ON feedback_file (feedback_id);

GRANT SELECT, INSERT, UPDATE ON feedback TO onepos_app;
GRANT SELECT, INSERT ON feedback_comment, feedback_file TO onepos_app;
