-- One POS 0086: pre-approved stock requests, per branch. Switched on, a request the branch sends goes to FACTS at once as a POSTED
-- STR50 (one per request), recorded as approved by whoever sent it; no approver is needed, only the FACTS username it is posted as,
-- and the email is just a copy. Requests waiting when it is switched on stay with the approver. A request can also be kept as a
-- draft (approval 'draft'): nothing goes anywhere until it is sent, and it can be changed or deleted until then.
ALTER TABLE branch ADD COLUMN request_preapproved boolean NOT NULL DEFAULT false;

ALTER TABLE stock_request DROP CONSTRAINT stock_request_approval_check;
ALTER TABLE stock_request ADD CONSTRAINT stock_request_approval_check CHECK (approval IN ('draft', 'waiting', 'approved', 'rejected', 'cancelled'));
