-- One POS 0014 — paper fallback (REQ ONL-04). When the till can't reach the server, the branch writes orders on pre-printed
-- pads; once back online a manager keys each slip in. It becomes a normal paid order of the open business day (tax invoice
-- number, VAT, payments), marked as from paper with the slip number and the time written on it.

ALTER TABLE pos_order ADD COLUMN source text NOT NULL DEFAULT 'till' CHECK (source IN ('till','paper'));
ALTER TABLE pos_order ADD COLUMN paper_ref text NULL;
ALTER TABLE pos_order ADD COLUMN paper_at timestamptz NULL;
-- A slip is keyed in once per branch.
CREATE UNIQUE INDEX pos_order_paper_ref ON pos_order (branch_id, paper_ref) WHERE paper_ref IS NOT NULL;
