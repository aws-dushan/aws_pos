CREATE PROCEDURE dbo.usp_ONEPOS_PostTransferRequest
    @ClientID NVARCHAR(20),
    @BodyXML  XML
AS
/*
  One POS by AWS Distribution - an outlet's approved stock request into FACTS as a POSTED STR50.       Created 26-10-2026 for One POS.

  The outlet asked a store for stock in One POS and the branch's request approver approved it; this places the request in FACTS the
  way the outlets' own STR50s are made today (e.g. 9268, ERBQS asking 5ALKD), posted, never a draft:
  1. Saves one STR50 (Stock Transfer Request-Bakery) from the store to the outlet (e.g. 5ALK1 -> ERBQS): rate 0, "after document"
     quantity 0 (each STV50 the store sends against it adds to it), salesman, division and department of the outlet's last STR50.
     Each line carries a batch of the item as FACTS' own STR50 lines do (the store's oldest batch with stock, else the item's newest
     batch); the store's STV50 picks its own batches when it sends. Quantities in the item's base unit (STOCK_UNIT).
     Number = FACTS' next STR50 number, under a lock. The save is logged as FACTS' screen logs it (ADD_EDIT_DELETE_LOG "A").
  2. Posts it the way FACTS does on save: FACTS' own usp_DocumentAutoApprove as @ClientID (the approver's FACTS username; STR50
     "Transaction Posting" has no user limit) runs STR50's steps (usp_TSF_APPR_StockApproval, which moves no stock for a request,
     then Document Allocation), records the approval (ACTION_STATUS), sets TSF_POSTED_BY / TSF_POSTED_TS and logs it ("R").
  FACTS' approval refuses it: nothing stays in FACTS (the unposted request is removed again) and the answer is FAILED with the
  reason; One POS retries it. The same Reference again (a retry) finds the request already posted and answers it.

  XML:  <data><Transfer>
          <DocDate>2026-10-26</DocDate> <FromLocation>5ALK1</FromLocation> <ToLocation>ERBQS</ToLocation>
          <Reference>One POS request EB-QS REQ-0042 · for 27 Oct</Reference>      (also the narration the store sees)
          <Line><ItemType>SMBK</ItemType><ItemCode>501477</ItemCode><ItemName>…</ItemName><Qty>3</Qty><Unit>PCS</Unit></Line> …
        </Transfer></data>
  Answer: DocumentNo (the STR50 number), status (SUCCESS | FAILED), description; then OnePosBatches (lines), OnePosNote.
  FACTS' procedures are not changed by this one; dropping it changes nothing else.
*/
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @DocType NVARCHAR(6) = N'STR50', @FyCode NVARCHAR(6) = N'CFY', @Key NVARCHAR(50) = N'usp_TSF_APPR_StockApproval',
            @DocDate DATETIME        = @BodyXML.value('(/data/Transfer/DocDate)[1]', 'DATETIME'),
            @From NVARCHAR(20)       = @BodyXML.value('(/data/Transfer/FromLocation)[1]', 'NVARCHAR(20)'),
            @To NVARCHAR(20)         = @BodyXML.value('(/data/Transfer/ToLocation)[1]', 'NVARCHAR(20)'),
            @Reference NVARCHAR(200) = @BodyXML.value('(/data/Transfer/Reference)[1]', 'NVARCHAR(200)'),
            @DocNo NVARCHAR(20), @Sman NVARCHAR(20), @Divn NVARCHAR(20), @Dept NVARCHAR(20);

    DECLARE @Lines TABLE (SrNo INT IDENTITY(1, 1), ItemType NVARCHAR(6), ItemCode NVARCHAR(20), ItemName NVARCHAR(300), Qty NUMERIC(18, 3), Unit NVARCHAR(20),
                          BaseUnit NVARCHAR(20), BaseQty NUMERIC(18, 3), Batch NVARCHAR(20));
    INSERT INTO @Lines (ItemType, ItemCode, ItemName, Qty, Unit)
    SELECT l.value('(ItemType)[1]', 'NVARCHAR(6)'), l.value('(ItemCode)[1]', 'NVARCHAR(20)'), l.value('(ItemName)[1]', 'NVARCHAR(300)'),
           l.value('(Qty)[1]', 'NUMERIC(18,3)'), l.value('(Unit)[1]', 'NVARCHAR(20)')
    FROM @BodyXML.nodes('/data/Transfer/Line') AS x(l);

    IF @DocDate IS NULL OR ISNULL(@From, '') = '' OR ISNULL(@To, '') = '' OR ISNULL(@Reference, '') = '' OR ISNULL(@ClientID, '') = '' OR NOT EXISTS (SELECT 1 FROM @Lines)
    BEGIN
        SELECT NULL AS DocumentNo, 'FAILED' AS status, N'Date, locations, reference, the FACTS user and at least one line are needed.' AS description;
        RETURN;
    END
    IF EXISTS (SELECT 1 FROM @Lines WHERE ISNULL(ItemCode, '') = '' OR ISNULL(ItemType, '') = '' OR ISNULL(Qty, 0) <= 0)
    BEGIN
        SELECT NULL AS DocumentNo, 'FAILED' AS status, N'Every line needs an item code, its type and a quantity above zero.' AS description;
        RETURN;
    END
    IF NOT EXISTS (SELECT 1 FROM dbo.USER_MASTER WHERE USER_LOGINID = @ClientID)
    BEGIN
        SELECT NULL AS DocumentNo, 'FAILED' AS status, LEFT(N'"' + @ClientID + N'" is not a FACTS user: set the request approver''s FACTS username on the branch in One POS.', 400) AS description;
        RETURN;
    END
    IF NOT EXISTS (SELECT 1 FROM dbo.LOCATION_MASTER WHERE LOC_DOCNO = @From) OR NOT EXISTS (SELECT 1 FROM dbo.LOCATION_MASTER WHERE LOC_DOCNO = @To)
    BEGIN
        SELECT NULL AS DocumentNo, 'FAILED' AS status, LEFT(N'Not FACTS locations: ' + @From + N' / ' + @To + N'.', 400) AS description;
        RETURN;
    END
    DECLARE @Unknown NVARCHAR(400) = (SELECT STRING_AGG(ItemCode, ', ') FROM @Lines l WHERE NOT EXISTS (SELECT 1 FROM dbo.STOCK_MASTER s WHERE s.STKMST_DOCNO = l.ItemCode));
    IF @Unknown IS NOT NULL
    BEGIN
        SELECT NULL AS DocumentNo, 'FAILED' AS status, LEFT(N'Not FACTS items: ' + @Unknown, 400) AS description;
        RETURN;
    END

    -- Sent before (a retry): posted -> answered as is.
    SELECT TOP 1 @DocNo = TSF_DOCNO FROM dbo.TRANSFER_HEADER
    WHERE TSF_FYCODE = @FyCode AND TSF_DOCTYPE = @DocType AND TSF_LOCATION_FM_DOCNO = @From AND TSF_LOCATION_TO_DOCNO = @To AND TSF_NARRATION = @Reference
      AND EXISTS (SELECT 1 FROM dbo.ACTION_STATUS WHERE ACTION_FYCODE = TSF_FYCODE AND ACTION_DOCTYPE = TSF_DOCTYPE AND ACTION_DOCNO = TSF_DOCNO AND ACTION_KEY = @Key);
    IF @DocNo IS NOT NULL
    BEGIN
        SELECT @DocNo AS DocumentNo, 'SUCCESS' AS status, N'Already posted.' AS description;
        SELECT 0 AS OnePosBatches, CAST(NULL AS NVARCHAR(400)) AS OnePosNote;
        RETURN;
    END

    UPDATE l SET BaseUnit = s.STKMST_UNIT_DOCNO, BaseQty = CAST(l.Qty * ISNULL(u.STKU_FROM_QTY / NULLIF(u.STKU_TO_QTY, 0), 1) AS NUMERIC(18, 3))
    FROM @Lines l
    JOIN dbo.STOCK_MASTER s ON s.STKMST_DOCNO = l.ItemCode
    LEFT JOIN dbo.STOCK_UNIT u ON u.STKU_DOCNO = l.ItemCode AND u.STKU_UNIT_DOCNO = l.Unit;

    -- A batch per line, as FACTS' own STR50 lines carry one: the store's oldest batch with stock, else the item's newest batch.
    UPDATE l SET Batch = COALESCE(
        (SELECT TOP 1 b.BATMST_DOCNO FROM dbo.fn_BatchNoUnique(l.ItemCode, @From) b WHERE b.BATMST_CLSQTY > 0 ORDER BY b.BATMST_SDOCDATE, b.BATMST_EXPIRY_DATE, b.BATMST_DOCNO),
        (SELECT TOP 1 m.BATMST_DOCNO FROM dbo.STOCK_BATCH_MASTER m WHERE m.BATMST_STOCK_DOCNO = l.ItemCode ORDER BY m.BATMST_SDOCDATE DESC, m.BATMST_DOCNO DESC))
    FROM @Lines l;

    BEGIN TRY
        BEGIN TRANSACTION;
        DECLARE @lock INT;
        EXEC @lock = sp_getapplock @Resource = N'ONEPOS_STR50_NUMBER', @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = 15000;
        IF @lock < 0 THROW 50001, 'The STR50 numbering is busy; try again.', 1;

        -- Leftover of an earlier try that FACTS didn't post (not normally there): removed, then saved again.
        SELECT TOP 1 @DocNo = TSF_DOCNO FROM dbo.TRANSFER_HEADER WITH (UPDLOCK)
        WHERE TSF_FYCODE = @FyCode AND TSF_DOCTYPE = @DocType AND TSF_LOCATION_FM_DOCNO = @From AND TSF_LOCATION_TO_DOCNO = @To AND TSF_NARRATION = @Reference;
        IF @DocNo IS NOT NULL
        BEGIN
            DELETE FROM dbo.TRANSFER_DETAILS WHERE TSFDET_FYCODE = @FyCode AND TSFDET_DOCTYPE = @DocType AND TSFDET_DOCNO = @DocNo;
            DELETE FROM dbo.TRANSFER_HEADER WHERE TSF_FYCODE = @FyCode AND TSF_DOCTYPE = @DocType AND TSF_DOCNO = @DocNo;
        END
        ELSE
        BEGIN
            EXEC dbo.usp_UpdateLastNoMaster_From_Transaction_Table @DocType, NULL;
            SET @DocNo = dbo.fn_GetNewDocNo(@DocType, '');
            WHILE EXISTS (SELECT 1 FROM dbo.TRANSFER_HEADER WITH (UPDLOCK, HOLDLOCK) WHERE TSF_FYCODE = @FyCode AND TSF_DOCTYPE = @DocType AND TSF_DOCNO = @DocNo)
                SET @DocNo = dbo.fn_GetNewDocNo(@DocType, @DocNo);
        END

        -- Salesman, division and department of the outlet's own last request, so it looks like theirs.
        SELECT TOP 1 @Sman = TSF_SMAN_DOCNO, @Divn = TSF_DIVN_DOCNO, @Dept = TSF_DEPT_DOCNO FROM dbo.TRANSFER_HEADER
        WHERE TSF_DOCTYPE = @DocType AND TSF_LOCATION_TO_DOCNO = @To ORDER BY TSF_DOCDATE DESC;

        INSERT INTO dbo.TRANSFER_HEADER (TSF_FYCODE, TSF_DOCTYPE, TSF_DOCNO, TSF_DOCDATE, TSF_LOCATION_FM_DOCNO, TSF_LOCATION_TO_DOCNO, TSF_SMAN_DOCNO, TSF_NARRATION,
                                         TSF_NET_AMOUNT, TSF_TOTAL_QTY, TSF_DIVN_DOCNO, TSF_DEPT_DOCNO, TSF_CREATED_BY, TSF_CREATED_TS, TSF_ACTIVE_STATUS)
        SELECT @FyCode, @DocType, @DocNo, @DocDate, @From, @To, @Sman, @Reference, 0, SUM(BaseQty), @Divn, @Dept, @ClientID, GETDATE(), 0 FROM @Lines;

        INSERT INTO dbo.TRANSFER_DETAILS (TSFDET_FYCODE, TSFDET_DOCTYPE, TSFDET_DOCNO, TSFDET_DOCSRNO, TSFDET_STOCK_DOCTYPE, TSFDET_STOCK_DOCNO, TSFDET_STOCK_DESC,
                                          TSFDET_LOCATION_FM_DOCNO, TSFDET_LOCATION_TO_DOCNO, TSFDET_QTY, TSFDET_UNIT_DOCNO, TSFDET_RATE, TSFDET_AMOUNT,
                                          TSFDET_PIECE_COUNT, TSFDET_AFTER_DOC_QTY, TSFDET_BATCH_DOCNO, TSFDET_DOCDATE)
        SELECT @FyCode, @DocType, @DocNo, SrNo, ItemType, ItemCode, ItemName, @From, @To, BaseQty, BaseUnit, 0, 0, 0, 0, Batch, @DocDate
        FROM @Lines;

        INSERT INTO dbo.ADD_EDIT_DELETE_LOG (AED_UNIQUE_ID, AED_TS, AED_MACHINE_ID, AED_USER_CODE, AED_DOCNO, AED_DOCTYPE, AED_FYCODE, AED_STATUS)
        VALUES (NEWID(), GETDATE(), N'One POS', @ClientID, @DocNo, @DocType, @FyCode, 'A');

        EXEC dbo.usp_UpdateLastNoMaster_From_Transaction_Table @DocType, NULL;
        COMMIT TRANSACTION;
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
        SELECT NULL AS DocumentNo, 'FAILED' AS status, LEFT(ERROR_MESSAGE(), 400) AS description;
        RETURN;
    END CATCH

    -- 2. FACTS' own approval (Transaction Posting), as saving on the screen runs it, as the approver's FACTS user.
    DECLARE @Refused NVARCHAR(400) = NULL;
    DECLARE @Docs NVARCHAR(MAX) = N'<FACTS><PARAMETERS><COLUMN1>' + @DocType + N'</COLUMN1><COLUMN2>' + @DocNo + N'</COLUMN2></PARAMETERS></FACTS>';
    SET XACT_ABORT OFF;
    BEGIN TRY
        EXEC dbo.usp_DocumentAutoApprove @strFycode = @FyCode, @strDocType = @DocType, @strXmlDocDetails = @Docs, @strLoginID = @ClientID, @strMachineId = N'One POS';
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
        SET @Refused = LEFT(ERROR_MESSAGE(), 300);
    END CATCH
    SET XACT_ABORT ON;

    IF NOT EXISTS (SELECT 1 FROM dbo.ACTION_STATUS WHERE ACTION_FYCODE = @FyCode AND ACTION_DOCTYPE = @DocType AND ACTION_DOCNO = @DocNo AND ACTION_KEY = @Key)
    BEGIN
        -- Not posted: nothing stays in FACTS (a request moves no stock; it is removed with its save log and allocation).
        DELETE FROM dbo.DOCUMENT_ALLOCATION WHERE DA_FYCODE = @FyCode AND DA_DOCTYPE = @DocType AND DA_DOCNO = @DocNo;
        DELETE FROM dbo.TRANSFER_DETAILS WHERE TSFDET_FYCODE = @FyCode AND TSFDET_DOCTYPE = @DocType AND TSFDET_DOCNO = @DocNo;
        DELETE FROM dbo.TRANSFER_HEADER WHERE TSF_FYCODE = @FyCode AND TSF_DOCTYPE = @DocType AND TSF_DOCNO = @DocNo;
        DELETE FROM dbo.ADD_EDIT_DELETE_LOG WHERE AED_FYCODE = @FyCode AND AED_DOCTYPE = @DocType AND AED_DOCNO = @DocNo AND AED_MACHINE_ID = N'One POS' AND AED_STATUS = 'A';
        SELECT NULL AS DocumentNo, 'FAILED' AS status,
               LEFT(N'FACTS did not post it as ' + @ClientID + N': ' + ISNULL(@Refused, N'FACTS'' quantity/allocation check refused it') + N'. Nothing was saved in FACTS.', 400) AS description;
        RETURN;
    END

    SELECT @DocNo AS DocumentNo, 'SUCCESS' AS status, N'STR50 posted.' AS description;
    SELECT (SELECT COUNT(*) FROM @Lines) AS OnePosBatches, CAST(NULL AS NVARCHAR(400)) AS OnePosNote;
END
