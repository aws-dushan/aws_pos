-- One POS 0061: wastage approval. Per branch: who approves wastage (a One POS user), where the request is emailed, and the FACTS
-- username the approved wastage is posted as (one FACTS allows to post STV50). With an approver set, recorded wastage waits for
-- approval; once approved it goes to FACTS as a POSTED STV50 (batches FIFO, FACTS' own approval) under that FACTS username, never
-- a draft. Without one, wastage works as before (finance, or a draft STV50 at the day's close).
ALTER TABLE branch ADD COLUMN wastage_approver_id uuid NULL REFERENCES app_user;
ALTER TABLE branch ADD COLUMN wastage_approval_email text NULL;
ALTER TABLE branch ADD COLUMN wastage_facts_user text NULL;

-- 'none': no approval needed (as before). 'waiting' -> 'approved' (sent to FACTS) or 'rejected' (taken off, never sent).
ALTER TABLE wastage ADD COLUMN approval text NOT NULL DEFAULT 'none' CHECK (approval IN ('none', 'waiting', 'approved', 'rejected'));
ALTER TABLE wastage ADD COLUMN requested_qty numeric(12,3) NULL;      -- what was asked, when the approver changed the quantity
ALTER TABLE wastage ADD COLUMN decided_by uuid NULL REFERENCES app_user;
ALTER TABLE wastage ADD COLUMN decided_at timestamptz NULL;
ALTER TABLE wastage ADD COLUMN decision_note text NULL;
CREATE INDEX wastage_waiting ON wastage (branch_id, recorded_at) WHERE approval = 'waiting';

-- The FACTS username a posting goes as (approved wastage: the branch approver's); null = One POS' own users, as before.
ALTER TABLE erp_post ADD COLUMN facts_user text NULL;

-- A notice can go to its own addresses (a wastage request to the branch's approver) instead of the company's alert list.
ALTER TABLE notice ADD COLUMN email_to text[] NULL;
ALTER TABLE notice ADD COLUMN link text NULL;
ALTER TABLE notice DROP CONSTRAINT IF EXISTS notice_kind_check;
ALTER TABLE notice ADD CONSTRAINT notice_kind_check CHECK (kind IN ('summary', 'alert', 'wastage'));
