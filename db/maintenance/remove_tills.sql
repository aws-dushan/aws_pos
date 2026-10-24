-- One POS: remove all tills (registers) and their device records. Run AFTER clear_transactions.sql (orders, shifts and payments
-- point at tills). Add the tills again under Companies & branches -> the branch -> Tills; each till PC then picks its till again.
\set ON_ERROR_STOP on
BEGIN;
DELETE FROM device_status;
DELETE FROM register;
SELECT 'left' AS check, (SELECT count(*) FROM register) AS tills;
COMMIT;
