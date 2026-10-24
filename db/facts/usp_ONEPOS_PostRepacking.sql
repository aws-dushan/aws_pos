CREATE OR ALTER PROCEDURE dbo.usp_ONEPOS_PostRepacking
    @ClientID NVARCHAR(20),
    @BodyXML  XML
AS
/*
  One POS by AWS Distribution - one POS bill's made-to-order items into FACTS as a POSTED repacking voucher.
                                                                       Created 20-10-2026 for One POS; saves by itself since 20-10-2026.

  1. Saves one RPO50 at the outlet's location, as usp_ONEPOS_SaveRepacking does (same XML; Reference = "One POS repacking <invoice
     no>", also the narration): the bill's finished items IN (batch RPO50-<number>-<line>, as FACTS gives repacked items, expiring on the voucher's date), the raw
     materials their BOMs used OUT. Number = FACTS' next RPO50 number, under a lock. The same Reference again finds the voucher
     already saved: posted -> answered as is; still a draft -> filled again under its own number and posted.
  2. Gives every raw material its batches, FIFO: the earliest received batch (STOCK_BATCH_MASTER.BATMST_SDOCDATE, then expiry) with
     stock at the location (dbo.fn_BatchNoUnique, as the invoice batches) received by the voucher's day; a raw material more than one
     batch holds is split over several OUT lines. OUT lines are in the item's base unit (STOCK_UNIT), at the batch's cost
     (BATMST_LANDED_COST_RATE_WITH_VOUCHER_EXPENSES), as finance's own RPO50s are; each finished item comes IN at the cost of its
     raw materials.
  3. Posts it the way FACTS' Approve does: FACTS' own usp_DocumentAutoApprove runs RPO50's approval steps (DOCUMENT_PROCEDURES:
     "Transaction Posting" = usp_RPRV_APPR_Posting, stock in and out and the finished items' batches; then the "Negative Checking"
     validation), records the approval (ACTION_STATUS, so FACTS shows it posted and asks for Cancel Posting before a delete), sets
     REP_POSTED_BY / REP_POSTED_TS and logs it (ADD_EDIT_DELETE_LOG "R"). The save is logged as FACTS' screen logs it ("A").
     FACTS' cost recalculation books the costs as for any RPO50.
  If a raw material hasn't enough stock in its batches (or there are more than 10 finished items, which FACTS' approval can't
  number, or FACTS' approval refuses it), it stays a DRAFT, not posted, and the answer says why; sending it again posts it.
  Answer: DocumentNo, status (SUCCESS | FAILED), description; then OnePosBatches (OUT lines given a batch), OnePosNote.
  FACTS' procedures are not changed by this one; dropping it changes nothing else.
*/
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @DocType NVARCHAR(6) = N'RPO50', @FyCode NVARCHAR(6) = N'CFY',
            @DocDate DATETIME        = @BodyXML.value('(/data/Repacking/DocDate)[1]', 'DATETIME'),
            @Loc NVARCHAR(20)        = @BodyXML.value('(/data/Repacking/Location)[1]', 'NVARCHAR(20)'),
            @Reference NVARCHAR(200) = @BodyXML.value('(/data/Repacking/Reference)[1]', 'NVARCHAR(200)'),
            @DocNo NVARCHAR(20), @Divn NVARCHAR(20), @Dept NVARCHAR(20);

    -- Finished items (IN) and their raw materials (OUT, in base units), numbered in XML order.
    DECLARE @Items TABLE (SrNo INT, ItemType NVARCHAR(6), ItemCode NVARCHAR(20), ItemName NVARCHAR(300), Qty NUMERIC(18, 3), Unit NVARCHAR(20), Node XML);
    INSERT INTO @Items (SrNo, ItemType, ItemCode, ItemName, Qty, Unit, Node)
    SELECT ROW_NUMBER() OVER (ORDER BY (SELECT NULL)),
           i.value('(ItemType)[1]', 'NVARCHAR(6)'), i.value('(ItemCode)[1]', 'NVARCHAR(20)'), i.value('(ItemName)[1]', 'NVARCHAR(300)'),
           i.value('(Qty)[1]', 'NUMERIC(18,3)'), i.value('(Unit)[1]', 'NVARCHAR(20)'), i.query('Material')
    FROM @BodyXML.nodes('/data/Repacking/Item') AS x(i);

    DECLARE @Materials TABLE (SrNo INT IDENTITY(1, 1), FgSrNo INT, ItemType NVARCHAR(6), ItemCode NVARCHAR(20), ItemName NVARCHAR(300), Qty NUMERIC(18, 3), Unit NVARCHAR(20),
                              BaseUnit NVARCHAR(20), BaseQty NUMERIC(18, 3));
    INSERT INTO @Materials (FgSrNo, ItemType, ItemCode, ItemName, Qty, Unit)
    SELECT it.SrNo, m.value('(ItemType)[1]', 'NVARCHAR(6)'), m.value('(ItemCode)[1]', 'NVARCHAR(20)'), m.value('(ItemName)[1]', 'NVARCHAR(300)'),
           m.value('(Qty)[1]', 'NUMERIC(18,3)'), m.value('(Unit)[1]', 'NVARCHAR(20)')
    FROM @Items it CROSS APPLY it.Node.nodes('Material') AS y(m)
    ORDER BY it.SrNo;

    IF @DocDate IS NULL OR ISNULL(@Loc, '') = '' OR ISNULL(@Reference, '') = '' OR NOT EXISTS (SELECT 1 FROM @Items) OR NOT EXISTS (SELECT 1 FROM @Materials)
    BEGIN
        SELECT NULL AS DocumentNo, 'FAILED' AS status, N'Date, location, reference, at least one item and its raw materials are needed.' AS description;
        RETURN;
    END
    IF EXISTS (SELECT 1 FROM @Items WHERE ISNULL(ItemCode, '') = '' OR ISNULL(ItemType, '') = '' OR ISNULL(Qty, 0) <= 0)
       OR EXISTS (SELECT 1 FROM @Materials WHERE ISNULL(ItemCode, '') = '' OR ISNULL(ItemType, '') = '' OR ISNULL(Qty, 0) <= 0)
    BEGIN
        SELECT NULL AS DocumentNo, 'FAILED' AS status, N'Every item and raw material needs a code, its type and a quantity above zero.' AS description;
        RETURN;
    END
    DECLARE @Unknown NVARCHAR(400) = (
        SELECT STRING_AGG(c, ', ') FROM (SELECT ItemCode c FROM @Items UNION SELECT ItemCode FROM @Materials) x
        WHERE NOT EXISTS (SELECT 1 FROM dbo.STOCK_MASTER s WHERE s.STKMST_DOCNO = x.c));
    IF @Unknown IS NOT NULL
    BEGIN
        SELECT NULL AS DocumentNo, 'FAILED' AS status, LEFT(N'Not FACTS items: ' + @Unknown, 400) AS description;
        RETURN;
    END

    UPDATE m SET BaseUnit = s.STKMST_UNIT_DOCNO, BaseQty = CAST(m.Qty * ISNULL(u.STKU_FROM_QTY / NULLIF(u.STKU_TO_QTY, 0), 1) AS NUMERIC(18, 3))
    FROM @Materials m
    JOIN dbo.STOCK_MASTER s ON s.STKMST_DOCNO = m.ItemCode
    LEFT JOIN dbo.STOCK_UNIT u ON u.STKU_DOCNO = m.ItemCode AND u.STKU_UNIT_DOCNO = m.Unit;

    DECLARE @Alloc TABLE (Id INT IDENTITY(1, 1), SrNo INT, Batch NVARCHAR(20), Qty NUMERIC(18, 3), Rate NUMERIC(18, 3));
    DECLARE @Short NVARCHAR(400) = N'', @TooMany BIT = CASE WHEN (SELECT COUNT(*) FROM @Items) > 10 THEN 1 ELSE 0 END, @Post BIT;

    BEGIN TRY
        BEGIN TRANSACTION;
        -- One saver at a time for RPO50 numbers (finance's screen updates the same last-number row); also one poster per voucher.
        DECLARE @lock INT;
        EXEC @lock = sp_getapplock @Resource = N'ONEPOS_RPO50_NUMBER', @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = 15000;
        IF @lock < 0 THROW 50001, 'The RPO50 numbering is busy; try again.', 1;

        -- Sent before (a retry): posted -> as is; a draft -> filled again under its number.
        SELECT TOP 1 @DocNo = REP_DOCNO FROM dbo.REPACKING_HEADER WITH (UPDLOCK)
        WHERE REP_FYCODE = @FyCode AND REP_DOCTYPE = @DocType AND REP_LOCATION_DOCNO = @Loc AND REP_NARRATION = @Reference;
        IF @DocNo IS NOT NULL AND EXISTS (SELECT 1 FROM dbo.ACTION_STATUS WHERE ACTION_FYCODE = @FyCode AND ACTION_DOCTYPE = @DocType
                                          AND ACTION_DOCNO = @DocNo AND ACTION_KEY = N'usp_RPRV_APPR_Posting')
        BEGIN
            COMMIT TRANSACTION;
            SELECT @DocNo AS DocumentNo, 'SUCCESS' AS status, N'Already posted.' AS description;
            SELECT 0 AS OnePosBatches, CAST(NULL AS NVARCHAR(400)) AS OnePosNote;
            RETURN;
        END

        -- Batches, FIFO, line by line; part of a batch given to a line above already counts against it.
        DECLARE @SrNo INT, @Stock NVARCHAR(20), @Need NUMERIC(18, 3), @Batch NVARCHAR(20), @Have NUMERIC(18, 3), @Take NUMERIC(18, 3), @Rate NUMERIC(18, 3);
        DECLARE lines CURSOR LOCAL FAST_FORWARD FOR SELECT SrNo, ItemCode, BaseQty FROM @Materials ORDER BY SrNo;
        OPEN lines;
        FETCH NEXT FROM lines INTO @SrNo, @Stock, @Need;
        WHILE @@FETCH_STATUS = 0
        BEGIN
            WHILE @Need > 0
            BEGIN
                SET @Batch = NULL;
                SELECT TOP 1 @Batch = b.BATMST_DOCNO, @Have = b.BATMST_CLSQTY - ISNULL(a.Used, 0), @Rate = ISNULL(bm.BATMST_LANDED_COST_RATE_WITH_VOUCHER_EXPENSES, 0)
                FROM dbo.fn_BatchNoUnique(@Stock, @Loc) b
                JOIN dbo.STOCK_BATCH_MASTER bm ON bm.BATMST_DOCNO = b.BATMST_DOCNO AND bm.BATMST_STOCK_DOCNO = @Stock
                OUTER APPLY (SELECT SUM(x.Qty) AS Used FROM @Alloc x JOIN @Materials y ON y.SrNo = x.SrNo WHERE y.ItemCode = @Stock AND x.Batch = b.BATMST_DOCNO) a
                WHERE b.BATMST_CLSQTY - ISNULL(a.Used, 0) > 0
                  AND (b.BATMST_SDOCDATE IS NULL OR b.BATMST_SDOCDATE < DATEADD(DAY, 1, CAST(@DocDate AS DATE)))
                ORDER BY b.BATMST_SDOCDATE, b.BATMST_EXPIRY_DATE, b.BATMST_DOCNO;
                IF @Batch IS NULL BREAK;
                SET @Take = CASE WHEN @Have < @Need THEN @Have ELSE @Need END;
                INSERT INTO @Alloc (SrNo, Batch, Qty, Rate) VALUES (@SrNo, @Batch, @Take, @Rate);
                SET @Need -= @Take;
            END
            IF @Need > 0
                SET @Short = LEFT(@Short + CASE WHEN @Short = N'' THEN N'' ELSE N', ' END + @Stock + N' (' + LTRIM(@Need) + N' short)', 400);
            FETCH NEXT FROM lines INTO @SrNo, @Stock, @Need;
        END
        CLOSE lines; DEALLOCATE lines;
        SET @Post = CASE WHEN @Short = N'' AND @TooMany = 0 THEN 1 ELSE 0 END;

        IF @DocNo IS NOT NULL
        BEGIN
            -- The draft saved before: emptied and filled again under the same number.
            DELETE FROM dbo.REPACKING_DETAILS_OUT WHERE REPODET_FYCODE = @FyCode AND REPODET_DOCTYPE = @DocType AND REPODET_DOCNO = @DocNo;
            DELETE FROM dbo.REPACKING_DETAILS_IN WHERE REPIDET_FYCODE = @FyCode AND REPIDET_DOCTYPE = @DocType AND REPIDET_DOCNO = @DocNo;
            DELETE FROM dbo.REPACKING_HEADER WHERE REP_FYCODE = @FyCode AND REP_DOCTYPE = @DocType AND REP_DOCNO = @DocNo;
        END
        ELSE
        BEGIN
            EXEC dbo.usp_UpdateLastNoMaster_From_Transaction_Table @DocType, NULL;
            SET @DocNo = dbo.fn_GetNewDocNo(@DocType, '');
            WHILE EXISTS (SELECT 1 FROM dbo.REPACKING_HEADER WITH (UPDLOCK, HOLDLOCK) WHERE REP_FYCODE = @FyCode AND REP_DOCTYPE = @DocType AND REP_DOCNO = @DocNo)
                SET @DocNo = dbo.fn_GetNewDocNo(@DocType, @DocNo);
        END

        SELECT TOP 1 @Divn = REP_DIVN_DOCNO, @Dept = REP_DEPT_DOCNO FROM dbo.REPACKING_HEADER
        WHERE REP_DOCTYPE = @DocType AND REP_LOCATION_DOCNO = @Loc ORDER BY REP_CREATED_TS DESC;

        INSERT INTO dbo.REPACKING_HEADER (REP_FYCODE, REP_DOCTYPE, REP_DOCNO, REP_DOCDATE, REP_LOCATION_DOCNO, REP_NARRATION, REP_TOTAL_QTY,
                                          REP_GROSS_AMOUNT, REP_NET_AMOUNT, REP_DIVN_DOCNO, REP_DEPT_DOCNO, REP_CREATED_BY, REP_CREATED_TS, REP_ACTIVE_STATUS,
                                          REP_REF1DATE, REP_REF2DATE)
        SELECT @FyCode, @DocType, @DocNo, @DocDate, @Loc, @Reference, SUM(Qty), 0, 0, @Divn, @Dept, @ClientID, GETDATE(), 0, @DocDate, @DocDate FROM @Items;

        INSERT INTO dbo.REPACKING_DETAILS_IN (REPIDET_FYCODE, REPIDET_DOCTYPE, REPIDET_DOCNO, REPIDET_DOCSRNO, REPIDET_STOCK_DOCTYPE, REPIDET_STOCK_DOCNO,
                                              REPIDET_STOCK_DESC, REPIDET_LOCATION_DOCNO, REPIDET_QTY, REPIDET_UNIT_DOCNO, REPIDET_DOCDATE,
                                              REPIDET_YIELD_PERC, REPIDET_BATCH_DOCNO, REPIDET_RATE, REPIDET_GROSS_AMOUNT, REPIDET_AMOUNT, REPIDET_EXPIRY_DATE)
        SELECT @FyCode, @DocType, @DocNo, SrNo, ItemType, ItemCode, ItemName, @Loc, Qty, Unit, @DocDate,
               100, @DocType + N'-' + @DocNo + N'-' + CAST(SrNo AS NVARCHAR(10)), 0, 0, 0, CAST(@DocDate AS DATE)
        FROM @Items;

        IF @Post = 1
            -- OUT: one line per batch, in base units at the batch's cost.
            INSERT INTO dbo.REPACKING_DETAILS_OUT (REPODET_FYCODE, REPODET_DOCTYPE, REPODET_DOCNO, REPODET_DOCSRNO, REPODET_STOCK_DOCTYPE, REPODET_STOCK_DOCNO,
                                                   REPODET_STOCK_DESC, REPODET_LOCATION_DOCNO, REPODET_QTY, REPODET_UNIT_DOCNO, REPODET_RATE, REPODET_GROSS_AMOUNT,
                                                   REPODET_AMOUNT, REPODET_DOCDATE, REPODET_ORDERING_NO, REPODET_BATCH_DOCNO, REPODET_FG_DOCTYPE, REPODET_FG_DOCNO, REPODET_FG_DOCSRNO)
            SELECT @FyCode, @DocType, @DocNo, ROW_NUMBER() OVER (ORDER BY a.SrNo, a.Id), m.ItemType, m.ItemCode, m.ItemName, @Loc, a.Qty, m.BaseUnit, a.Rate,
                   CAST(a.Qty * a.Rate AS NUMERIC(18, 3)), CAST(a.Qty * a.Rate AS NUMERIC(18, 3)), @DocDate, ROW_NUMBER() OVER (ORDER BY a.SrNo, a.Id), a.Batch,
                   it.ItemType, it.ItemCode, it.SrNo
            FROM @Alloc a JOIN @Materials m ON m.SrNo = a.SrNo JOIN @Items it ON it.SrNo = m.FgSrNo;
        ELSE
            -- A draft: the raw materials as sent, without batches (finance gives them).
            INSERT INTO dbo.REPACKING_DETAILS_OUT (REPODET_FYCODE, REPODET_DOCTYPE, REPODET_DOCNO, REPODET_DOCSRNO, REPODET_STOCK_DOCTYPE, REPODET_STOCK_DOCNO,
                                                   REPODET_STOCK_DESC, REPODET_LOCATION_DOCNO, REPODET_QTY, REPODET_UNIT_DOCNO, REPODET_DOCDATE, REPODET_ORDERING_NO,
                                                   REPODET_FG_DOCTYPE, REPODET_FG_DOCNO, REPODET_FG_DOCSRNO)
            SELECT @FyCode, @DocType, @DocNo, m.SrNo, m.ItemType, m.ItemCode, m.ItemName, @Loc, m.Qty, m.Unit, @DocDate, m.SrNo, it.ItemType, it.ItemCode, it.SrNo
            FROM @Materials m JOIN @Items it ON it.SrNo = m.FgSrNo;

        IF @Post = 1
        BEGIN
            -- Each finished item IN at the cost of its raw materials.
            UPDATE i SET REPIDET_AMOUNT = ISNULL(c.Amount, 0), REPIDET_GROSS_AMOUNT = ISNULL(c.Amount, 0),
                         REPIDET_RATE = CAST(ISNULL(c.Amount, 0) / NULLIF(i.REPIDET_QTY, 0) AS NUMERIC(18, 3))
            FROM dbo.REPACKING_DETAILS_IN i
            OUTER APPLY (SELECT SUM(o.REPODET_AMOUNT) AS Amount FROM dbo.REPACKING_DETAILS_OUT o
                         WHERE o.REPODET_FYCODE = i.REPIDET_FYCODE AND o.REPODET_DOCTYPE = i.REPIDET_DOCTYPE AND o.REPODET_DOCNO = i.REPIDET_DOCNO
                           AND o.REPODET_FG_DOCSRNO = i.REPIDET_DOCSRNO) c
            WHERE i.REPIDET_FYCODE = @FyCode AND i.REPIDET_DOCTYPE = @DocType AND i.REPIDET_DOCNO = @DocNo;

        END

        -- Saved, as FACTS' screen logs a save.
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

    -- 3. FACTS' own approval (Transaction Posting), as the Approve button runs it.
    DECLARE @Refused NVARCHAR(400) = NULL;
    IF @Post = 1
    BEGIN
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
        IF NOT EXISTS (SELECT 1 FROM dbo.ACTION_STATUS WHERE ACTION_FYCODE = @FyCode AND ACTION_DOCTYPE = @DocType AND ACTION_DOCNO = @DocNo
                       AND ACTION_KEY = N'usp_RPRV_APPR_Posting')
        BEGIN
            SET @Post = 0;
            SET @Refused = N'FACTS approval refused it: ' + ISNULL(@Refused, N'its checks (e.g. negative stock) failed');
        END
    END

    IF @Post = 1
    BEGIN
        SELECT @DocNo AS DocumentNo, 'SUCCESS' AS status, N'RPO50 posted.' AS description;
        SELECT (SELECT COUNT(*) FROM @Alloc) AS OnePosBatches, CAST(NULL AS NVARCHAR(400)) AS OnePosNote;
    END
    ELSE
    BEGIN
        DECLARE @Why NVARCHAR(400) = CASE WHEN @Refused IS NOT NULL THEN @Refused WHEN @TooMany = 1 THEN N'more than 10 finished items'
                                          ELSE N'no batch at ' + @Loc + N' with enough stock for ' + @Short END;
        SELECT @DocNo AS DocumentNo, 'SUCCESS' AS status, LEFT(N'Saved as a draft, not posted: ' + @Why, 400) AS description;
        SELECT 0 AS OnePosBatches, LEFT(N'Draft RPO50 ' + @DocNo + N', not posted: ' + @Why, 400) AS OnePosNote;
    END
END
