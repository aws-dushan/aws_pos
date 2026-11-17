/*
  One POS: rehearse a cancelled future order's advances given back in FACTS: usp_ONEPOS_PostAdvanceReturn (one PV51 per order).
  Everything is rolled back at the end: no QRV51 or PV51 stays, nothing moves in the accounts, the last numbers are unchanged.
  Run after creating usp_ONEPOS_PostAdvance and usp_ONEPOS_PostAdvanceReturn (db/facts/).

    A. Two advances at Mercato (ERBJM) for future order REH-FO-2, as One POS sends them:
         REH-ADV-000011  50.00 by ERBJM Visa Card  -> QRV51 posted, net Dr 2315 50 / Cr 2802 50
         REH-ADV-000012  10.00 by ERBJM Cash       -> QRV51 posted, net Dr 2211 10 / Cr 2802 10
    B. The order is cancelled: ONE PV51 for both  -> line 1 Cr 2315 50 (linked to the first QRV51), line 2 Cr 2211 10 (linked to the
                                                     second), line 3 Dr 2802 60; department 102, posted
    C. The same PV51 again (a retry)             -> "Already posted", the same PV51, no second one
    D. The same advances under another number    -> FAILED "already given back", nothing saved
    E. An advance FACTS doesn't have             -> FAILED "has no posted QRV51", nothing saved
  Expected: 2802, 2315 and 2211 each net 0 over the two QRV51s and the PV51; C0006 nets 0.
*/
DECLARE @User NVARCHAR(20) = N'POSBAKERY', @Day NVARCHAR(10) = CONVERT(NVARCHAR(10), GETDATE(), 23);
DECLARE @NextQrv NVARCHAR(40) = dbo.fn_GetNewDocNo(N'QRV51', ''), @NextPv NVARCHAR(40) = dbo.fn_GetNewDocNo(N'PV51', '');
DECLARE @x NVARCHAR(MAX), @r NVARCHAR(MAX);
SET XACT_ABORT OFF;
BEGIN TRANSACTION;

-- A. The two advances.
SET @x = N'<data><Advance><DocumentNo>REH-ADV-000011</DocumentNo><Type>Receipt</Type><DocDate>' + @Day + N'</DocDate><LocationCode>ERBJM</LocationCode>'
       + N'<ReceiptMode>ERBJM Visa Card</ReceiptMode><Amount>50.00</Amount><FutureOrderNo>REH-FO-2</FutureOrderNo><CollectionDate>' + @Day + N'</CollectionDate>'
       + N'<CustomerName>Rehearsal</CustomerName><MobileNo></MobileNo><Narration>Advance REH-FO-2 Rehearsal</Narration><CreatedBy>One POS test</CreatedBy></Advance></data>';
EXEC dbo.usp_ONEPOS_PostAdvance @ClientID = @User, @BodyXML = @x;
IF @@TRANCOUNT > 0
BEGIN
    SET @x = REPLACE(REPLACE(REPLACE(@x, N'REH-ADV-000011', N'REH-ADV-000012'), N'ERBJM Visa Card', N'ERBJM Cash'), N'<Amount>50.00', N'<Amount>10.00');
    EXEC dbo.usp_ONEPOS_PostAdvance @ClientID = @User, @BodyXML = @x;
END

-- B. Cancelled: one PV51.  C. The same again.
SET @r = N'<data><AdvanceReturn><DocumentNo>REH-ADV-000013</DocumentNo><DocDate>' + @Day + N'</DocDate><LocationCode>ERBJM</LocationCode>'
       + N'<FutureOrderNo>REH-FO-2</FutureOrderNo><CustomerName>Rehearsal</CustomerName><Narration>Advance return REH-FO-2 Rehearsal</Narration><CreatedBy>One POS test</CreatedBy>'
       + N'<Line><AdvanceNo>REH-ADV-000011</AdvanceNo><Amount>50.00</Amount></Line><Line><AdvanceNo>REH-ADV-000012</AdvanceNo><Amount>10.00</Amount></Line>'
       + N'</AdvanceReturn></data>';
IF @@TRANCOUNT > 0 EXEC dbo.usp_ONEPOS_PostAdvanceReturn @ClientID = @User, @BodyXML = @r;
IF @@TRANCOUNT > 0 EXEC dbo.usp_ONEPOS_PostAdvanceReturn @ClientID = @User, @BodyXML = @r;
-- D. Given back twice.  E. Unknown advance.
IF @@TRANCOUNT > 0 BEGIN SET @x = REPLACE(@r, N'REH-ADV-000013', N'REH-ADV-000014'); EXEC dbo.usp_ONEPOS_PostAdvanceReturn @ClientID = @User, @BodyXML = @x; END
IF @@TRANCOUNT > 0 BEGIN SET @x = REPLACE(REPLACE(@r, N'REH-ADV-000013', N'REH-ADV-000015'), N'REH-ADV-000011', N'REH-ADV-999999'); EXEC dbo.usp_ONEPOS_PostAdvanceReturn @ClientID = @User, @BodyXML = @x; END

