CREATE OR ALTER PROCEDURE dbo.usp_ONEPOS_PostReturn
    @ClientID NVARCHAR(20),
    @BodyXML  XML
AS
/*
  One POS by AWS Distribution - a whole POS bill returned at the till, into FACTS as a POSTED point of sale return (PSR51).
                                                                                                         Created 30-10-2026 for One POS.
                         30-10-2026: payments keep the bill's RD_CREATED_BY (FACTS allows 6 characters there).
                         30-10-2026: the header points at the bill as FACTS' screen does (SAL_PREVIOUS_DOCNO, the POS51 tab).

  XML: /data/CreditNote with CreditNoteNo (One POS' credit note number, e.g. CN-EBL-01-000001: the PSR51's number), CreditNoteDate,
  InvoiceNo (the bill's POS51 number), NetAmount and Reason (the rest of One POS' credit note XML is not needed here).

  1. The PSR51 is a copy of the bill's POS51, as FACTS' return screen makes one from it: the header (customer, location, division,
     VAT, totals), every line with its batch (so the stock goes back on the batch it was sold from) and every payment (refunded the
     way it was paid). The header and each line point back at the POS51 as FACTS' return screen does: SAL_PREVIOUS_DOCNO (the
     screen's POS51 tab) and SAL_UD_LABEL3/4 = POS51 / its number, SAL_REFDATE = the bill's date, SALDET_PREVIOUS_* on each line;
     the bill's own previous-document fields (SAL_PREV_*) are not carried over.
     The narration is "One POS return of <bill>: <reason>". Only a whole bill: NetAmount must be the POS51's net.
  2. Posted the way FACTS' Approve does it: FACTS' own usp_DocumentAutoApprove runs PSR51's approval steps (DOCUMENT_PROCEDURES:
     "Transaction Posting" = usp_SAL_APPR_Posting, stock and accounts; its validations) and records the approval (ACTION_STATUS).
     The save is logged as FACTS' screen logs it ("A").
  3. If FACTS' approval refuses it, the unposted PSR51 is removed again (nothing stays) and the answer says why; sending it again
     tries afresh. Sent again after it was posted: answered as it is ("Already posted").
  Answer: DocumentNo, status (SUCCESS | FAILED), description.
  FACTS' procedures and tables are not changed by this one; dropping it changes nothing else.
*/
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @DocType NVARCHAR(6) = N'PSR51', @FromType NVARCHAR(6) = N'POS51', @FyCode NVARCHAR(6),
            @DocNo NVARCHAR(20)      = @BodyXML.value('(/data/CreditNote/CreditNoteNo)[1]', 'NVARCHAR(20)'),
            @DocDate DATETIME        = @BodyXML.value('(/data/CreditNote/CreditNoteDate)[1]', 'DATETIME'),
            @InvoiceNo NVARCHAR(20)  = @BodyXML.value('(/data/CreditNote/InvoiceNo)[1]', 'NVARCHAR(20)'),
            @Net NUMERIC(18, 3)      = @BodyXML.value('(/data/CreditNote/NetAmount)[1]', 'NUMERIC(18,3)'),
            @Reason NVARCHAR(400)    = @BodyXML.value('(/data/CreditNote/Reason)[1]', 'NVARCHAR(400)'),
            @BillNet NUMERIC(18, 3), @Other NVARCHAR(20);

    IF ISNULL(@DocNo, '') = '' OR @DocDate IS NULL OR ISNULL(@InvoiceNo, '') = '' OR @Net IS NULL
    BEGIN
        SELECT NULL AS DocumentNo, 'FAILED' AS status, N'The credit note number, its date, the bill''s number and the amount are needed.' AS description;
        RETURN;
    END

    SELECT @FyCode = SAL_FYCODE, @BillNet = SAL_NET_AMOUNT FROM dbo.SALES_HEADER WHERE SAL_DOCTYPE = @FromType AND SAL_DOCNO = @InvoiceNo;
    IF @FyCode IS NULL
    BEGIN
        SELECT NULL AS DocumentNo, 'FAILED' AS status, LEFT(N'Bill ' + @InvoiceNo + N' is not in FACTS as a POS51.', 400) AS description;
        RETURN;
    END

    -- Sent before: posted -> as it is; saved but not posted (an earlier try stopped between the steps) -> posted now.
    IF EXISTS (SELECT 1 FROM dbo.SALES_HEADER WHERE SAL_FYCODE = @FyCode AND SAL_DOCTYPE = @DocType AND SAL_DOCNO = @DocNo)
    BEGIN
        IF EXISTS (SELECT 1 FROM dbo.ACTION_STATUS WHERE ACTION_FYCODE = @FyCode AND ACTION_DOCTYPE = @DocType AND ACTION_DOCNO = @DocNo AND ACTION_KEY = N'usp_SAL_APPR_Posting')
        BEGIN
            SELECT @DocNo AS DocumentNo, 'SUCCESS' AS status, N'Already posted.' AS description;
            RETURN;
        END
        GOTO Approve;
    END

    -- One return per bill, and only of the whole bill.
    SELECT TOP 1 @Other = SAL_DOCNO FROM dbo.SALES_HEADER WHERE SAL_DOCTYPE = @DocType AND SAL_UD_LABEL3 = @FromType AND SAL_UD_LABEL4 = @InvoiceNo;
    IF @Other IS NOT NULL
    BEGIN
        SELECT NULL AS DocumentNo, 'FAILED' AS status, LEFT(N'Bill ' + @InvoiceNo + N' was returned already: PSR51 ' + @Other + N'.', 400) AS description;
        RETURN;
    END
    IF ABS(ISNULL(@BillNet, 0) - @Net) > 0.011
    BEGIN
        SELECT NULL AS DocumentNo, 'FAILED' AS status, LEFT(N'Only a whole bill goes back as PSR51: ' + @InvoiceNo + N' is ' + LTRIM(@BillNet) + N', the return ' + LTRIM(@Net) + N'.', 400) AS description;
        RETURN;
    END

    BEGIN TRY
        BEGIN TRANSACTION;
        -- The bill's header, lines and payments, retyped as the return (FACTS' computed columns are left for FACTS to work out).
        SELECT * INTO #h FROM dbo.SALES_HEADER WHERE SAL_FYCODE = @FyCode AND SAL_DOCTYPE = @FromType AND SAL_DOCNO = @InvoiceNo;
        SELECT * INTO #d FROM dbo.SALES_DETAILS WHERE SALDET_FYCODE = @FyCode AND SALDET_DOCTYPE = @FromType AND SALDET_DOCNO = @InvoiceNo;
        SELECT * INTO #r FROM dbo.RECEIPT_DETAILS WHERE RD_FYCODE = @FyCode AND RD_DOCTYPE = @FromType AND RD_DOCNO = @InvoiceNo;
        IF NOT EXISTS (SELECT 1 FROM #d) THROW 50001, 'The bill has no lines in FACTS.', 1;

        UPDATE #h SET SAL_DOCTYPE = @DocType, SAL_DOCNO = @DocNo, SAL_DOCDATE = @DocDate, SAL_CREATED_BY = @ClientID, SAL_CREATED_TS = GETDATE(),
                      SAL_POSTED_BY = NULL, SAL_POSTED_TS = NULL, SAL_REVISION_NO = 0, SAL_UD_LABEL3 = @FromType, SAL_UD_LABEL4 = @InvoiceNo,
                      SAL_PREVIOUS_DOCNO = @InvoiceNo, SAL_REFDATE = SAL_DOCDATE,
                      SAL_PREV_FYCODE = NULL, SAL_PREV_DOCTYPE = NULL, SAL_PREV_DOCNO = NULL, SAL_PREV_DOCDATE = NULL,
                      SAL_NARRATION = N'One POS return of ' + @InvoiceNo + ISNULL(N': ' + NULLIF(@Reason, N''), N'');
        UPDATE #d SET SALDET_DOCTYPE = @DocType, SALDET_DOCNO = @DocNo, SALDET_DOCDATE = @DocDate, SALDET_PREVIOUS_FYCODE = SALDET_FYCODE,
                      SALDET_PREVIOUS_DOCTYPE = @FromType, SALDET_PREVIOUS_DOCNO = @InvoiceNo, SALDET_PREVIOUS_DOCSRNO = SALDET_DOCSRNO, SALDET_AFTER_DOC_QTY = 0;
        UPDATE #r SET RD_DOCTYPE = @DocType, RD_DOCNO = @DocNo, RD_DOCDATE = @DocDate, RD_CREATED_TS = GETDATE();

        DECLARE @sql NVARCHAR(MAX), @cols NVARCHAR(MAX);
        SELECT @cols = STRING_AGG(CAST(QUOTENAME(name) AS NVARCHAR(MAX)), N', ') WITHIN GROUP (ORDER BY column_id)
        FROM sys.columns WHERE object_id = OBJECT_ID(N'dbo.SALES_HEADER') AND is_computed = 0 AND is_identity = 0;
        SET @sql = N'INSERT INTO dbo.SALES_HEADER (' + @cols + N') SELECT ' + @cols + N' FROM #h;';
        EXEC sys.sp_executesql @sql;
        SELECT @cols = STRING_AGG(CAST(QUOTENAME(name) AS NVARCHAR(MAX)), N', ') WITHIN GROUP (ORDER BY column_id)
        FROM sys.columns WHERE object_id = OBJECT_ID(N'dbo.SALES_DETAILS') AND is_computed = 0 AND is_identity = 0;
        SET @sql = N'INSERT INTO dbo.SALES_DETAILS (' + @cols + N') SELECT ' + @cols + N' FROM #d;';
        EXEC sys.sp_executesql @sql;
        SELECT @cols = STRING_AGG(CAST(QUOTENAME(name) AS NVARCHAR(MAX)), N', ') WITHIN GROUP (ORDER BY column_id)
        FROM sys.columns WHERE object_id = OBJECT_ID(N'dbo.RECEIPT_DETAILS') AND is_computed = 0 AND is_identity = 0;
        SET @sql = N'INSERT INTO dbo.RECEIPT_DETAILS (' + @cols + N') SELECT ' + @cols + N' FROM #r;';
        EXEC sys.sp_executesql @sql;

        -- Saved, as FACTS' screen logs a save.
        INSERT INTO dbo.ADD_EDIT_DELETE_LOG (AED_UNIQUE_ID, AED_TS, AED_MACHINE_ID, AED_USER_CODE, AED_DOCNO, AED_DOCTYPE, AED_FYCODE, AED_STATUS)
        VALUES (NEWID(), GETDATE(), N'One POS', @ClientID, @DocNo, @DocType, @FyCode, 'A');
        COMMIT TRANSACTION;
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
        SELECT NULL AS DocumentNo, 'FAILED' AS status, LEFT(ERROR_MESSAGE(), 400) AS description;
        RETURN;
    END CATCH

Approve:
    -- FACTS' own approval (Transaction Posting), as the Approve button runs it.
    DECLARE @Refused NVARCHAR(400) = NULL,
            @Docs NVARCHAR(MAX) = N'<FACTS><PARAMETERS><COLUMN1>' + @DocType + N'</COLUMN1><COLUMN2>' + @DocNo + N'</COLUMN2></PARAMETERS></FACTS>';
    SET XACT_ABORT OFF;
    BEGIN TRY
        EXEC dbo.usp_DocumentAutoApprove @strFycode = @FyCode, @strDocType = @DocType, @strXmlDocDetails = @Docs, @strLoginID = @ClientID, @strMachineId = N'One POS';
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
        SET @Refused = LEFT(ERROR_MESSAGE(), 300);
    END CATCH
    SET XACT_ABORT ON;

    IF EXISTS (SELECT 1 FROM dbo.ACTION_STATUS WHERE ACTION_FYCODE = @FyCode AND ACTION_DOCTYPE = @DocType AND ACTION_DOCNO = @DocNo AND ACTION_KEY = N'usp_SAL_APPR_Posting')
    BEGIN
        SELECT @DocNo AS DocumentNo, 'SUCCESS' AS status, N'PSR51 posted.' AS description;
        RETURN;
    END

    -- Not posted: the return is taken out again, so nothing half-done stays in FACTS.
    BEGIN TRANSACTION;
    DELETE FROM dbo.RECEIPT_DETAILS WHERE RD_FYCODE = @FyCode AND RD_DOCTYPE = @DocType AND RD_DOCNO = @DocNo;
    DELETE FROM dbo.SALES_DETAILS WHERE SALDET_FYCODE = @FyCode AND SALDET_DOCTYPE = @DocType AND SALDET_DOCNO = @DocNo;
    DELETE FROM dbo.SALES_HEADER WHERE SAL_FYCODE = @FyCode AND SAL_DOCTYPE = @DocType AND SAL_DOCNO = @DocNo;
    COMMIT TRANSACTION;
    SELECT NULL AS DocumentNo, 'FAILED' AS status, LEFT(N'FACTS approval refused the PSR51: ' + ISNULL(@Refused, N'its checks failed (e.g. the posting user isn''t allowed to post PSR51)'), 400) AS description;
END
