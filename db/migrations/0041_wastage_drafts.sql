-- One POS 0041: wastage to FACTS as a draft STV50 (finance gives batches and posts it there), or entered by finance as today.
ALTER TABLE company ADD COLUMN facts_wastage text NOT NULL DEFAULT 'finance' CHECK (facts_wastage IN ('finance', 'draft'));

-- A wastage line sent as a draft: 'draft' until finance posts the transfer in FACTS.
ALTER TABLE wastage DROP CONSTRAINT wastage_erp_status_check;
ALTER TABLE wastage ADD CONSTRAINT wastage_erp_status_check CHECK (erp_status IN ('none', 'pending', 'draft', 'posted', 'failed'));

-- The posting queue carries the drafts too (one per branch and send, no order).
ALTER TABLE erp_post ALTER COLUMN order_id DROP NOT NULL;
ALTER TABLE erp_post DROP CONSTRAINT erp_post_kind_check;
ALTER TABLE erp_post ADD CONSTRAINT erp_post_kind_check CHECK (kind IN ('invoice', 'refund', 'wastage'));
CREATE UNIQUE INDEX erp_post_wastage ON erp_post (doc_no) WHERE kind = 'wastage';
ALTER TABLE wastage ADD COLUMN erp_post_id uuid REFERENCES erp_post(id);
