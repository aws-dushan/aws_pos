-- One POS 0035: the FACTS sync history also records reading the card types and payment methods (0034).
ALTER TABLE erp_sync DROP CONSTRAINT erp_sync_kind_check;
ALTER TABLE erp_sync ADD CONSTRAINT erp_sync_kind_check CHECK (kind IN ('items','stock','enable_sold','payment_modes'));
