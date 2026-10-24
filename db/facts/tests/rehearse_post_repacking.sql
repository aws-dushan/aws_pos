-- One POS: rehearse usp_ONEPOS_PostRepacking with one CAPPUCCINO at Al Qusais (ERBQS), as user POSBAKERY (the user One POS sends it as). Everything is rolled back at the end:
-- no RPO50 stays, no stock moves, the RPO50 last number is unchanged. Run after creating / altering the procedure.
SET XACT_ABORT OFF;
BEGIN TRANSACTION;

EXEC dbo.usp_ONEPOS_PostRepacking @ClientID = N'POSBAKERY', @BodyXML = N'<data><Repacking><DocDate>2026-10-20</DocDate><Location>ERBQS</Location>
  <Reference>One POS repacking REHEARSAL</Reference>
  <Item><ItemType>SMBK</ItemType><ItemCode>502113</ItemCode><ItemName>CAPPUCCINO</ItemName><Qty>1</Qty><Unit>PCS</Unit>
    <Material><ItemType>SMBK</ItemType><ItemCode>505302</ItemCode><ItemName>COFFEE BEAN BRAZIL</ItemName><Qty>0.02</Qty><Unit>KG</Unit></Material>
    <Material><ItemType>SMBK</ItemType><ItemCode>502901</ItemCode><ItemName>MILK FRESH 2LTR</ItemName><Qty>0.16</Qty><Unit>LTR</Unit></Material>
  </Item></Repacking></data>';

-- What it made (inside the transaction):
SELECT REP_DOCNO, REP_NARRATION, REP_POSTED_BY, REP_POSTED_TS FROM dbo.REPACKING_HEADER WHERE REP_DOCTYPE = 'RPO50' AND REP_NARRATION = N'One POS repacking REHEARSAL';
SELECT o.REPODET_DOCSRNO, o.REPODET_STOCK_DOCNO, o.REPODET_QTY, o.REPODET_UNIT_DOCNO, o.REPODET_BATCH_DOCNO, o.REPODET_RATE, o.REPODET_AMOUNT
FROM dbo.REPACKING_DETAILS_OUT o JOIN dbo.REPACKING_HEADER h ON h.REP_FYCODE = o.REPODET_FYCODE AND h.REP_DOCTYPE = o.REPODET_DOCTYPE AND h.REP_DOCNO = o.REPODET_DOCNO
WHERE h.REP_DOCTYPE = 'RPO50' AND h.REP_NARRATION = N'One POS repacking REHEARSAL';
SELECT t.STTRN_DOCSRNO, t.STTRN_STOCK_DOCNO, t.STTRN_QTY, t.STTRN_BATCH_DOCNO
FROM dbo.STOCK_TRANSACTION t JOIN dbo.REPACKING_HEADER h ON h.REP_DOCTYPE = t.STTRN_DOCTYPE AND h.REP_DOCNO = t.STTRN_DOCNO
WHERE h.REP_DOCTYPE = 'RPO50' AND h.REP_NARRATION = N'One POS repacking REHEARSAL';

-- Approved the way FACTS' Approve button records it (finance's RPO50 2393 has the same):
SELECT a.ACTION_DOCNO, a.ACTION_KEY, a.ACTION_TYPE, a.ACTION_USER_DOCNO FROM dbo.ACTION_STATUS a JOIN dbo.REPACKING_HEADER h ON h.REP_DOCTYPE = a.ACTION_DOCTYPE AND h.REP_DOCNO = a.ACTION_DOCNO
WHERE h.REP_DOCTYPE = 'RPO50' AND h.REP_NARRATION = N'One POS repacking REHEARSAL';
SELECT l.AED_DOCNO, l.AED_STATUS, l.AED_REF1, l.AED_USER_CODE FROM dbo.ADD_EDIT_DELETE_LOG l JOIN dbo.REPACKING_HEADER h ON h.REP_DOCTYPE = l.AED_DOCTYPE AND h.REP_DOCNO = l.AED_DOCNO
WHERE h.REP_DOCTYPE = 'RPO50' AND h.REP_NARRATION = N'One POS repacking REHEARSAL';

IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
SELECT 'Rolled back' AS done;
