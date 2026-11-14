/*
  One POS - ADVANCE payment method sign, 13-11-2026. ONE script: run it once, whole, in FactsERPAWSEB (SSMS: Execute).

  FACTS' payment method ADVANCE (ledger 2802 POS CUSTOMER ADVANCES) has the opposite sign of every other payment method:
    POS51: ADVANCE -1, the other 89 methods +1        PSR51: ADVANCE +1, the other 89 methods -1
  usp_SAL_APPR_ReceiptAccountsUpdation books each receipt line as RD_AMOUNT * PM_SIGN, so a POS51 paid by ADVANCE today
  CREDITS 2802 and DEBITS the customer (C0006) - the bill is not paid, a new advance is booked instead (test POS51 0001, 0002).
  After this script a POS51 paid by ADVANCE uses the advance like any other payment: Dr 2802 / Cr C0006;
  a PSR51 (return) refunds back to the advance: Dr C0006 / Cr 2802.

  Only the two ADVANCE rows change. Documents already posted are not changed (POS51 0001 and 0002 keep their entries);
  the new sign applies to documents posted from now on.
*/
SET XACT_ABORT ON;
BEGIN TRANSACTION;

SELECT 'before' AS step, PM_DOCNO, PM_DOC_DOCTYPE, PM_AC_DOCNO, PM_SIGN FROM dbo.PAYMENT_METHOD WHERE PM_DOCNO = N'ADVANCE' ORDER BY PM_DOC_DOCTYPE;

UPDATE dbo.PAYMENT_METHOD SET PM_SIGN =  1 WHERE PM_DOCNO = N'ADVANCE' AND PM_DOC_DOCTYPE = N'POS51' AND PM_SIGN = -1;
UPDATE dbo.PAYMENT_METHOD SET PM_SIGN = -1 WHERE PM_DOCNO = N'ADVANCE' AND PM_DOC_DOCTYPE = N'PSR51' AND PM_SIGN =  1;

SELECT 'after' AS step, PM_DOCNO, PM_DOC_DOCTYPE, PM_AC_DOCNO, PM_SIGN FROM dbo.PAYMENT_METHOD WHERE PM_DOCNO = N'ADVANCE' ORDER BY PM_DOC_DOCTYPE;
-- Every payment method now: POS51 all +1, PSR51 all -1.
SELECT PM_DOC_DOCTYPE, PM_SIGN, COUNT(*) AS methods FROM dbo.PAYMENT_METHOD WHERE PM_DOC_DOCTYPE IN (N'POS51', N'PSR51') GROUP BY PM_DOC_DOCTYPE, PM_SIGN ORDER BY 1, 2;

COMMIT TRANSACTION;
