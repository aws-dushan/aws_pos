-- One POS 0108: wastage (and marketing) of made-to-order items (a FACTS BOM valid that day). FACTS has none of them in stock until
-- they are made, so a POSTED repacking voucher (RPO50) makes them from their materials first, as for a sale; the wastage transfer
-- (or consumption) waits for it. after_id: the posting that must be posted in FACTS before this one is sent.
ALTER TABLE erp_post ADD COLUMN after_id uuid NULL REFERENCES erp_post(id);
CREATE INDEX erp_post_after ON erp_post (after_id) WHERE after_id IS NOT NULL;
