-- One POS: clear the test transactions, keep the setup.                                                    22-10-2026
-- Kept: company and branch settings (FACTS posting, receipt and display, wastage approval, email), FACTS connection and payment
-- modes, users and roles, tills, floor and tables, the menu with prices, BOMs, delivery platforms, the audit log.
-- Removed: orders and their lines, payments, refunds, kitchen tickets, shifts, business days, cash in/out, no-sales, wastage,
-- approvals, platform payouts, the FACTS posting log, notices, sales summaries, the FACTS sync log, request keys.
-- The invoice numbering (INV) is NOT reset: FACTS already has INV-<branch>-000001…, and a number used again would revise
-- that FACTS document. Daily order numbers restart by themselves. FACTS itself is not touched by this script.
-- Take a backup first:  ssh aws-app /opt/aws/onepos/bin/onepos backup live
\set ON_ERROR_STOP on
BEGIN;
DELETE FROM idempotency_key;
DELETE FROM notice_read; DELETE FROM notice;
DELETE FROM sales_day_item; DELETE FROM sales_day_built;
DELETE FROM erp_sync;
UPDATE wastage SET erp_post_id = NULL;
DELETE FROM erp_post;
DELETE FROM receipt_link;
DELETE FROM kitchen_ticket_line; DELETE FROM kitchen_ticket;
DELETE FROM order_table;
DELETE FROM reservation_table; DELETE FROM reservation;
DELETE FROM loyalty_move; DELETE FROM voucher_move;
DELETE FROM payment;
DELETE FROM credit_note_line; DELETE FROM credit_note;
DELETE FROM ingredient_move;
DELETE FROM wastage;
DELETE FROM approval;
DELETE FROM platform_payout;
DELETE FROM delivery_check;
DELETE FROM order_line;
DELETE FROM pos_order;
DELETE FROM cash_movement; DELETE FROM no_sale; DELETE FROM bank_deposit;
DELETE FROM shift;
DELETE FROM business_day;
DELETE FROM number_series WHERE series LIKE 'order:%';
-- BOM versions used by the test repacking: as if never sent.
UPDATE bom_version SET locked_at = NULL, used_until = NULL WHERE locked_at IS NOT NULL OR used_until IS NOT NULL;
SELECT 'left' AS check, (SELECT count(*) FROM pos_order) AS orders, (SELECT count(*) FROM shift) AS shifts, (SELECT count(*) FROM business_day) AS days,
       (SELECT count(*) FROM erp_post) AS facts_log, (SELECT string_agg(series || '=' || next_no, ', ') FROM number_series) AS numbering;
COMMIT;
