CREATE PROCEDURE dbo.usp_ONEPOS_SaveRepacking
    @ClientID NVARCHAR(20),
    @BodyXML  XML
AS
/*
  One POS by AWS Distribution - a branch's made-to-order items of one day into FACTS as a DRAFT repacking voucher.
                                                                                                   Created 19-10-2026 for One POS.

  Saves one RPO50 (repacking) at the outlet's location, like the ones finance enters today: each finished item sold that day (e.g.
  CAPPUCCINO 45 PCS) comes IN, and the raw materials its BOM in One POS says it used go OUT (COFFEE BEAN 0.81 KG, MILK 5.4 LTR …),
  each OUT line pointing at the finished item it was used for (REPODET_FG_*). It is left UNPOSTED: no approval runs, so no stock moves
  and nothing is booked. Finance opens it in FACTS, gives the raw materials their batches and posts it as now (FACTS' own approval
  then moves the stock and costs the finished items).

  The number is FACTS' next RPO50 number (lastno_master via usp_UpdateLastNoMaster_From_Transaction_Table and fn_GetNewDocNo, as
  FACTS' own saving does), taken under a lock so finance saving an RPO50 at the same moment can't get the same number.
  Division and department are those of the last RPO50 at the same location (finance's own; 50 / 101 at ERBQS).
  Each finished item's IN line gets the batch FACTS gives repacked items (RPO50-<number>-<line>).
  The same Reference again returns the draft already saved for it (a retry never makes a second one).

  XML:  <data><Repacking>
          <DocDate>2026-10-19</DocDate> <Location>ERBQS</Location>
          <Reference>One POS repacking EB-QS 2026-10-19 #1</Reference>      (also the narration finance sees)
          <Item><ItemType>SMBK</ItemType><ItemCode>502113</ItemCode><ItemName>CAPPUCCINO</ItemName><Qty>45</Qty><Unit>PCS</Unit>
            <Material><ItemType>SMBK</ItemType><ItemCode>501910</ItemCode><ItemName>COFFEE BEAN GRAN ROAST</ItemName><Qty>0.81</Qty><Unit>KG</Unit></Material> …
          </Item> …
        </Repacking></data>
  Answer: DocumentNo (the RPO50 number), status (SUCCESS | FAILED), description.
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

    -- Finished items (IN) and their raw materials (OUT), numbered in XML order.
    DECLARE @Items TABLE (SrNo INT, ItemType NVARCHAR(6), ItemCode NVARCHAR(20), ItemName NVARCHAR(300), Qty NUMERIC(18, 3), Unit NVARCHAR(20), Node XML);
    INSERT INTO @Items (SrNo, ItemType, ItemCode, ItemName, Qty, Unit, Node)
    SELECT ROW_NUMBER() OVER (ORDER BY (SELECT NULL)),
           i.value('(ItemType)[1]', 'NVARCHAR(6)'), i.value('(ItemCode)[1]', 'NVARCHAR(20)'), i.value('(ItemName)[1]', 'NVARCHAR(300)'),
           i.value('(Qty)[1]', 'NUMERIC(18,3)'), i.value('(Unit)[1]', 'NVARCHAR(20)'), i.query('Material')
    FROM @BodyXML.nodes('/data/Repacking/Item') AS x(i);

    DECLARE @Materials TABLE (SrNo INT IDENTITY(1, 1), FgSrNo INT, ItemType NVARCHAR(6), ItemCode NVARCHAR(20), ItemName NVARCHAR(300), Qty NUMERIC(18, 3), Unit NVARCHAR(20));
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
    -- Every code must be a FACTS item (a clear answer instead of a foreign-key error).
    DECLARE @Unknown NVARCHAR(400) = (
        SELECT STRING_AGG(c, ', ') FROM (SELECT ItemCode c FROM @Items UNION SELECT ItemCode FROM @Materials) x
        WHERE NOT EXISTS (SELECT 1 FROM dbo.STOCK_MASTER s WHERE s.STKMST_DOCNO = x.c));
    IF @Unknown IS NOT NULL
    BEGIN
        SELECT NULL AS DocumentNo, 'FAILED' AS status, LEFT(N'Not FACTS items: ' + @Unknown, 400) AS description;
        RETURN;
    END

    -- Sent before (a retry): the draft already saved for this reference.
    SELECT TOP 1 @DocNo = REP_DOCNO FROM dbo.REPACKING_HEADER
    WHERE REP_DOCTYPE = @DocType AND REP_LOCATION_DOCNO = @Loc AND REP_NARRATION = @Reference;
    IF @DocNo IS NOT NULL
    BEGIN
        SELECT @DocNo AS DocumentNo, 'SUCCESS' AS status, N'Already saved for this reference.' AS description;
        RETURN;
    END

    SELECT TOP 1 @Divn = REP_DIVN_DOCNO, @Dept = REP_DEPT_DOCNO FROM dbo.REPACKING_HEADER
    WHERE REP_DOCTYPE = @DocType AND REP_LOCATION_DOCNO = @Loc ORDER BY REP_CREATED_TS DESC;

    BEGIN TRY
        BEGIN TRANSACTION;
        -- One saver at a time for RPO50 numbers (finance's screen updates the same last-number row).
        DECLARE @lock INT;
        EXEC @lock = sp_getapplock @Resource = N'ONEPOS_RPO50_NUMBER', @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = 15000;
        IF @lock < 0 THROW 50001, 'The RPO50 numbering is busy; try again.', 1;

        EXEC dbo.usp_UpdateLastNoMaster_From_Transaction_Table @DocType, NULL;
        SET @DocNo = dbo.fn_GetNewDocNo(@DocType, '');
        WHILE EXISTS (SELECT 1 FROM dbo.REPACKING_HEADER WITH (UPDLOCK, HOLDLOCK) WHERE REP_FYCODE = @FyCode AND REP_DOCTYPE = @DocType AND REP_DOCNO = @DocNo)
            SET @DocNo = dbo.fn_GetNewDocNo(@DocType, @DocNo);

        INSERT INTO dbo.REPACKING_HEADER (REP_FYCODE, REP_DOCTYPE, REP_DOCNO, REP_DOCDATE, REP_LOCATION_DOCNO, REP_NARRATION, REP_TOTAL_QTY,
                                          REP_GROSS_AMOUNT, REP_NET_AMOUNT, REP_DIVN_DOCNO, REP_DEPT_DOCNO, REP_CREATED_BY, REP_CREATED_TS, REP_ACTIVE_STATUS,
                                          REP_REF1DATE, REP_REF2DATE)
        SELECT @FyCode, @DocType, @DocNo, @DocDate, @Loc, @Reference, SUM(Qty), 0, 0, @Divn, @Dept, @ClientID, GETDATE(), 0, @DocDate, @DocDate FROM @Items;

        -- IN: the finished items, each with the batch FACTS gives repacked items.
        INSERT INTO dbo.REPACKING_DETAILS_IN (REPIDET_FYCODE, REPIDET_DOCTYPE, REPIDET_DOCNO, REPIDET_DOCSRNO, REPIDET_STOCK_DOCTYPE, REPIDET_STOCK_DOCNO,
                                              REPIDET_STOCK_DESC, REPIDET_LOCATION_DOCNO, REPIDET_QTY, REPIDET_UNIT_DOCNO, REPIDET_DOCDATE,
                                              REPIDET_YIELD_PERC, REPIDET_BATCH_DOCNO)
        SELECT @FyCode, @DocType, @DocNo, SrNo, ItemType, ItemCode, ItemName, @Loc, Qty, Unit, @DocDate,
               100, @DocType + N'-' + @DocNo + N'-' + CAST(SrNo AS NVARCHAR(10))
        FROM @Items;

        -- OUT: the raw materials, each pointing at the finished item it was used for (batches: finance, when posting).
        INSERT INTO dbo.REPACKING_DETAILS_OUT (REPODET_FYCODE, REPODET_DOCTYPE, REPODET_DOCNO, REPODET_DOCSRNO, REPODET_STOCK_DOCTYPE, REPODET_STOCK_DOCNO,
                                               REPODET_STOCK_DESC, REPODET_LOCATION_DOCNO, REPODET_QTY, REPODET_UNIT_DOCNO, REPODET_DOCDATE, REPODET_ORDERING_NO,
                                               REPODET_FG_DOCTYPE, REPODET_FG_DOCNO, REPODET_FG_DOCSRNO)
        SELECT @FyCode, @DocType, @DocNo, m.SrNo, m.ItemType, m.ItemCode, m.ItemName, @Loc, m.Qty, m.Unit, @DocDate, m.SrNo,
               it.ItemType, it.ItemCode, it.SrNo
        FROM @Materials m JOIN @Items it ON it.SrNo = m.FgSrNo;

        EXEC dbo.usp_UpdateLastNoMaster_From_Transaction_Table @DocType, NULL;
        COMMIT TRANSACTION;
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
        SELECT NULL AS DocumentNo, 'FAILED' AS status, LEFT(ERROR_MESSAGE(), 400) AS description;
        RETURN;
    END CATCH

    SELECT @DocNo AS DocumentNo, 'SUCCESS' AS status, N'Draft RPO50 saved (not posted).' AS description;
END
