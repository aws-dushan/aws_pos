/*
  One POS - platform order numbers on POS51, 24-10-2026. ONE script: run it once, whole, in FactsERPAWSEB (SSMS: Execute).

  Part 1 updates usp_ONEPOS_SaveInvoice: from now on every delivery platform bill (Talabat, Noon Food, Keeta…) gets the
  platform's order number in "Cust. LPO#" (SAL_REFNO) and SAL_REF1 when One POS posts it.
  Part 2 fills in the bills already posted: every One POS platform bill until 24-10-2026 (the numbers typed at the till).
  Only those bills, only a box that is still empty; it lists the bills it changed.
*/
CREATE OR ALTER PROCEDURE dbo.usp_ONEPOS_SaveInvoice
    @ClientID NVARCHAR(20),
    @BodyXML  XML
AS
/*
  One POS by AWS Distribution - POS bills into FACTS with their batches, FIFO.          Created 16-10-2026 for One POS.

  1. The bill is saved exactly as the outlet POS saves it today: FACTS' own usp_FQAPI_PWA_POS_SaveInvoice, called as is and
     not changed (a POS51 sale, auto-approved; the same invoice number again = a revision). Its answer is passed on unchanged.
  2. Each line of the POS51 sale whose item is batch-tracked (STOCK_MASTER.STKMST_ASK_BATCH_NO = 1) and has no batch yet gets
     one, FIFO: the earliest received batch (STOCK_BATCH_MASTER.BATMST_SDOCDATE, then expiry) of that item that has stock at the
     sale's location (dbo.fn_BatchNoUnique, as FACTS' batch update uses) received by the sale's day, and enough of it for the
     line: FACTS keeps one batch per line and its batch update refuses a batch with less stock than the line.
     The batch is written the way the batch update (BUDTE) approval writes it: SALES_DETAILS.SALDET_BATCH_DOCNO and
     STOCK_TRANSACTION.STTRN_BATCH_DOCNO of the same line. Lines are taken in order, so two lines of one bill share a batch
     only while it has enough for both.
     A made-to-order item (a BOM item) takes the batch its own bill's repacking voucher made: the posted RPO50 with Reference
     "One POS repacking <invoice no>" (usp_ONEPOS_PostRepacking, sent just before the bill) brought it in as RPO50-<number>-<line>;
     the sale takes that batch out again. Only when that batch hasn't enough left does the line go FIFO.          (20-10-2026)
  A delivery platform's bill (Talabat, Deliveroo…) gets the platform's order number in "Cust. LPO#" (SAL_REFNO) and SAL_REF1: One POS sends it
     as /data/Invoice/PlatformOrderNo, which FACTS' own procedure ignores.                                         (24-10-2026)
  3. A line no batch covers keeps no batch (for finance's batch update, as today) and is named in the answer. Giving batches
     can't undo the saved sale: if that step fails, the sale stays and the answer says so.

  Answer, besides FACTS' own: one row  OnePosBatches = lines given a batch, OnePosNoBatch = lines left without, OnePosNote.
  FACTS' procedures are not changed by this one; dropping it changes nothing else.
*/
BEGIN
    SET NOCOUNT ON;

    DECLARE @InvoiceNo NVARCHAR(20) = @BodyXML.value('(/data/Invoice/InvoiceNo)[1]', 'NVARCHAR(20)'),
            @Status    NVARCHAR(20) = @BodyXML.value('(/data/Invoice/Status)[1]', 'NVARCHAR(20)');

    -- 1. The bill, as the outlet POS sends it.
    EXEC dbo.usp_FQAPI_PWA_POS_SaveInvoice @ClientID = @ClientID, @BodyXML = @BodyXML;

    IF @InvoiceNo IS NULL OR ISNULL(@Status, '') = 'Delete' RETURN;

    DECLARE @FyCode NVARCHAR(6), @DocDate DATETIME, @Location NVARCHAR(20);
    SELECT TOP 1 @FyCode = SAL_FYCODE, @DocDate = SAL_DOCDATE, @Location = SAL_LOCATION_DOCNO
    FROM dbo.SALES_HEADER WHERE SAL_DOCTYPE = 'POS51' AND SAL_DOCNO = @InvoiceNo ORDER BY SAL_CREATED_TS DESC;
    IF @FyCode IS NULL RETURN;   -- not saved (FACTS answered FAILED): no lines to give batches to

    -- A delivery platform's order (Talabat…): its own order number in the bill's "Cust. LPO#" (SAL_REFNO, the box the screen
    -- shows, as on SI50) and in Reference 1 (SAL_REF1).                                                         (24-10-2026)
    DECLARE @PlatformOrderNo NVARCHAR(250) = NULLIF(LTRIM(RTRIM(@BodyXML.value('(/data/Invoice/PlatformOrderNo)[1]', 'NVARCHAR(250)'))), N'');
    IF @PlatformOrderNo IS NOT NULL
        UPDATE dbo.SALES_HEADER SET SAL_REFNO = @PlatformOrderNo, SAL_REF1 = @PlatformOrderNo
        WHERE SAL_FYCODE = @FyCode AND SAL_DOCTYPE = 'POS51' AND SAL_DOCNO = @InvoiceNo;

    -- 2. Batches, FIFO, line by line.
    DECLARE @Given INT = 0, @Missing NVARCHAR(1000) = N'', @Note NVARCHAR(400) = NULL;
    DECLARE @SrNo INT, @Stock NVARCHAR(20), @Qty NUMERIC(18, 3), @Batch NVARCHAR(20);

    BEGIN TRY
        BEGIN TRANSACTION;

        DECLARE lines CURSOR LOCAL FAST_FORWARD FOR
            SELECT d.SALDET_DOCSRNO, d.SALDET_STOCK_DOCNO, d.SALDET_QTY
            FROM dbo.SALES_DETAILS d
            JOIN dbo.STOCK_MASTER m ON m.STKMST_DOCNO = d.SALDET_STOCK_DOCNO AND m.STKMST_ASK_BATCH_NO = 1
            WHERE d.SALDET_FYCODE = @FyCode AND d.SALDET_DOCTYPE = 'POS51' AND d.SALDET_DOCNO = @InvoiceNo
              AND ISNULL(d.SALDET_BATCH_DOCNO, '') = '' AND d.SALDET_QTY > 0
            ORDER BY d.SALDET_DOCSRNO;
        OPEN lines;
        FETCH NEXT FROM lines INTO @SrNo, @Stock, @Qty;
        WHILE @@FETCH_STATUS = 0
        BEGIN
            SET @Batch = NULL;
            -- Recomputed for every line: a line given a batch above already counts against it.
            -- The bill's own repacking batch first, then FIFO.
            SELECT TOP 1 @Batch = b.BATMST_DOCNO
            FROM dbo.fn_BatchNoUnique(@Stock, @Location) b
            OUTER APPLY (SELECT TOP 1 1 AS Own FROM dbo.REPACKING_HEADER h
                         JOIN dbo.REPACKING_DETAILS_IN i ON i.REPIDET_FYCODE = h.REP_FYCODE AND i.REPIDET_DOCTYPE = h.REP_DOCTYPE AND i.REPIDET_DOCNO = h.REP_DOCNO
                         WHERE h.REP_DOCTYPE = 'RPO50' AND h.REP_LOCATION_DOCNO = @Location AND h.REP_NARRATION = N'One POS repacking ' + @InvoiceNo
                           AND h.REP_POSTED_TS IS NOT NULL AND i.REPIDET_STOCK_DOCNO = @Stock AND i.REPIDET_BATCH_DOCNO = b.BATMST_DOCNO) o
            WHERE b.BATMST_CLSQTY >= @Qty
              AND (o.Own = 1 OR b.BATMST_SDOCDATE IS NULL OR b.BATMST_SDOCDATE < DATEADD(DAY, 1, CAST(@DocDate AS DATE)))
            ORDER BY CASE WHEN o.Own = 1 THEN 0 ELSE 1 END, b.BATMST_SDOCDATE, b.BATMST_EXPIRY_DATE, b.BATMST_DOCNO;

            IF @Batch IS NOT NULL
            BEGIN
                UPDATE dbo.SALES_DETAILS SET SALDET_BATCH_DOCNO = @Batch
                WHERE SALDET_FYCODE = @FyCode AND SALDET_DOCTYPE = 'POS51' AND SALDET_DOCNO = @InvoiceNo AND SALDET_DOCSRNO = @SrNo;
                UPDATE dbo.STOCK_TRANSACTION SET STTRN_BATCH_DOCNO = @Batch
                WHERE STTRN_FYCODE = @FyCode AND STTRN_DOCTYPE = 'POS51' AND STTRN_DOCNO = @InvoiceNo AND STTRN_DOCSRNO = @SrNo;
                SET @Given += 1;
            END
            ELSE
                SET @Missing = LEFT(@Missing + CASE WHEN @Missing = N'' THEN N'' ELSE N', ' END + N'line ' + LTRIM(@SrNo) + N' (' + @Stock + N')', 1000);

            FETCH NEXT FROM lines INTO @SrNo, @Stock, @Qty;
        END
        CLOSE lines; DEALLOCATE lines;

        COMMIT TRANSACTION;
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
        IF CURSOR_STATUS('local', 'lines') >= 0 CLOSE lines;
        IF CURSOR_STATUS('local', 'lines') >= -1 DEALLOCATE lines;
        SET @Given = 0;
        SET @Note = LEFT(N'Sale saved; batches not given: ' + ERROR_MESSAGE(), 400);
    END CATCH

    -- 3. What happened, for One POS' posting log.
    SELECT @Given AS OnePosBatches,
           NULLIF(@Missing, N'') AS OnePosNoBatch,
           COALESCE(@Note, CASE WHEN @Missing <> N'' THEN N'No batch at ' + @Location + N' with enough stock for: ' + @Missing END) AS OnePosNote;
