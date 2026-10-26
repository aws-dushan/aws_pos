CREATE PROCEDURE dbo.usp_ONEPOS_PostConsumption
    @ClientID NVARCHAR(20),
    @BodyXML  XML
AS
/*
  One POS by AWS Distribution - approved marketing give-aways into FACTS as a POSTED material consumption.   Created 26-10-2026 for One POS.

  Finished goods the branch gave away for marketing (tasting, promotion, influencers, gifts), approved in One POS; this books them
  in FACTS, posted, never a draft:
  1. Saves one MCV50 (Material Consumption Voucher-Bakery) at the outlet's location, like finance's own MCV50s: each line at its
     batch's landed cost (STOCK_BATCH_MASTER.BATMST_LANDED_COST_RATE), debiting the expense account sent (e.g. 8003 Sales Promotion);
     FACTS credits stock (MCV50's own setup). Division and department of the location's last MCV50 (else 50 / 101). Number = FACTS'
     next MCV50 number, under a lock. The save is logged as FACTS' screen logs it (ADD_EDIT_DELETE_LOG "A").
  2. Every line gets its batches, FIFO: the earliest received batch (BATMST_SDOCDATE, then expiry) with stock at the outlet
     (dbo.fn_BatchNoUnique) received by the voucher's day; a line more than one batch holds is split over several lines, in the
     item's base unit (STOCK_UNIT).
  3. Posts it the way FACTS' Approve does: FACTS' own usp_DocumentAutoApprove, as @ClientID (a FACTS user allowed MCV50 "Transaction
     Posting"), runs MCV50's steps (usp_MTV_APPR_Posting: stock out of the outlet, expense Dr / stock Cr; then FACTS' Negative Stock
     and Document Allocation checks), records the approval (ACTION_STATUS) and logs it ("R").
  Not enough stock in the batches, or FACTS' approval refuses it: nothing stays in FACTS (the unposted voucher is removed again)
  and the answer is FAILED with the reason; One POS retries it.
  The same Reference again (a retry) finds the voucher already posted and answers it.

  XML:  <data><Consumption>
          <DocDate>2026-10-26</DocDate> <Location>ERBQS</Location> <Account>8003</Account>
          <Reference>One POS marketing EBL-01 2026-10-26 M-1A2B3C4D</Reference>      (also the narration finance sees)
          <Line><ItemType>SMBK</ItemType><ItemCode>505486</ItemCode><ItemName>…</ItemName><Qty>1</Qty><Unit>PCS</Unit></Line> …
        </Consumption></data>
  Answer: DocumentNo (the MCV50 number), status (SUCCESS | FAILED), description; then OnePosBatches (lines given a batch), OnePosNote.
  FACTS' procedures are not changed by this one; dropping it changes nothing else.
*/
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @DocType NVARCHAR(6) = N'MCV50', @FyCode NVARCHAR(6) = N'CFY', @Key NVARCHAR(50) = N'usp_MTV_APPR_Posting',
            @DocDate DATETIME        = @BodyXML.value('(/data/Consumption/DocDate)[1]', 'DATETIME'),
            @Loc NVARCHAR(20)        = @BodyXML.value('(/data/Consumption/Location)[1]', 'NVARCHAR(20)'),
            @Account NVARCHAR(20)    = @BodyXML.value('(/data/Consumption/Account)[1]', 'NVARCHAR(20)'),
            @Reference NVARCHAR(200) = @BodyXML.value('(/data/Consumption/Reference)[1]', 'NVARCHAR(200)'),
            @DocNo NVARCHAR(20), @Divn NVARCHAR(20), @Dept NVARCHAR(20);

    DECLARE @Lines TABLE (SrNo INT IDENTITY(1, 1), ItemType NVARCHAR(6), ItemCode NVARCHAR(20), ItemName NVARCHAR(300), Qty NUMERIC(18, 3), Unit NVARCHAR(20),
                          BaseUnit NVARCHAR(20), BaseQty NUMERIC(18, 3));
    INSERT INTO @Lines (ItemType, ItemCode, ItemName, Qty, Unit)
    SELECT l.value('(ItemType)[1]', 'NVARCHAR(6)'), l.value('(ItemCode)[1]', 'NVARCHAR(20)'), l.value('(ItemName)[1]', 'NVARCHAR(300)'),
           l.value('(Qty)[1]', 'NUMERIC(18,3)'), l.value('(Unit)[1]', 'NVARCHAR(20)')
    FROM @BodyXML.nodes('/data/Consumption/Line') AS x(l);

    IF @DocDate IS NULL OR ISNULL(@Loc, '') = '' OR ISNULL(@Account, '') = '' OR ISNULL(@Reference, '') = '' OR ISNULL(@ClientID, '') = '' OR NOT EXISTS (SELECT 1 FROM @Lines)
    BEGIN
        SELECT NULL AS DocumentNo, 'FAILED' AS status, N'Date, location, expense account, reference, the FACTS user and at least one line are needed.' AS description;
        RETURN;
    END
    IF EXISTS (SELECT 1 FROM @Lines WHERE ISNULL(ItemCode, '') = '' OR ISNULL(ItemType, '') = '' OR ISNULL(Qty, 0) <= 0)
    BEGIN
        SELECT NULL AS DocumentNo, 'FAILED' AS status, N'Every line needs an item code, its type and a quantity above zero.' AS description;
        RETURN;
    END
    IF NOT EXISTS (SELECT 1 FROM dbo.USER_MASTER WHERE USER_LOGINID = @ClientID)
    BEGIN
        SELECT NULL AS DocumentNo, 'FAILED' AS status, LEFT(N'"' + @ClientID + N'" is not a FACTS user: set who posts marketing in FACTS (FACTS posting in One POS).', 400) AS description;
        RETURN;
    END
    IF NOT EXISTS (SELECT 1 FROM dbo.ACCOUNT_MASTER WHERE ACMST_DOCNO = @Account)
    BEGIN
        SELECT NULL AS DocumentNo, 'FAILED' AS status, LEFT(N'"' + @Account + N'" is not a FACTS account: set the marketing expense account (FACTS posting in One POS).', 400) AS description;
        RETURN;
    END
    DECLARE @Unknown NVARCHAR(400) = (SELECT STRING_AGG(ItemCode, ', ') FROM @Lines l WHERE NOT EXISTS (SELECT 1 FROM dbo.STOCK_MASTER s WHERE s.STKMST_DOCNO = l.ItemCode));
    IF @Unknown IS NOT NULL
    BEGIN
        SELECT NULL AS DocumentNo, 'FAILED' AS status, LEFT(N'Not FACTS items: ' + @Unknown, 400) AS description;
        RETURN;
    END

    -- Sent before (a retry): posted -> answered as is.
    SELECT TOP 1 @DocNo = JMAT_DOCNO FROM dbo.JOB_MATERIAL_HEADER
    WHERE JMAT_FYCODE = @FyCode AND JMAT_DOCTYPE = @DocType AND JMAT_LOCATION_DOCNO = @Loc AND JMAT_NARRATION = @Reference
      AND EXISTS (SELECT 1 FROM dbo.ACTION_STATUS WHERE ACTION_FYCODE = JMAT_FYCODE AND ACTION_DOCTYPE = JMAT_DOCTYPE AND ACTION_DOCNO = JMAT_DOCNO AND ACTION_KEY = @Key);
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

    DECLARE @Alloc TABLE (Id INT IDENTITY(1, 1), SrNo INT, Batch NVARCHAR(20), Qty NUMERIC(18, 3), Rate NUMERIC(18, 3));
    DECLARE @Short NVARCHAR(400) = N'';

    BEGIN TRY
        BEGIN TRANSACTION;
        DECLARE @lock INT;
        EXEC @lock = sp_getapplock @Resource = N'ONEPOS_MCV50_NUMBER', @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = 15000;
        IF @lock < 0 THROW 50001, 'The MCV50 numbering is busy; try again.', 1;

        -- Leftover of an earlier try that FACTS didn't post (not normally there): removed, then saved again.
        SELECT TOP 1 @DocNo = JMAT_DOCNO FROM dbo.JOB_MATERIAL_HEADER WITH (UPDLOCK)
        WHERE JMAT_FYCODE = @FyCode AND JMAT_DOCTYPE = @DocType AND JMAT_LOCATION_DOCNO = @Loc AND JMAT_NARRATION = @Reference;

        -- Batches, FIFO, line by line; part of a batch given to a line above already counts against it. Each at its landed cost.
        DECLARE @SrNo INT, @Stock NVARCHAR(20), @Need NUMERIC(18, 3), @Batch NVARCHAR(20), @Have NUMERIC(18, 3), @Take NUMERIC(18, 3);
        DECLARE lines CURSOR LOCAL FAST_FORWARD FOR SELECT SrNo, ItemCode, BaseQty FROM @Lines ORDER BY SrNo;
        OPEN lines;
        FETCH NEXT FROM lines INTO @SrNo, @Stock, @Need;
        WHILE @@FETCH_STATUS = 0
        BEGIN
            WHILE @Need > 0
            BEGIN
                SET @Batch = NULL;
                SELECT TOP 1 @Batch = b.BATMST_DOCNO, @Have = b.BATMST_CLSQTY - ISNULL(a.Used, 0)
                FROM dbo.fn_BatchNoUnique(@Stock, @Loc) b
                OUTER APPLY (SELECT SUM(x.Qty) AS Used FROM @Alloc x JOIN @Lines y ON y.SrNo = x.SrNo WHERE y.ItemCode = @Stock AND x.Batch = b.BATMST_DOCNO) a
                WHERE b.BATMST_CLSQTY - ISNULL(a.Used, 0) > 0
                  AND (b.BATMST_SDOCDATE IS NULL OR b.BATMST_SDOCDATE < DATEADD(DAY, 1, CAST(@DocDate AS DATE)))
                ORDER BY b.BATMST_SDOCDATE, b.BATMST_EXPIRY_DATE, b.BATMST_DOCNO;
                IF @Batch IS NULL BREAK;
                SET @Take = CASE WHEN @Have < @Need THEN @Have ELSE @Need END;
                INSERT INTO @Alloc (SrNo, Batch, Qty, Rate)
                SELECT @SrNo, @Batch, @Take, ISNULL((SELECT TOP 1 m.BATMST_LANDED_COST_RATE FROM dbo.STOCK_BATCH_MASTER m WHERE m.BATMST_DOCNO = @Batch AND m.BATMST_STOCK_DOCNO = @Stock), 0);
                SET @Need -= @Take;
            END
            IF @Need > 0
                SET @Short = LEFT(@Short + CASE WHEN @Short = N'' THEN N'' ELSE N', ' END + @Stock + N' (' + LTRIM(@Need) + N' short)', 400);
            FETCH NEXT FROM lines INTO @SrNo, @Stock, @Need;
        END
        CLOSE lines; DEALLOCATE lines;

        IF @Short <> N''
        BEGIN
            ROLLBACK TRANSACTION;
            SELECT NULL AS DocumentNo, 'FAILED' AS status, LEFT(N'Not enough stock at ' + @Loc + N' for ' + @Short + N'. Nothing was saved in FACTS.', 400) AS description;
            RETURN;
        END

        IF @DocNo IS NOT NULL
        BEGIN
            DELETE FROM dbo.JOB_MATERIAL_DETAILS WHERE JMATDET_FYCODE = @FyCode AND JMATDET_DOCTYPE = @DocType AND JMATDET_DOCNO = @DocNo;
            DELETE FROM dbo.JOB_MATERIAL_HEADER WHERE JMAT_FYCODE = @FyCode AND JMAT_DOCTYPE = @DocType AND JMAT_DOCNO = @DocNo;
        END
        ELSE
        BEGIN
            EXEC dbo.usp_UpdateLastNoMaster_From_Transaction_Table @DocType, NULL;
            SET @DocNo = dbo.fn_GetNewDocNo(@DocType, '');
            WHILE EXISTS (SELECT 1 FROM dbo.JOB_MATERIAL_HEADER WITH (UPDLOCK, HOLDLOCK) WHERE JMAT_FYCODE = @FyCode AND JMAT_DOCTYPE = @DocType AND JMAT_DOCNO = @DocNo)
                SET @DocNo = dbo.fn_GetNewDocNo(@DocType, @DocNo);
        END

        SELECT TOP 1 @Divn = JMAT_DIVN_DOCNO, @Dept = JMAT_DEPT_DOCNO FROM dbo.JOB_MATERIAL_HEADER
        WHERE JMAT_DOCTYPE = @DocType AND JMAT_LOCATION_DOCNO = @Loc ORDER BY JMAT_DOCDATE DESC;

        INSERT INTO dbo.JOB_MATERIAL_HEADER (JMAT_FYCODE, JMAT_DOCTYPE, JMAT_DOCNO, JMAT_DOCDATE, JMAT_LOCATION_DOCNO, JMAT_NARRATION, JMAT_NET_AMOUNT, JMAT_TOTAL_QTY,
                                             JMAT_DIVN_DOCNO, JMAT_DEPT_DOCNO, JMAT_CREATED_BY, JMAT_CREATED_TS, JMAT_ACTIVE_STATUS)
        SELECT @FyCode, @DocType, @DocNo, @DocDate, @Loc, @Reference, SUM(ROUND(Qty * Rate, 3)), SUM(Qty), ISNULL(@Divn, N'50'), ISNULL(@Dept, N'101'), @ClientID, GETDATE(), 0
        FROM @Alloc;

        -- One line per batch, in base units, at the batch's landed cost, to the expense account.
        INSERT INTO dbo.JOB_MATERIAL_DETAILS (JMATDET_FYCODE, JMATDET_DOCTYPE, JMATDET_DOCNO, JMATDET_DOCSRNO, JMATDET_STOCK_DOCTYPE, JMATDET_STOCK_DOCNO, JMATDET_STOCK_DESC,
                                              JMATDET_LOCATION_DOCNO, JMATDET_QTY, JMATDET_UNIT_DOCNO, JMATDET_RATE, JMATDET_GROSS_AMOUNT, JMATDET_AMOUNT,
                                              JMATDET_BATCH_DOCNO, JMATDET_DOCDATE, JMATDET_AC_DOCNO)
        SELECT @FyCode, @DocType, @DocNo, ROW_NUMBER() OVER (ORDER BY a.SrNo, a.Id), l.ItemType, l.ItemCode, l.ItemName, @Loc, a.Qty, l.BaseUnit, a.Rate,
               ROUND(a.Qty * a.Rate, 3), ROUND(a.Qty * a.Rate, 3), a.Batch, @DocDate, @Account
        FROM @Alloc a JOIN @Lines l ON l.SrNo = a.SrNo;

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

    -- 3. FACTS' own approval (Transaction Posting), as the Approve button runs it, as that FACTS user.
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
        -- Not posted: nothing stays in FACTS (the unposted voucher moved no stock; it is removed with its save log).
        DELETE FROM dbo.JOB_MATERIAL_DETAILS WHERE JMATDET_FYCODE = @FyCode AND JMATDET_DOCTYPE = @DocType AND JMATDET_DOCNO = @DocNo;
        DELETE FROM dbo.JOB_MATERIAL_HEADER WHERE JMAT_FYCODE = @FyCode AND JMAT_DOCTYPE = @DocType AND JMAT_DOCNO = @DocNo;
        DELETE FROM dbo.ADD_EDIT_DELETE_LOG WHERE AED_FYCODE = @FyCode AND AED_DOCTYPE = @DocType AND AED_DOCNO = @DocNo AND AED_MACHINE_ID = N'One POS' AND AED_STATUS = 'A';
        SELECT NULL AS DocumentNo, 'FAILED' AS status,
               LEFT(N'FACTS did not post it as ' + @ClientID + N': ' + ISNULL(@Refused, N'that user may not post MCV50 "Transaction Posting", or FACTS'' negative stock/allocation check refused it') + N'. Nothing was saved in FACTS.', 400) AS description;
        RETURN;
    END

    SELECT @DocNo AS DocumentNo, 'SUCCESS' AS status, N'MCV50 posted.' AS description;
    SELECT (SELECT COUNT(*) FROM @Alloc) AS OnePosBatches, CAST(NULL AS NVARCHAR(400)) AS OnePosNote;
END
