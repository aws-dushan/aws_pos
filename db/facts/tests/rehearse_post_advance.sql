/*
  One POS: rehearse future orders' advances in FACTS: usp_ONEPOS_PostAdvance (advance -> QRV51) and the bill paid by ADVANCE, linked
  to its advances (usp_ONEPOS_SaveInvoice). Everything is rolled back at the end: no QRV51 or POS51 stays, nothing moves in the
  accounts or stock, the last numbers are unchanged, and the two FACTS setup changes below are undone too.
  Run after creating usp_ONEPOS_PostAdvance (db/facts/usp_ONEPOS_PostAdvance.sql) and running db/facts/fixes/2026-11-13_future_order_link.sql.

  Inside the transaction, as the FACTS developer will set it up for real (skipped if already done):
    1a. PAYMENT_METHOD ADVANCE: sign +1 on POS51, -1 on PSR51
    1b. a sub-ledger C0006 under account 2802 POS CUSTOMER ADVANCES
  Then:
    A. Advance REH-ADV-000001: 6.00 by ERBQS VISA CARD   -> QRV51 posted: Dr 2315 6 / Cr 2802 6
    B. The same advance again (a retry)                    -> "Already posted", the same QRV51, no second one
    C. Bill REH-ADV-INV-0001 for future order REH-FO-1: 1 x Cappuccino (502113) 15.00 at ERBQS, paid ADVANCE 6.00 + ERBQS CASH 9.00
                                                           -> POS51: Dr 2802 6, Dr 2205 9, Cr C0006 15 (and the sale as today),
                                                              linked: SAL_REFNO2 "REH-FO-1 advances QRV51 <no>", the QRV51's QRP_BEFORE = this POS51
  Expected: each call answers SUCCESS (A, B; C as FACTS answers a bill), 2802 nets to 0, C0006 nets to 0 on the bill.
*/
DECLARE @User NVARCHAR(20) = N'POSBAKERY', @Day NVARCHAR(10) = CONVERT(NVARCHAR(10), GETDATE(), 23), @Ts NVARCHAR(19) = CONVERT(NVARCHAR(19), GETDATE(), 120);
DECLARE @NextQrv NVARCHAR(40) = dbo.fn_GetNewDocNo(N'QRV51', '');
DECLARE @x NVARCHAR(MAX);
SET XACT_ABORT OFF;
BEGIN TRANSACTION;

-- 1a / 1b (rolled back with the rest).
UPDATE dbo.PAYMENT_METHOD SET PM_SIGN =  1 WHERE PM_DOCNO = N'ADVANCE' AND PM_DOC_DOCTYPE = N'POS51' AND PM_SIGN = -1;
UPDATE dbo.PAYMENT_METHOD SET PM_SIGN = -1 WHERE PM_DOCNO = N'ADVANCE' AND PM_DOC_DOCTYPE = N'PSR51' AND PM_SIGN =  1;
IF NOT EXISTS (SELECT 1 FROM dbo.SUBLEDGER_MASTER WHERE SUBLMST_DOCTYPE = N'2802')
    INSERT INTO dbo.SUBLEDGER_MASTER (SUBLMST_DOCTYPE, SUBLMST_DOCNO, SUBLMST_DESC, SUBLMST_CR_DAYS, SUBLMST_ACTIVE_STATUS, SUBLMST_TRANSACTION_STOP,
                                      SUBLMST_TRANSACTION_BLOCK_USERS, SUBLMST_REPORT_STOP, SUBLMST_REPORT_BLOCK_USERS)
    VALUES (N'2802', N'C0006', N'CASH CUSTOMER POS - ADVANCES', 0, 1, 0, 0, 0, 0);

-- A. Advance 6.00 by card.  B. The same again.
SET @x = N'<data><Advance><DocumentNo>REH-ADV-000001</DocumentNo><Type>Receipt</Type><DocDate>' + @Day + N'</DocDate><LocationCode>ERBQS</LocationCode>'
       + N'<ReceiptMode>ERBQS VISA CARD</ReceiptMode><Amount>6.00</Amount><FutureOrderNo>REH-FO-1</FutureOrderNo><CollectionDate>' + @Day + N'</CollectionDate>'
       + N'<CustomerName>Rehearsal</CustomerName><MobileNo></MobileNo><Narration>Advance REH-FO-1 Rehearsal</Narration><CreatedBy>One POS test</CreatedBy></Advance></data>';