END

GO

-- Part 2: the platform bills already in FACTS.
BEGIN TRANSACTION;

DECLARE @Fix TABLE (DocNo NVARCHAR(20) PRIMARY KEY, OrderNo NVARCHAR(250), Platform NVARCHAR(50), BillDate DATE);
INSERT INTO @Fix (DocNo, OrderNo, Platform, BillDate) VALUES
    (N'INV-EBL-01-000018', N'5517', N'Noon Food', '2026-10-23'),
    (N'INV-EBL-01-000030', N'9318', N'Keeta', '2026-10-23'),
    (N'INV-EBL-01-000032', N'4671597948', N'Talabat', '2026-10-23'),
    (N'INV-EBL-01-000034', N'5008', N'Noon Food', '2026-10-23'),
    (N'INV-EBL-01-000048', N'4672020320', N'Talabat', '2026-10-23'),
    (N'INV-EBL-01-000052', N'4672238281', N'Talabat', '2026-10-23'),
    (N'INV-EBL-01-000057', N'4672832404', N'Talabat', '2026-10-24'),
    (N'INV-EBL-01-000061', N'4672840726', N'Talabat', '2026-10-24'),
    (N'INV-EBL-01-000069', N'4672894898', N'Talabat', '2026-10-24');

-- SALES_HEADER has triggers, so the changed bills are collected in a table (OUTPUT … INTO) and listed after.
DECLARE @Changed TABLE (DocNo NVARCHAR(20), DocDate DATETIME, CustLpo NVARCHAR(250), Ref1 NVARCHAR(250));

UPDATE h
SET SAL_REFNO = CASE WHEN NULLIF(LTRIM(RTRIM(h.SAL_REFNO)), '') IS NULL THEN f.OrderNo ELSE h.SAL_REFNO END,
    SAL_REF1  = CASE WHEN NULLIF(LTRIM(RTRIM(h.SAL_REF1)), '')  IS NULL THEN f.OrderNo ELSE h.SAL_REF1 END
OUTPUT inserted.SAL_DOCNO, inserted.SAL_DOCDATE, inserted.SAL_REFNO, inserted.SAL_REF1 INTO @Changed
FROM dbo.SALES_HEADER h JOIN @Fix f ON f.DocNo = h.SAL_DOCNO
WHERE h.SAL_DOCTYPE = 'POS51';

COMMIT TRANSACTION;

SELECT DocNo AS [Bill], DocDate AS [Date], CustLpo AS [Cust. LPO#], Ref1 AS [SAL_REF1] FROM @Changed ORDER BY DocNo;
GO
