/*
  ONE POS: rehearse usp_ONEPOS_PostDeposit as it is now (a till's bank deposit -> QRV50 SAVED, NOT POSTED), as POSBAKERY.
  Run with the procedure file loaded as a temporary procedure (#usp_ONEPOS_PostDeposit); everything is rolled back at the end:
  no QRV50 stays, the last QRV50 number is unchanged.
    A. Deposit 120.00 at Al Qusais (ERBQS CASH), slip REHEARSAL-DEP-1 -> QRV50 saved; no ledger lines, no approval
    B. The same deposit again (a retry)                               -> "Already sent", the same QRV50, no second one
    C. An unknown cash method                                          -> FAILED, nothing saved
*/
DECLARE @NextBefore NVARCHAR(40) = dbo.fn_GetNewDocNo(N'QRV50', '');
DECLARE @x NVARCHAR(MAX) = N'<data><Deposit><DepositId>00000000-0000-0000-0000-00000000d001</DepositId><DocDate>2026-11-20</DocDate><LocationCode>ERBQS</LocationCode>'
  + N'<CashMode>ERBQS CASH</CashMode><BankAccount>2322</BankAccount><Amount>120.00</Amount><SlipNo>REHEARSAL-DEP-1</SlipNo><TakenBy>Imesh</TakenBy>'
  + N'<Narration>Deposit REHEARSAL-DEP-1 Al Qusais 20/11/2026 taken by Imesh</Narration></Deposit></data>';
DECLARE @bad NVARCHAR(MAX) = REPLACE(REPLACE(@x, N'ERBQS CASH', N'NO SUCH CASH'), N'd001', N'd002');
SET XACT_ABORT OFF;
BEGIN TRANSACTION;
EXEC #usp_ONEPOS_PostDeposit @ClientID = N'POSBAKERY', @BodyXML = @x;
IF @@TRANCOUNT = 0 THROW 50000, 'Transaction lost: stopped.', 1;
EXEC #usp_ONEPOS_PostDeposit @ClientID = N'POSBAKERY', @BodyXML = @x;
IF @@TRANCOUNT = 0 THROW 50000, 'Transaction lost: stopped.', 1;
EXEC #usp_ONEPOS_PostDeposit @ClientID = N'POSBAKERY', @BodyXML = @bad;
IF @@TRANCOUNT = 0 THROW 50000, 'Transaction lost: stopped.', 1;
SELECT h.QRP_DOCNO, h.QRP_DOCDATE, h.QRP_AC_DOCNO, h.QRP_SUBLEDGER_DOCNO, h.QRP_OTHAC_DOCNO, h.QRP_AMOUNT, h.QRP_REFNO, h.QRP_UD_LABEL5, h.QRP_CREATED_BY, LEFT(h.QRP_NARRATION, 70) AS narration
FROM dbo.QRP_HEADER h WHERE h.QRP_FYCODE = N'CFY' AND h.QRP_DOCTYPE = N'QRV50' AND h.QRP_REFNO LIKE N'REHEARSAL-DEP%';
SELECT (SELECT COUNT(*) FROM dbo.ACCOUNT_TRANSACTION a JOIN dbo.QRP_HEADER h ON h.QRP_FYCODE = a.ACTRN_FYCODE AND h.QRP_DOCTYPE = a.ACTRN_DOCTYPE AND h.QRP_DOCNO = a.ACTRN_DOCNO
        WHERE h.QRP_DOCTYPE = N'QRV50' AND h.QRP_REFNO LIKE N'REHEARSAL-DEP%') AS ledger_lines,
       (SELECT COUNT(*) FROM dbo.ACTION_STATUS s JOIN dbo.QRP_HEADER h ON h.QRP_FYCODE = s.ACTION_FYCODE AND h.QRP_DOCTYPE = s.ACTION_DOCTYPE AND h.QRP_DOCNO = s.ACTION_DOCNO
        WHERE h.QRP_DOCTYPE = N'QRV50' AND h.QRP_REFNO LIKE N'REHEARSAL-DEP%') AS approvals;
IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
SELECT 'Rolled back' AS done, (SELECT COUNT(*) FROM dbo.QRP_HEADER WHERE QRP_DOCTYPE = N'QRV50' AND QRP_REFNO LIKE N'REHEARSAL-DEP%') AS qrv_left,
       @NextBefore AS next_qrv_before, dbo.fn_GetNewDocNo(N'QRV50', '') AS next_qrv_now;