EXEC dbo.usp_ONEPOS_PostAdvance @ClientID = @User, @BodyXML = @x;
IF @@TRANCOUNT > 0 EXEC dbo.usp_ONEPOS_PostAdvance @ClientID = @User, @BodyXML = @x;

-- C. The bill, paid ADVANCE 6 + cash 9, as One POS sends a future order's bill.
IF @@TRANCOUNT > 0 BEGIN
    DECLARE @inv XML = N'<data><Invoice>'
      + N'<InvoiceNo>REH-ADV-INV-0001</InvoiceNo><InvoiceDate>' + @Day + N'</InvoiceDate><CurrCode>AED</CurrCode><ExchangeRate>1</ExchangeRate>'
      + N'<LocationCode>ERBQS</LocationCode><GrossAmount>15.00</GrossAmount><OtherAmount>0.00</OtherAmount><DiscountPercentage>0.00</DiscountPercentage>'
      + N'<DiscountAmount>0.00</DiscountAmount><NetAmount>15.00</NetAmount><TotalVATAmount>0.71</TotalVATAmount><VATRateType>-1</VATRateType><VATCategory>SR</VATCategory>'
      + N'<CreatedBy>One POS test</CreatedBy><CreatedTs>' + @Ts + N'</CreatedTs><ModifiedTs>' + @Ts + N'</ModifiedTs><Status>Open</Status><DeliveryMode>Takeaway</DeliveryMode>'
      + N'<Party><PartyCode></PartyCode><PartyName>REH-FO-1 Rehearsal</PartyName><MobileNo></MobileNo><TRNNumber></TRNNumber><Telephone></Telephone><Mobile></Mobile><Email></Email>'
      + N'<VatCategory>SR</VatCategory><VatRateType>-1</VatRateType><BillToAddress><Street></Street><City></City><State></State><Country>AE</Country><POBox></POBox></BillToAddress></Party>'
      + N'<DeliveryDetails><EDD>' + @Day + N'</EDD><DeliveryTiming></DeliveryTiming></DeliveryDetails>'
      + N'<FutureOrder><FutureOrderNo>REH-FO-1</FutureOrderNo><AdvanceNo>REH-ADV-000001</AdvanceNo></FutureOrder>'
      + N'<ReceiptDetails><ReceiptMode>ADVANCE</ReceiptMode><ReceiptAmount>6.00</ReceiptAmount><ReceiptVoucherNo></ReceiptVoucherNo><ReceiptChequeNo></ReceiptChequeNo><ReceiptChequeDate></ReceiptChequeDate></ReceiptDetails>'
      + N'<ReceiptDetails><ReceiptMode>ERBQS CASH</ReceiptMode><ReceiptAmount>9.00</ReceiptAmount><ReceiptVoucherNo></ReceiptVoucherNo><ReceiptChequeNo></ReceiptChequeNo><ReceiptChequeDate></ReceiptChequeDate></ReceiptDetails>'
      + N'<InvoiceDetails><ItemSrNo>1</ItemSrNo><ItemType>SMBK</ItemType><ItemCode>502113</ItemCode><ItemQty>1.000</ItemQty><ItemUnit>PCS</ItemUnit><ItemRate>15.00</ItemRate>'
      + N'<ItemGrossAmount>15.00</ItemGrossAmount><ItemDiscountAmount>0.00</ItemDiscountAmount><ItemDiscountPercentage>0.00</ItemDiscountPercentage>'
      + N'<ItemAmount>15.00</ItemAmount><VATPercentage>5.00</VATPercentage><VATAmount>0.71</VATAmount></InvoiceDetails>'
      + N'</Invoice></data>';
    EXEC dbo.usp_ONEPOS_SaveInvoice @ClientID = N'ONEPOS', @BodyXML = @inv;
END

