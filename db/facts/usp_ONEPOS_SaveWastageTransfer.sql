CREATE PROCEDURE dbo.usp_ONEPOS_SaveWastageTransfer
    @ClientID NVARCHAR(20),
    @BodyXML  XML
AS
/*
  One POS by AWS Distribution - an outlet's wastage into FACTS as a DRAFT stock transfer.        Created 17-10-2026 for One POS.

  Saves one STV50 (Stock Transfer Voucher-Bakery) from the outlet's location to its wastage location (e.g. ERBQS -> WEBQS), like
  the ones finance enters today, and leaves it UNPOSTED: no approval runs, so no stock moves and nothing is booked. Finance opens
  it in FACTS, gives each line its batch and posts it as now (FACTS' own approval then moves the stock).

  The number is FACTS' next STV50 number (lastno_master via usp_UpdateLastNoMaster_From_Transaction_Table and fn_GetNewDocNo, as
  FACTS' own saving does), taken under a lock so finance saving an STV at the same moment can't get the same number.
  Division and department are those of the last STV50 from the same location (finance's own), so the draft looks like theirs.
  The same Reference again returns the draft already saved for it (a retry never makes a second one).

  XML:  <data><Transfer>
          <DocDate>2026-10-17</DocDate> <FromLocation>ERBQS</FromLocation> <ToLocation>WEBQS</ToLocation>
          <Reference>One POS wastage EBQS 2026-10-17 #1</Reference>      (also the narration finance sees)
          <Line><ItemType>SMBK</ItemType><ItemCode>505486</ItemCode><ItemName>…</ItemName><Qty>1</Qty><Unit>PCS</Unit></Line> …
        </Transfer></data>
  Answer: DocumentNo (the STV50 number), status (SUCCESS | FAILED), description.
  FACTS' procedures are not changed by this one; dropping it changes nothing else.
*/
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @DocType NVARCHAR(6) = N'STV50', @FyCode NVARCHAR(6) = N'CFY',
            @DocDate DATETIME      = @BodyXML.value('(/data/Transfer/DocDate)[1]', 'DATETIME'),
            @From NVARCHAR(20)     = @BodyXML.value('(/data/Transfer/FromLocation)[1]', 'NVARCHAR(20)'),
            @To NVARCHAR(20)       = @BodyXML.value('(/data/Transfer/ToLocation)[1]', 'NVARCHAR(20)'),
            @Reference NVARCHAR(200) = @BodyXML.value('(/data/Transfer/Reference)[1]', 'NVARCHAR(200)'),
            @DocNo NVARCHAR(20), @Divn NVARCHAR(20), @Dept NVARCHAR(20);

    DECLARE @Lines TABLE (SrNo INT IDENTITY(1, 1), ItemType NVARCHAR(6), ItemCode NVARCHAR(20), ItemName NVARCHAR(300), Qty NUMERIC(18, 3), Unit NVARCHAR(20));
    INSERT INTO @Lines (ItemType, ItemCode, ItemName, Qty, Unit)
    SELECT l.value('(ItemType)[1]', 'NVARCHAR(6)'), l.value('(ItemCode)[1]', 'NVARCHAR(20)'), l.value('(ItemName)[1]', 'NVARCHAR(300)'),
           l.value('(Qty)[1]', 'NUMERIC(18,3)'), l.value('(Unit)[1]', 'NVARCHAR(20)')
    FROM @BodyXML.nodes('/data/Transfer/Line') AS x(l);

    IF @DocDate IS NULL OR ISNULL(@From, '') = '' OR ISNULL(@To, '') = '' OR ISNULL(@Reference, '') = '' OR NOT EXISTS (SELECT 1 FROM @Lines)
    BEGIN
        SELECT NULL AS DocumentNo, 'FAILED' AS status, N'Date, locations, reference and at least one line are needed.' AS description;
        RETURN;
    END
    IF EXISTS (SELECT 1 FROM @Lines WHERE ISNULL(ItemCode, '') = '' OR ISNULL(ItemType, '') = '' OR ISNULL(Qty, 0) <= 0)
    BEGIN
        SELECT NULL AS DocumentNo, 'FAILED' AS status, N'Every line needs an item code, its type and a quantity above zero.' AS description;
        RETURN;
    END

    -- Sent before (a retry): the draft already saved for this reference.
    SELECT TOP 1 @DocNo = TSF_DOCNO FROM dbo.TRANSFER_HEADER
    WHERE TSF_DOCTYPE = @DocType AND TSF_LOCATION_FM_DOCNO = @From AND TSF_LOCATION_TO_DOCNO = @To AND TSF_NARRATION = @Reference;
    IF @DocNo IS NOT NULL
    BEGIN
        SELECT @DocNo AS DocumentNo, 'SUCCESS' AS status, N'Already saved for this reference.' AS description;
        RETURN;
    END

    SELECT TOP 1 @Divn = TSF_DIVN_DOCNO, @Dept = TSF_DEPT_DOCNO FROM dbo.TRANSFER_HEADER
    WHERE TSF_DOCTYPE = @DocType AND TSF_LOCATION_FM_DOCNO = @From ORDER BY TSF_DOCDATE DESC;

    BEGIN TRY
        BEGIN TRANSACTION;
        -- One saver at a time for STV50 numbers (finance's screen updates the same last-number row).
        DECLARE @lock INT;
        EXEC @lock = sp_getapplock @Resource = N'ONEPOS_STV50_NUMBER', @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = 15000;
        IF @lock < 0 THROW 50001, 'The STV50 numbering is busy; try again.', 1;

        EXEC dbo.usp_UpdateLastNoMaster_From_Transaction_Table @DocType, NULL;
        SET @DocNo = dbo.fn_GetNewDocNo(@DocType, '');
        WHILE EXISTS (SELECT 1 FROM dbo.TRANSFER_HEADER WITH (UPDLOCK, HOLDLOCK) WHERE TSF_FYCODE = @FyCode AND TSF_DOCTYPE = @DocType AND TSF_DOCNO = @DocNo)
            SET @DocNo = dbo.fn_GetNewDocNo(@DocType, @DocNo);

        INSERT INTO dbo.TRANSFER_HEADER (TSF_FYCODE, TSF_DOCTYPE, TSF_DOCNO, TSF_DOCDATE, TSF_LOCATION_FM_DOCNO, TSF_LOCATION_TO_DOCNO, TSF_NARRATION,
                                         TSF_NET_AMOUNT, TSF_TOTAL_QTY, TSF_DIVN_DOCNO, TSF_DEPT_DOCNO, TSF_CREATED_BY, TSF_CREATED_TS, TSF_ACTIVE_STATUS)
        SELECT @FyCode, @DocType, @DocNo, @DocDate, @From, @To, @Reference, 0, SUM(Qty), @Divn, @Dept, @ClientID, GETDATE(), 0 FROM @Lines;

        INSERT INTO dbo.TRANSFER_DETAILS (TSFDET_FYCODE, TSFDET_DOCTYPE, TSFDET_DOCNO, TSFDET_DOCSRNO, TSFDET_STOCK_DOCTYPE, TSFDET_STOCK_DOCNO, TSFDET_STOCK_DESC,
                                          TSFDET_LOCATION_FM_DOCNO, TSFDET_LOCATION_TO_DOCNO, TSFDET_QTY, TSFDET_UNIT_DOCNO, TSFDET_DOCDATE)
        SELECT @FyCode, @DocType, @DocNo, SrNo, ItemType, ItemCode, ItemName, @From, @To, Qty, Unit, @DocDate FROM @Lines;

        EXEC dbo.usp_UpdateLastNoMaster_From_Transaction_Table @DocType, NULL;
        COMMIT TRANSACTION;
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
        SELECT NULL AS DocumentNo, 'FAILED' AS status, LEFT(ERROR_MESSAGE(), 400) AS description;
        RETURN;
    END CATCH

    SELECT @DocNo AS DocumentNo, 'SUCCESS' AS status, N'Draft STV50 saved (not posted).' AS description;
END
