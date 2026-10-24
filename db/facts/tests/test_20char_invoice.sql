/*
  One POS - test: does FACTS take a 20-character POS invoice number all the way through (sale, stock, accounts)?   19-10-2026

  Posts ONE test bill, exactly as One POS sends a bill, through One POS' procedure (usp_ONEPOS_SaveInvoice):
    Invoice  INV-EBL-TEST-0000001  (20 characters)   date today   location ERBQS
    1 x Cappuccino (SMBK 502113) at 15.00 incl. 5% VAT, paid ERBQS CASH 15.00
  It is a real POS51, auto-approved like every outlet bill: 1 Cappuccino off ERBQS stock and the sale in the accounts.

  Run part 1, read the checks in part 2, then run part 3 to remove the test bill (same procedure, Status = Delete).
*/

-- ===== 1. Post the test bill ===============================================================================================
DECLARE @no NVARCHAR(20) = N'INV-EBL-TEST-0000001';   -- 20 characters
DECLARE @day NVARCHAR(10) = CONVERT(NVARCHAR(10), GETDATE(), 23);
DECLARE @ts NVARCHAR(19) = CONVERT(NVARCHAR(19), GETDATE(), 120);
DECLARE @xml XML = N'<data><Invoice>'
  + N'<InvoiceNo>' + @no + N'</InvoiceNo><InvoiceDate>' + @day + N'</InvoiceDate><CurrCode>AED</CurrCode><ExchangeRate>1</ExchangeRate>'
  + N'<LocationCode>ERBQS</LocationCode><GrossAmount>15.00</GrossAmount><OtherAmount>0.00</OtherAmount><DiscountPercentage>0.00</DiscountPercentage>'
  + N'<DiscountAmount>0.00</DiscountAmount><NetAmount>15.00</NetAmount><TotalVATAmount>0.71</TotalVATAmount><VATRateType>-1</VATRateType><VATCategory>SR</VATCategory>'
  + N'<CreatedBy>One POS test</CreatedBy><CreatedTs>' + @ts + N'</CreatedTs><ModifiedTs>' + @ts + N'</ModifiedTs><Status>Open</Status><DeliveryMode>Takeaway</DeliveryMode>'
  + N'<Party><PartyCode></PartyCode><PartyName>One POS test</PartyName><MobileNo></MobileNo><TRNNumber></TRNNumber><Telephone></Telephone><Mobile></Mobile><Email></Email>'
  + N'<VatCategory>SR</VatCategory><VatRateType>-1</VatRateType><BillToAddress><Street></Street><City></City><State></State><Country>AE</Country><POBox></POBox></BillToAddress></Party>'
  + N'<DeliveryDetails><EDD>' + @day + N'</EDD><DeliveryTiming></DeliveryTiming></DeliveryDetails>'
  + N'<ReceiptDetails><ReceiptMode>ERBQS CASH</ReceiptMode><ReceiptAmount>15.00</ReceiptAmount><ReceiptVoucherNo></ReceiptVoucherNo><ReceiptChequeNo></ReceiptChequeNo><ReceiptChequeDate></ReceiptChequeDate></ReceiptDetails>'
  + N'<InvoiceDetails><ItemSrNo>1</ItemSrNo><ItemType>SMBK</ItemType><ItemCode>502113</ItemCode><ItemQty>1.000</ItemQty><ItemUnit>PCS</ItemUnit><ItemRate>15.00</ItemRate>'
  + N'<ItemGrossAmount>15.00</ItemGrossAmount><ItemDiscountAmount>0.00</ItemDiscountAmount><ItemDiscountPercentage>0.00</ItemDiscountPercentage>'
  + N'<ItemAmount>15.00</ItemAmount><VATPercentage>5.00</VATPercentage><VATAmount>0.71</VATAmount></InvoiceDetails>'
  + N'</Invoice></data>';
EXEC dbo.usp_ONEPOS_SaveInvoice @ClientID = N'ONEPOS', @BodyXML = @xml;
GO

-- ===== 2. Checks: every row must show the full 20-character number ==========================================================
DECLARE @no NVARCHAR(20) = N'INV-EBL-TEST-0000001';
SELECT 'sale header' AS what, SAL_DOCNO AS docno, LEN(SAL_DOCNO) AS len, SAL_NET_AMOUNT AS amount FROM dbo.SALES_HEADER WHERE SAL_DOCTYPE = 'POS51' AND SAL_DOCNO = @no;
SELECT 'sale lines' AS what, COUNT(*) AS n FROM dbo.SALES_DETAILS WHERE SALDET_DOCTYPE = 'POS51' AND SALDET_DOCNO = @no;
SELECT 'stock' AS what, COUNT(*) AS n FROM dbo.STOCK_TRANSACTION WHERE STTRN_DOCTYPE = 'POS51' AND STTRN_DOCNO = @no;
SELECT 'accounts' AS what, COUNT(*) AS n FROM dbo.ACCOUNT_TRANSACTION WHERE ACTRN_DOCTYPE = 'POS51' AND ACTRN_DOCNO = @no;
-- Expected: 1 header (len 20), 1 line, >= 1 stock row, >= 2 account rows. Accounts 0 = the number was cut somewhere: tell Claude.
GO

-- ===== 3. Remove the test bill (run after the checks) =====================================================================
/*
DECLARE @no NVARCHAR(20) = N'INV-EBL-TEST-0000001';
DECLARE @xml XML = N'<data><Invoice><InvoiceNo>' + @no + N'</InvoiceNo><InvoiceDate>' + CONVERT(NVARCHAR(10), GETDATE(), 23)
  + N'</InvoiceDate><LocationCode>ERBQS</LocationCode><Status>Delete</Status></Invoice></data>';
EXEC dbo.usp_ONEPOS_SaveInvoice @ClientID = N'ONEPOS', @BodyXML = @xml;
SELECT COUNT(*) AS left_in_facts FROM dbo.SALES_HEADER WHERE SAL_DOCTYPE = 'POS51' AND SAL_DOCNO = @no;   -- expected 0
*/
