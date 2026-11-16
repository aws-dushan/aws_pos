/*
  One POS: rehearse usp_ONEPOS_PostDeposit (a till's bank deposit -> posted QRV50), as POSBAKERY. Everything is rolled back at the end:
  no QRV50 stays, nothing moves in the accounts, the last QRV50 number is unchanged.
    A. Deposit 120.00 at Al Qusais (ERBQS CASH), slip REHEARSAL-DEP-1 -> QRV50 posted: Dr 2322 120 / Cr 2205 120, nothing on 2202
    B. The same deposit again (a retry)                               -> "Already posted", the same QRV50, no second one
    C. An unknown cash method                                          -> FAILED, nothing saved
*/
DECLARE @NextBefore NVARCHAR(40) = dbo.fn_GetNewDocNo(N'QRV50', '');
DECLARE @x NVARCHAR(MAX) = N'<data><Deposit><DepositId>00000000-0000-0000-0000-00000000d001</DepositId><DocDate>2026-11-16</DocDate><LocationCode>ERBQS</LocationCode>'
  + N'<CashMode>ERBQS CASH</CashMode><BankAccount>2322</BankAccount><Amount>120.00</Amount><SlipNo>REHEARSAL-DEP-1</SlipNo><TakenBy>Imesh</TakenBy>'
  + N'<Narration>Deposit REHEARSAL-DEP-1 Al Qusais 16/11/2026 taken by Imesh</Narration></Deposit></data>';
DECLARE @bad NVARCHAR(MAX) = REPLACE(REPLACE(@x, N'ERBQS CASH', N'NO SUCH CASH'), N'd001', N'd002');
SET XACT_ABORT OFF;
BEGIN TRANSACTION;
EXEC dbo.usp_ONEPOS_PostDeposit @ClientID = N'POSBAKERY', @BodyXML = @x;
EXEC dbo.usp_ONEPOS_PostDeposit @ClientID = N'POSBAKERY', @BodyXML = @x;
EXEC dbo.usp_ONEPOS_PostDeposit @ClientID = N'POSBAKERY', @BodyXML = @bad;
SELECT h.QRP_DOCNO, h.QRP_AC_DOCNO, h.QRP_SUBLEDGER_DOCNO, h.QRP_OTHAC_DOCNO, h.QRP_AMOUNT, h.QRP_REFNO, h.QRP_UD_LABEL5, h.QRP_CREATED_BY, LEFT(h.QRP_NARRATION, 70) AS narration
FROM dbo.QRP_HEADER h WHERE h.QRP_FYCODE = N'CFY' AND h.QRP_DOCTYPE = N'QRV50' AND h.QRP_REFNO LIKE N'REHEARSAL-DEP%';
SELECT a.ACTRN_DOCNO, a.ACTRN_AC_DOCNO, a.ACTRN_SUBLEDGER_DOCNO, a.ACTRN_AMOUNT, a.ACTRN_NARRATION, a.ACTRN_DIVN_DOCNO
FROM dbo.ACCOUNT_TRANSACTION a JOIN dbo.QRP_HEADER h ON h.QRP_FYCODE = a.ACTRN_FYCODE AND h.QRP_DOCTYPE = a.ACTRN_DOCTYPE AND h.QRP_DOCNO = a.ACTRN_DOCNO
WHERE h.QRP_DOCTYPE = N'QRV50' AND h.QRP_REFNO LIKE N'REHEARSAL-DEP%' ORDER BY a.ACTRN_DOCNO, a.ACTRN_DOCSRNO;
IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
SELECT 'Rolled back' AS done, (SELECT COUNT(*) FROM dbo.QRP_HEADER WHERE QRP_DOCTYPE = N'QRV50' AND QRP_REFNO LIKE N'REHEARSAL-DEP%') AS qrv_left,
       @NextBefore AS next_qrv_before, dbo.fn_GetNewDocNo(N'QRV50', '') AS next_qrv_now;