-- 1. Still in one piece? (1 = nothing rolled back early)
SELECT @@TRANCOUNT AS open_tran;
IF @@TRANCOUNT > 0
BEGIN
    -- 2. The QRV51s and the PV51s (expected: two QRV51s, ONE PV51 for REH-ADV-000013, posted).
    SELECT QRP_DOCNO, QRP_OTHAC_DOCNO AS others_ac, QRP_AMOUNT, QRP_REFNO, QRP_CR_DEPT_DOCNO FROM dbo.QRP_HEADER WHERE QRP_DOCTYPE = N'QRV51' AND QRP_REFNO LIKE N'REH-ADV-%';
    SELECT RP_DOCNO, RP_DOCDATE, RP_AC_DOCNO, RP_AC_DOCNO2, RP_AMOUNT, RP_MODE, RP_DRCR_SIGN, RP_DEPT_DOCNO, RP_REFNO, RP_BEFORE_DOCTYPE, RP_BEFORE_DOCNO, RP_POSTED_BY, RP_NARRATION,
           (SELECT COUNT(*) FROM dbo.ACTION_STATUS WHERE ACTION_FYCODE = RP_FYCODE AND ACTION_DOCTYPE = RP_DOCTYPE AND ACTION_DOCNO = RP_DOCNO) AS posted
    FROM dbo.RP_HEADER WHERE RP_DOCTYPE = N'PV51' AND RP_REFNO LIKE N'REH-ADV-%';
    -- 3. The PV51's lines (0 is FACTS' own copy of the header, not booked).
    SELECT d.RPDET_DOCNO, d.RPDET_DOCSRNO, d.RPDET_AC_DOCNO, d.RPDET_AMOUNT, d.RPDET_DRCR_SIGN, d.RPDET_DEPT_DOCNO, d.RPDET_AUTO_ENTRY, d.RPDET_BEFORE_DOCTYPE, d.RPDET_BEFORE_DOCNO
    FROM dbo.RP_DETAILS d JOIN dbo.RP_HEADER h ON h.RP_FYCODE = d.RPDET_FYCODE AND h.RP_DOCTYPE = d.RPDET_DOCTYPE AND h.RP_DOCNO = d.RPDET_DOCNO
    WHERE h.RP_DOCTYPE = N'PV51' AND h.RP_REFNO LIKE N'REH-ADV-%' ORDER BY d.RPDET_DOCNO, d.RPDET_DOCSRNO;
    -- 4. Every ledger line (FACTS: + = credit, - = debit).
    SELECT a.ACTRN_DOCTYPE, a.ACTRN_DOCNO, a.ACTRN_DOCSRNO, a.ACTRN_AC_DOCNO, m.ACMST_DESC, a.ACTRN_SUBLEDGER_DOCNO, a.ACTRN_AMOUNT, a.ACTRN_DEPT_DOCNO
    FROM dbo.ACCOUNT_TRANSACTION a LEFT JOIN dbo.ACCOUNT_MASTER m ON m.ACMST_DOCNO = a.ACTRN_AC_DOCNO
    WHERE (a.ACTRN_DOCTYPE = N'QRV51' AND a.ACTRN_DOCNO IN (SELECT QRP_DOCNO FROM dbo.QRP_HEADER WHERE QRP_DOCTYPE = N'QRV51' AND QRP_REFNO LIKE N'REH-ADV-%'))
       OR (a.ACTRN_DOCTYPE = N'PV51' AND a.ACTRN_DOCNO IN (SELECT RP_DOCNO FROM dbo.RP_HEADER WHERE RP_DOCTYPE = N'PV51' AND RP_REFNO LIKE N'REH-ADV-%'))
    ORDER BY a.ACTRN_DOCTYPE DESC, a.ACTRN_DOCNO, a.ACTRN_DOCSRNO;
    -- 5. Totals per account over the two QRV51s and the PV51 (expected: every one 0).
    SELECT a.ACTRN_AC_DOCNO, a.ACTRN_SUBLEDGER_DOCNO, SUM(a.ACTRN_AMOUNT) AS net
    FROM dbo.ACCOUNT_TRANSACTION a
    WHERE (a.ACTRN_DOCTYPE = N'QRV51' AND a.ACTRN_DOCNO IN (SELECT QRP_DOCNO FROM dbo.QRP_HEADER WHERE QRP_DOCTYPE = N'QRV51' AND QRP_REFNO LIKE N'REH-ADV-%'))
       OR (a.ACTRN_DOCTYPE = N'PV51' AND a.ACTRN_DOCNO IN (SELECT RP_DOCNO FROM dbo.RP_HEADER WHERE RP_DOCTYPE = N'PV51' AND RP_REFNO LIKE N'REH-ADV-%'))
    GROUP BY a.ACTRN_AC_DOCNO, a.ACTRN_SUBLEDGER_DOCNO ORDER BY 1;
END

IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
SELECT 'Rolled back' AS done,
       (SELECT COUNT(*) FROM dbo.QRP_HEADER WHERE QRP_DOCTYPE = N'QRV51' AND QRP_REFNO LIKE N'REH-ADV-%') AS qrv51_left,
       (SELECT COUNT(*) FROM dbo.RP_HEADER WHERE RP_DOCTYPE = N'PV51' AND RP_REFNO LIKE N'REH-ADV-%') AS pv51_left,
       @NextQrv AS next_qrv51_before, dbo.fn_GetNewDocNo(N'QRV51', '') AS next_qrv51_now,
       @NextPv AS next_pv51_before, dbo.fn_GetNewDocNo(N'PV51', '') AS next_pv51_now;