-- 1. Still in one piece? (1 = nothing rolled back early)
SELECT @@TRANCOUNT AS open_tran;
IF @@TRANCOUNT > 0
BEGIN
    -- 2. The QRV51 (one, posted) and the link to the bill.
    SELECT QRP_DOCNO, QRP_DOCDATE, QRP_MODE_DOCNO, QRP_AC_DOCNO AS party, QRP_SUBLEDGER_DOCNO AS sub, QRP_OTHAC_DOCNO AS others_ac, QRP_AMOUNT, QRP_REFNO,
           QRP_CR_DEPT_DOCNO, QRP_POSTED_BY, QRP_BEFORE_DOCTYPE AS linked_doctype, QRP_BEFORE_DOCNO AS linked_bill
    FROM dbo.QRP_HEADER WHERE QRP_DOCTYPE = N'QRV51' AND QRP_REFNO LIKE N'REH-ADV-%';
    -- 3. The bill and its link to the advances.
    SELECT SAL_DOCNO, SAL_NET_AMOUNT, SAL_REFNO2 AS linked_advances FROM dbo.SALES_HEADER WHERE SAL_DOCTYPE = N'POS51' AND SAL_DOCNO = N'REH-ADV-INV-0001';
    -- 4. Every ledger line (FACTS: + = credit, - = debit).
    SELECT a.ACTRN_DOCTYPE, a.ACTRN_DOCNO, a.ACTRN_DOCSRNO, a.ACTRN_AC_DOCNO, m.ACMST_DESC, a.ACTRN_SUBLEDGER_DOCNO, a.ACTRN_AMOUNT, a.ACTRN_DEPT_DOCNO
    FROM dbo.ACCOUNT_TRANSACTION a LEFT JOIN dbo.ACCOUNT_MASTER m ON m.ACMST_DOCNO = a.ACTRN_AC_DOCNO
    WHERE (a.ACTRN_DOCTYPE = N'QRV51' AND a.ACTRN_DOCNO IN (SELECT QRP_DOCNO FROM dbo.QRP_HEADER WHERE QRP_DOCTYPE = N'QRV51' AND QRP_REFNO LIKE N'REH-ADV-%'))
       OR (a.ACTRN_DOCTYPE = N'POS51' AND a.ACTRN_DOCNO = N'REH-ADV-INV-0001')
    ORDER BY a.ACTRN_DOCTYPE DESC, a.ACTRN_DOCSRNO;
    -- 5. The totals that matter (both expected 0): 2802 over the QRV51 and the bill, C0006 on the bill.
    SELECT SUM(CASE WHEN a.ACTRN_AC_DOCNO = N'2802' THEN a.ACTRN_AMOUNT ELSE 0 END) AS [2802 net],
           SUM(CASE WHEN a.ACTRN_DOCTYPE = N'POS51' AND a.ACTRN_AC_DOCNO = N'AR' AND a.ACTRN_SUBLEDGER_DOCNO = N'C0006' THEN a.ACTRN_AMOUNT ELSE 0 END) AS [C0006 net on bill]
    FROM dbo.ACCOUNT_TRANSACTION a
    WHERE (a.ACTRN_DOCTYPE = N'QRV51' AND a.ACTRN_DOCNO IN (SELECT QRP_DOCNO FROM dbo.QRP_HEADER WHERE QRP_DOCTYPE = N'QRV51' AND QRP_REFNO LIKE N'REH-ADV-%'))
       OR (a.ACTRN_DOCTYPE = N'POS51' AND a.ACTRN_DOCNO = N'REH-ADV-INV-0001');
END

IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
SELECT 'Rolled back' AS done,
       (SELECT COUNT(*) FROM dbo.QRP_HEADER WHERE QRP_DOCTYPE = N'QRV51' AND QRP_REFNO LIKE N'REH-ADV-%') AS qrv51_left,
       (SELECT COUNT(*) FROM dbo.SALES_HEADER WHERE SAL_DOCTYPE = N'POS51' AND SAL_DOCNO = N'REH-ADV-INV-0001') AS pos51_left,
       (SELECT PM_SIGN FROM dbo.PAYMENT_METHOD WHERE PM_DOCNO = N'ADVANCE' AND PM_DOC_DOCTYPE = N'POS51') AS advance_sign_pos51_now,
       (SELECT COUNT(*) FROM dbo.SUBLEDGER_MASTER WHERE SUBLMST_DOCTYPE = N'2802') AS subledgers_2802_now,
       @NextQrv AS next_qrv51_before, dbo.fn_GetNewDocNo(N'QRV51', '') AS next_qrv51_now;
