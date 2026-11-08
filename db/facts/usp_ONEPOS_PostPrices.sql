CREATE OR ALTER PROCEDURE dbo.usp_ONEPOS_PostPrices
    @ClientID NVARCHAR(20),
    @BodyXML  XML
AS
/*
  One POS by AWS Distribution - selling prices set in One POS into FACTS, saved and POSTED.              Created 08-11-2026 for One POS.

  Prices are the selling prices exactly as entered (VAT included). Two kinds, as finance enters them by hand:
  - OUTLET: one OSMPI (Outlet Stock Master Price Insertion, the price import finance uses for the outlet price types OP1, OP2 …):
    header DATA_FROM_EXTERNAL_SOURCE_HEADER, lines DATA_FROM_EXTERNAL_SOURCE_DETAILS (item, rate, price type). Its posting step,
    FACTS' usp_SIT_XLSTOCKPRICE_INSERT, writes the prices into STOCK_PRICE (new item: added; known item: price replaced).
  - PLATFORM: one CPL50 (customer price list) for a delivery platform's customer at one location, holding the changed items only,
    valid from DocDate to ValidTo, laid out like finance's own platform lists (qty 1, the item's base unit, VAT SR 5 % on the line as
    the screen shows it, salesman and division of the customer's last list). Its posting step is FACTS' usp_SAL_APPR_Posting. The
    newest valid list wins where lists overlap, so older lists stay as history.
  Both: number = FACTS' next number of the type, under a lock; the save is logged as FACTS' screen logs it (ADD_EDIT_DELETE_LOG
  "A"); then FACTS' own usp_DocumentAutoApprove posts it as @ClientID (the branch's price posting user, who must be allowed that
  posting step in FACTS), recording ACTION_STATUS. FACTS refusing it: nothing stays in FACTS, the answer is FAILED with the reason.
  The same Reference again (a retry) finds the document already posted and answers it.

  XML:  <data><Prices>
          <Kind>OUTLET | PLATFORM</Kind> <DocDate>2026-11-09</DocDate> <Reference>One POS prices EBL-02 P-1A2B3C4D · Donut prices</Reference>
          OUTLET:   <PriceType>OP3</PriceType>
          PLATFORM: <Customer>AR-D0007</Customer> <Location>ERBJM</Location> <ValidTo>2030-12-31</ValidTo>
          <Line><ItemType>SMBK</ItemType><ItemCode>502117</ItemCode><Price>7.50</Price></Line> …
        </Prices></data>
  Answer: DocumentNo, DocumentType (OSMPI | CPL50), status (SUCCESS | FAILED), description.
  FACTS' procedures are not changed by this one; dropping it changes nothing else.
*/
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @FyCode NVARCHAR(6) = N'CFY',
            @Kind NVARCHAR(10)       = UPPER(@BodyXML.value('(/data/Prices/Kind)[1]', 'NVARCHAR(10)')),
            @DocDate DATETIME        = @BodyXML.value('(/data/Prices/DocDate)[1]', 'DATETIME'),
            @Reference NVARCHAR(200) = @BodyXML.value('(/data/Prices/Reference)[1]', 'NVARCHAR(200)'),
            @PriceType NVARCHAR(20)  = @BodyXML.value('(/data/Prices/PriceType)[1]', 'NVARCHAR(20)'),
            @Customer NVARCHAR(20)   = @BodyXML.value('(/data/Prices/Customer)[1]', 'NVARCHAR(20)'),
            @Location NVARCHAR(20)   = @BodyXML.value('(/data/Prices/Location)[1]', 'NVARCHAR(20)'),
            @ValidTo DATETIME        = @BodyXML.value('(/data/Prices/ValidTo)[1]', 'DATETIME'),
            @DocType NVARCHAR(6), @Key NVARCHAR(50), @DocNo NVARCHAR(20),
            @Ac NVARCHAR(20), @Sub NVARCHAR(20), @Sman NVARCHAR(20), @Divn NVARCHAR(20), @Dept NVARCHAR(20);

    SET @DocType = CASE @Kind WHEN N'OUTLET' THEN N'OSMPI' WHEN N'PLATFORM' THEN N'CPL50' END;
    SET @Key     = CASE @Kind WHEN N'OUTLET' THEN N'usp_SIT_XLSTOCKPRICE_INSERT' WHEN N'PLATFORM' THEN N'usp_SAL_APPR_Posting' END;

    DECLARE @Lines TABLE (SrNo INT IDENTITY(1, 1), ItemType NVARCHAR(6), ItemCode NVARCHAR(40), Price NUMERIC(18, 3), ItemName NVARCHAR(200), Unit NVARCHAR(20));
    INSERT INTO @Lines (ItemType, ItemCode, Price)
    SELECT l.value('(ItemType)[1]', 'NVARCHAR(6)'), l.value('(ItemCode)[1]', 'NVARCHAR(40)'), l.value('(Price)[1]', 'NUMERIC(18,3)')
    FROM @BodyXML.nodes('/data/Prices/Line') AS x(l);

    IF @DocType IS NULL OR @DocDate IS NULL OR ISNULL(@Reference, '') = '' OR ISNULL(@ClientID, '') = '' OR NOT EXISTS (SELECT 1 FROM @Lines)
       OR (@Kind = N'OUTLET' AND ISNULL(@PriceType, '') = '')
       OR (@Kind = N'PLATFORM' AND (ISNULL(@Customer, '') = '' OR ISNULL(@Location, '') = '' OR @ValidTo IS NULL OR @ValidTo < @DocDate))
    BEGIN
        SELECT NULL AS DocumentNo, @DocType AS DocumentType, 'FAILED' AS status,
               N'Kind, date, reference, the FACTS user, at least one line and (outlet) the price type or (platform) customer, location and an end date after the start are needed.' AS description;
        RETURN;
    END
    IF EXISTS (SELECT 1 FROM @Lines WHERE ISNULL(ItemCode, '') = '' OR ISNULL(Price, 0) <= 0)
    BEGIN
        SELECT NULL AS DocumentNo, @DocType AS DocumentType, 'FAILED' AS status, N'Every line needs an item code and a price above zero.' AS description;
        RETURN;
    END
    IF EXISTS (SELECT ItemCode FROM @Lines GROUP BY ItemCode HAVING COUNT(*) > 1)
    BEGIN
        SELECT NULL AS DocumentNo, @DocType AS DocumentType, 'FAILED' AS status, N'An item is listed twice.' AS description;
        RETURN;
    END
    IF NOT EXISTS (SELECT 1 FROM dbo.USER_MASTER WHERE USER_LOGINID = @ClientID)
    BEGIN
        SELECT NULL AS DocumentNo, @DocType AS DocumentType, 'FAILED' AS status,
               LEFT(N'"' + @ClientID + N'" is not a FACTS user: set the branch''s FACTS user for price posting in One POS.', 400) AS description;
        RETURN;
    END
    IF @Kind = N'OUTLET' AND NOT EXISTS (SELECT 1 FROM dbo.PRICE_TYPE_MASTER WHERE PTM_DOCNO = @PriceType)
    BEGIN
        SELECT NULL AS DocumentNo, @DocType AS DocumentType, 'FAILED' AS status, LEFT(N'FACTS has no price type ' + @PriceType + N'.', 400) AS description;
        RETURN;
    END
    IF @Kind = N'PLATFORM'
    BEGIN
        SELECT TOP 1 @Ac = LTRIM(RTRIM(ACMST_DOCNO)), @Sub = LTRIM(RTRIM(ACMST_SUBLEDGER_DOCNO)) FROM dbo.ACMST_POPULATED WHERE ACMST_ACCODE = @Customer;
        IF @Ac IS NULL
        BEGIN
            SELECT NULL AS DocumentNo, @DocType AS DocumentType, 'FAILED' AS status, LEFT(N'FACTS has no customer ' + @Customer + N'.', 400) AS description;
            RETURN;
        END
    END

    UPDATE l SET ItemType = ISNULL(NULLIF(l.ItemType, ''), s.STKMST_DOCTYPE), ItemName = s.STKMST_DESC, Unit = ISNULL(s.STKMST_UNIT_DOCNO, N'PCS')
    FROM @Lines l JOIN dbo.STOCK_MASTER s ON s.STKMST_DOCNO = l.ItemCode AND (ISNULL(l.ItemType, '') = '' OR s.STKMST_DOCTYPE = l.ItemType);
    DECLARE @Unknown NVARCHAR(400) = (SELECT STRING_AGG(ItemCode, ', ') FROM @Lines WHERE ItemName IS NULL);
    IF @Unknown IS NOT NULL
    BEGIN
        SELECT NULL AS DocumentNo, @DocType AS DocumentType, 'FAILED' AS status, LEFT(N'Not FACTS items: ' + @Unknown, 400) AS description;
        RETURN;
    END

    -- Sent before (a retry): posted -> answered as is.
    IF @Kind = N'OUTLET'
        SELECT TOP 1 @DocNo = DFES_DOCNO FROM dbo.DATA_FROM_EXTERNAL_SOURCE_HEADER
        WHERE DFES_FYCODE = @FyCode AND DFES_DOCTYPE = @DocType AND DFES_REMARKS = @Reference
          AND EXISTS (SELECT 1 FROM dbo.ACTION_STATUS WHERE ACTION_FYCODE = DFES_FYCODE AND ACTION_DOCTYPE = DFES_DOCTYPE AND ACTION_DOCNO = DFES_DOCNO AND ACTION_KEY = @Key);
    ELSE
        SELECT TOP 1 @DocNo = SAL_DOCNO FROM dbo.SALES_HEADER
        WHERE SAL_FYCODE = @FyCode AND SAL_DOCTYPE = @DocType AND SAL_NARRATION = @Reference AND SAL_AC_DOCNO = @Ac AND SAL_SUBLEDGER_DOCNO = @Sub
          AND EXISTS (SELECT 1 FROM dbo.ACTION_STATUS WHERE ACTION_FYCODE = SAL_FYCODE AND ACTION_DOCTYPE = SAL_DOCTYPE AND ACTION_DOCNO = SAL_DOCNO AND ACTION_KEY = @Key);
    IF @DocNo IS NOT NULL
    BEGIN
        SELECT @DocNo AS DocumentNo, @DocType AS DocumentType, 'SUCCESS' AS status, N'Already posted.' AS description;
        RETURN;
    END

    BEGIN TRY
        BEGIN TRANSACTION;
        DECLARE @lock INT, @Resource NVARCHAR(100) = N'ONEPOS_' + @DocType + N'_NUMBER';
        EXEC @lock = sp_getapplock @Resource = @Resource, @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = 15000;
        IF @lock < 0 THROW 50001, 'The FACTS numbering is busy; try again.', 1;

        -- Leftover of an earlier try that FACTS didn't post (not normally there): removed, then saved again.
        IF @Kind = N'OUTLET'
        BEGIN
            SELECT TOP 1 @DocNo = DFES_DOCNO FROM dbo.DATA_FROM_EXTERNAL_SOURCE_HEADER WITH (UPDLOCK)
            WHERE DFES_FYCODE = @FyCode AND DFES_DOCTYPE = @DocType AND DFES_REMARKS = @Reference;
            IF @DocNo IS NOT NULL
            BEGIN
                DELETE FROM dbo.DATA_FROM_EXTERNAL_SOURCE_DETAILS WHERE DFESDET_FYCODE = @FyCode AND DFESDET_DOCTYPE = @DocType AND DFESDET_DOCNO = @DocNo;
                DELETE FROM dbo.DATA_FROM_EXTERNAL_SOURCE_HEADER WHERE DFES_FYCODE = @FyCode AND DFES_DOCTYPE = @DocType AND DFES_DOCNO = @DocNo;
            END
        END
        ELSE
        BEGIN
            SELECT TOP 1 @DocNo = SAL_DOCNO FROM dbo.SALES_HEADER WITH (UPDLOCK)
            WHERE SAL_FYCODE = @FyCode AND SAL_DOCTYPE = @DocType AND SAL_NARRATION = @Reference AND SAL_AC_DOCNO = @Ac AND SAL_SUBLEDGER_DOCNO = @Sub;
            IF @DocNo IS NOT NULL
            BEGIN
                DELETE FROM dbo.SALES_DETAILS WHERE SALDET_FYCODE = @FyCode AND SALDET_DOCTYPE = @DocType AND SALDET_DOCNO = @DocNo;
                DELETE FROM dbo.SALES_HEADER WHERE SAL_FYCODE = @FyCode AND SAL_DOCTYPE = @DocType AND SAL_DOCNO = @DocNo;
            END
        END
        IF @DocNo IS NULL
        BEGIN
            EXEC dbo.usp_UpdateLastNoMaster_From_Transaction_Table @DocType, NULL;
            SET @DocNo = dbo.fn_GetNewDocNo(@DocType, '');
            IF @Kind = N'OUTLET'
                WHILE EXISTS (SELECT 1 FROM dbo.DATA_FROM_EXTERNAL_SOURCE_HEADER WITH (UPDLOCK, HOLDLOCK) WHERE DFES_FYCODE = @FyCode AND DFES_DOCTYPE = @DocType AND DFES_DOCNO = @DocNo)
                    SET @DocNo = dbo.fn_GetNewDocNo(@DocType, @DocNo);
            ELSE
                WHILE EXISTS (SELECT 1 FROM dbo.SALES_HEADER WITH (UPDLOCK, HOLDLOCK) WHERE SAL_FYCODE = @FyCode AND SAL_DOCTYPE = @DocType AND SAL_DOCNO = @DocNo)
                    SET @DocNo = dbo.fn_GetNewDocNo(@DocType, @DocNo);
        END

        IF @Kind = N'OUTLET'
        BEGIN
            -- Division and department as on finance's last price import.
            SELECT TOP 1 @Divn = DFES_DIVN_DOCNO, @Dept = DFES_DEPT_DOCNO FROM dbo.DATA_FROM_EXTERNAL_SOURCE_HEADER
            WHERE DFES_DOCTYPE = @DocType AND DFES_DIVN_DOCNO IS NOT NULL ORDER BY DFES_CREATED_TS DESC;
            INSERT INTO dbo.DATA_FROM_EXTERNAL_SOURCE_HEADER (DFES_FYCODE, DFES_DOCNO, DFES_DOCTYPE, DFES_DOCDATE, DFES_REFDATE, DFES_CREATED_BY, DFES_CREATED_TS,
                                                            DFES_REMARKS, DFES_ACTIVE_STATUS, DFES_DIVN_DOCNO, DFES_DEPT_DOCNO, DFES_CURR_RATE)
            VALUES (@FyCode, @DocNo, @DocType, @DocDate, @DocDate, @ClientID, GETDATE(), @Reference, 0, ISNULL(@Divn, N'50'), @Dept, 0);
            INSERT INTO dbo.DATA_FROM_EXTERNAL_SOURCE_DETAILS (DFESDET_FYCODE, DFESDET_DOCTYPE, DFESDET_DOCNO, DFESDET_DOCSRNO, DFESDET_DOCDATE,
                                                             DFESDET_STOCK_DOCTYPE, DFESDET_STOCK_DOCNO, DFESDET_STOCK_NAME, DFESDET_RATE, DFESDET_ALIAS_TYPE)
            SELECT @FyCode, @DocType, @DocNo, SrNo, @DocDate, ItemType, ItemCode, LEFT(ItemName + N' (' + Unit + N')', 200), Price, @PriceType FROM @Lines;
        END
        ELSE
        BEGIN
            -- Salesman and division as on this customer's last price list (finance's own).
            SELECT TOP 1 @Sman = SAL_SMAN_DOCNO, @Divn = SAL_DIVN_DOCNO, @Dept = SAL_DEPT_DOCNO FROM dbo.SALES_HEADER
            WHERE SAL_DOCTYPE = @DocType AND SAL_AC_DOCNO = @Ac AND SAL_SUBLEDGER_DOCNO = @Sub ORDER BY SAL_CREATED_TS DESC;
            DECLARE @Gross NUMERIC(18, 3) = (SELECT SUM(Price) FROM @Lines), @Vat NUMERIC(18, 3) = (SELECT SUM(ROUND(Price * 0.05, 3)) FROM @Lines);
            INSERT INTO dbo.SALES_HEADER (SAL_FYCODE, SAL_DOCNO, SAL_DOCTYPE, SAL_DOCDATE, SAL_REFDATE, SAL_REF2DATE, SAL_AC_DOCNO, SAL_SUBLEDGER_DOCNO, SAL_SMAN_DOCNO,
                                          SAL_CURR_DOCNO, SAL_CURR_RATE, SAL_NARRATION, SAL_GROSS_AMOUNT, SAL_NET_AMOUNT, SAL_LOCATION_DOCNO, SAL_DIVN_DOCNO, SAL_DEPT_DOCNO,
                                          SAL_CREATED_BY, SAL_CREATED_TS)
            VALUES (@FyCode, @DocNo, @DocType, @DocDate, @ValidTo, @DocDate, @Ac, @Sub, @Sman, N'AED', 1, @Reference, @Gross, @Gross + @Vat, @Location, ISNULL(@Divn, N'50'), @Dept,
                    @ClientID, GETDATE());
            INSERT INTO dbo.SALES_DETAILS (SALDET_FYCODE, SALDET_DOCTYPE, SALDET_DOCNO, SALDET_DOCSRNO, SALDET_DOCDATE, SALDET_STOCK_DOCTYPE, SALDET_STOCK_DOCNO, SALDET_STOCK_DESC,
                                           SALDET_LOCATION_DOCNO, SALDET_QTY, SALDET_UNIT_DOCNO, SALDET_RATE, SALDET_AMOUNT, SALDET_GROSS_AMOUNT, SALDET_DISCOUNT_PERCENT,
                                           SALDET_SEQ_RATE, SALDET_VAT_AMOUNT, SALDET_VAT_DOCNO, SALDET_VAT_PERCENTAGE, SALDET_VAT_CATEGORY_DOCNO)
            SELECT @FyCode, @DocType, @DocNo, SrNo, @DocDate, ItemType, ItemCode, ItemName, @Location, 1, Unit, Price, Price, Price, 0,
                   0, ROUND(Price * 0.05, 3), N'SR', 5, N'SR'
            FROM @Lines;
        END

        INSERT INTO dbo.ADD_EDIT_DELETE_LOG (AED_UNIQUE_ID, AED_TS, AED_MACHINE_ID, AED_USER_CODE, AED_DOCNO, AED_DOCTYPE, AED_FYCODE, AED_STATUS)
        VALUES (NEWID(), GETDATE(), N'One POS', @ClientID, @DocNo, @DocType, @FyCode, 'A');

        EXEC dbo.usp_UpdateLastNoMaster_From_Transaction_Table @DocType, NULL;
        COMMIT TRANSACTION;
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
        SELECT NULL AS DocumentNo, @DocType AS DocumentType, 'FAILED' AS status, LEFT(ERROR_MESSAGE(), 400) AS description;
        RETURN;
    END CATCH

    -- FACTS' own posting (Transaction Posting), as the Approve button runs it, as the branch's price posting user.
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
        -- Not posted: nothing stays in FACTS (the unposted document changed no price; it is removed with its save log).
        IF @Kind = N'OUTLET'
        BEGIN
            DELETE FROM dbo.DATA_FROM_EXTERNAL_SOURCE_DETAILS WHERE DFESDET_FYCODE = @FyCode AND DFESDET_DOCTYPE = @DocType AND DFESDET_DOCNO = @DocNo;
            DELETE FROM dbo.DATA_FROM_EXTERNAL_SOURCE_HEADER WHERE DFES_FYCODE = @FyCode AND DFES_DOCTYPE = @DocType AND DFES_DOCNO = @DocNo;
        END
        ELSE
        BEGIN
            DELETE FROM dbo.SALES_DETAILS WHERE SALDET_FYCODE = @FyCode AND SALDET_DOCTYPE = @DocType AND SALDET_DOCNO = @DocNo;
            DELETE FROM dbo.SALES_HEADER WHERE SAL_FYCODE = @FyCode AND SAL_DOCTYPE = @DocType AND SAL_DOCNO = @DocNo;
        END
        DELETE FROM dbo.ADD_EDIT_DELETE_LOG WHERE AED_FYCODE = @FyCode AND AED_DOCTYPE = @DocType AND AED_DOCNO = @DocNo AND AED_MACHINE_ID = N'One POS' AND AED_STATUS = 'A';
        SELECT NULL AS DocumentNo, @DocType AS DocumentType, 'FAILED' AS status,
               LEFT(N'FACTS did not post it as ' + @ClientID + N': ' + ISNULL(@Refused, N'that user may not post ' + @DocType + N' "Transaction Posting"') + N'. Nothing was saved in FACTS.', 400) AS description;
        RETURN;
    END

    SELECT @DocNo AS DocumentNo, @DocType AS DocumentType, 'SUCCESS' AS status, @DocType + N' posted.' AS description;
END
