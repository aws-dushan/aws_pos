CREATE OR ALTER PROCEDURE dbo.usp_ONEPOS_PostAdvanceReturn
    @ClientID NVARCHAR(20),
    @BodyXML  XML
AS
/*
  One POS by AWS Distribution - a cancelled future order's advances given back, into FACTS, POSTED.       Created 17-11-2026 for One POS, cash only 18-11-2026.

  Each advance went to FACTS as a posted QRV51 (usp_ONEPOS_PostAdvance): net Dr the payment account (the outlet's cash float or
  2315 for cards) / Cr 2802 POS CUSTOMER ADVANCES. When the order is cancelled, One POS gives every
  advance back IN CASH from the outlet's drawer (a card advance too: never back to the card) and sends ONE PV51 (Advance Return
  Payment Voucher - POS) for the order:
      a line per advance:  Cr the outlet's CASH account, its QRV51's whole amount, linked to that QRV51
      one last line:       Dr 2802 POS CUSTOMER ADVANCES, the total
  The cash account is the one of the outlet's FACTS cash payment method (CashMode, e.g. ERBJM Cash -> 2211), as a cash
  advance's QRV51 uses. A card account (2315) or any other non-cash payment method's account is refused.
  Saved the way FACTS' screen saved PV51 1001 (finance's test, 16 Nov): header account 2802, mode CASH, sign -1, the screen's
  auto lines (credit lines auto entry 1, the 2802 line auto entry 2), analysis code 04 ON ACCOUNT, division 50, department 102.
  The header's second account is the cash account.
  Posted the way FACTS' Approve button posts it: usp_ApproveDocuments, step usp_PAY_REC_APPR_Posting (FACTS' screen lists who may
  post, the procedure doesn't), which writes ACTION_STATUS and its log.

  Refused (FAILED, nothing saved) when CashMode isn't a FACTS cash payment method, an advance has no posted QRV51, the amount isn't its QRV51's, or its QRV51 was already
  given back by a posted PV51. The same DocumentNo again (a retry) finds the PV51 already posted and answers it. If FACTS refuses,
  nothing stays: the unposted PV51 is removed again, and the answer is FAILED with FACTS' message.

  XML:  <data><AdvanceReturn>
          <DocumentNo>ADV-EBL-02-000003</DocumentNo> <DocDate>2026-11-17</DocDate> <LocationCode>ERBJM</LocationCode> <CashMode>ERBJM Cash</CashMode>
          <FutureOrderNo>FO-EBL-02-000001</FutureOrderNo> <CustomerName>…</CustomerName> <Narration>…</Narration> <CreatedBy>…</CreatedBy>
          <Line><AdvanceNo>ADV-EBL-02-000001</AdvanceNo><Amount>50.00</Amount></Line>
          <Line><AdvanceNo>ADV-EBL-02-000002</AdvanceNo><Amount>10.00</Amount></Line>
        </AdvanceReturn></data>
  Answer: DocumentNo (the PV51 number), status (SUCCESS | FAILED), description.
  FACTS' procedures are not changed by this one; dropping it changes nothing else.
*/
BEGIN
    SET NOCOUNT ON;
    -- One POS: the salesman of the person who did it (picked on their user), sent as /data/*/Salesman; one FACTS doesn't have is left out. (28-11-2026)
    DECLARE @Salesman NVARCHAR(20) = NULLIF(LTRIM(RTRIM(@BodyXML.value('(/data/*/Salesman)[1]', 'NVARCHAR(20)'))), N'');
    IF NOT EXISTS (SELECT 1 FROM dbo.SALESMAN_MASTER WHERE SMAN_DOCNO = @Salesman) SET @Salesman = NULL;
    SET XACT_ABORT ON;

    DECLARE @FyCode NVARCHAR(6) = N'CFY', @DocType NVARCHAR(6) = N'PV51', @Key NVARCHAR(50) = N'usp_PAY_REC_APPR_Posting',
            @QrvType NVARCHAR(6) = N'QRV51', @QrvKey NVARCHAR(50) = N'usp_QRV_APPR_AccountsUpdation',
            @AdvanceAc NVARCHAR(20) = N'2802', @Divn NVARCHAR(20) = N'50', @Dept NVARCHAR(20) = N'102', @Analysis NVARCHAR(20) = N'04', @Mode NVARCHAR(20) = N'CASH',
            @Ref NVARCHAR(100)      = @BodyXML.value('(/data/AdvanceReturn/DocumentNo)[1]', 'NVARCHAR(100)'),
            @DocDate DATETIME       = @BodyXML.value('(/data/AdvanceReturn/DocDate)[1]', 'DATETIME'),
            @Narr NVARCHAR(2000)    = @BodyXML.value('(/data/AdvanceReturn/Narration)[1]', 'NVARCHAR(2000)'),
            @CashMode NVARCHAR(100) = @BodyXML.value('(/data/AdvanceReturn/CashMode)[1]', 'NVARCHAR(100)'), @CashAc NVARCHAR(20),
            @DocNo NVARCHAR(20), @Total NUMERIC(18, 3), @MainAc NVARCHAR(20), @PaidTo NVARCHAR(200), @Problem NVARCHAR(400);

    DECLARE @Lines TABLE (SrNo INT IDENTITY(1, 1), AdvanceNo NVARCHAR(100), Amount NUMERIC(18, 3), QrvNo NVARCHAR(20), QrvAmount NUMERIC(18, 3), Ac NVARCHAR(20));
    INSERT INTO @Lines (AdvanceNo, Amount)
    SELECT l.value('(AdvanceNo)[1]', 'NVARCHAR(100)'), l.value('(Amount)[1]', 'NUMERIC(18,3)')
    FROM @BodyXML.nodes('/data/AdvanceReturn/Line') AS x(l);

    IF ISNULL(@Ref, '') = '' OR @DocDate IS NULL OR ISNULL(@ClientID, '') = '' OR NOT EXISTS (SELECT 1 FROM @Lines)
    BEGIN
        SELECT NULL AS DocumentNo, 'FAILED' AS status, N'Document number, date, the FACTS user and at least one advance are needed.' AS description;
        RETURN;
    END
    IF NOT EXISTS (SELECT 1 FROM dbo.USER_MASTER WHERE USER_LOGINID = @ClientID)
    BEGIN
        SELECT NULL AS DocumentNo, 'FAILED' AS status, LEFT(N'"' + @ClientID + N'" is not a FACTS user.', 400) AS description;
        RETURN;
    END
    IF NOT EXISTS (SELECT 1 FROM dbo.DEPARTMENT_MASTER WHERE DEPT_DOCNO = @Dept)
    BEGIN
        SELECT NULL AS DocumentNo, 'FAILED' AS status, LEFT(N'Department ' + @Dept + N' is not in FACTS.', 400) AS description;
        RETURN;
    END

    -- The outlet's cash account: its cash payment method's (as a cash advance's QRV51). Only a cash method, and never an account
    -- that a card or any other non-cash method uses (2315).
    SELECT TOP 1 @CashAc = PM_AC_DOCNO FROM dbo.PAYMENT_METHOD
    WHERE PM_DESC = @CashMode AND PM_DOC_DOCTYPE = N'POS51' AND PM_DESC LIKE N'% CASH' AND PM_AC_DOCNO IS NOT NULL;
    IF @CashAc IS NULL
       OR EXISTS (SELECT 1 FROM dbo.PAYMENT_METHOD WHERE PM_DOC_DOCTYPE = N'POS51' AND PM_AC_DOCNO = @CashAc AND PM_DESC NOT LIKE N'% CASH')
       OR NOT EXISTS (SELECT 1 FROM dbo.ACCOUNT_MASTER WHERE ACMST_DOCNO = @CashAc)
    BEGIN
        SELECT NULL AS DocumentNo, 'FAILED' AS status,
               LEFT(N'"' + ISNULL(@CashMode, N'') + N'" is not a FACTS cash payment method with a cash account: the advance is given back in cash only. Nothing was saved in FACTS.', 400) AS description;
        RETURN;
    END

    -- Sent before (a retry): posted -> answered as is.
    SELECT TOP 1 @DocNo = RP_DOCNO FROM dbo.RP_HEADER
    WHERE RP_FYCODE = @FyCode AND RP_DOCTYPE = @DocType AND RP_REFNO = @Ref
      AND EXISTS (SELECT 1 FROM dbo.ACTION_STATUS WHERE ACTION_FYCODE = RP_FYCODE AND ACTION_DOCTYPE = RP_DOCTYPE AND ACTION_DOCNO = RP_DOCNO AND ACTION_KEY = @Key);
    IF @DocNo IS NOT NULL
    BEGIN
        SELECT @DocNo AS DocumentNo, 'SUCCESS' AS status, N'Already posted.' AS description;
        RETURN;
    END

    -- Each advance's posted QRV51 (its number and amount); every line is given back out of the outlet's cash account.
    UPDATE l SET QrvNo = q.QRP_DOCNO, QrvAmount = q.QRP_AMOUNT, Ac = @CashAc
    FROM @Lines l
    CROSS APPLY (SELECT TOP 1 QRP_DOCNO, QRP_AMOUNT FROM dbo.QRP_HEADER
                 WHERE QRP_FYCODE = @FyCode AND QRP_DOCTYPE = @QrvType AND QRP_REFNO = l.AdvanceNo
                   AND EXISTS (SELECT 1 FROM dbo.ACTION_STATUS WHERE ACTION_FYCODE = QRP_FYCODE AND ACTION_DOCTYPE = QRP_DOCTYPE AND ACTION_DOCNO = QRP_DOCNO AND ACTION_KEY = @QrvKey)
                 ORDER BY QRP_DOCNO) q;

    SELECT TOP 1 @Problem = N'Advance ' + ISNULL(AdvanceNo, N'?') + N' has no posted QRV51 in FACTS.' FROM @Lines WHERE QrvNo IS NULL;
    IF @Problem IS NULL
        SELECT TOP 1 @Problem = N'Advance ' + AdvanceNo + N' is ' + CONVERT(NVARCHAR(30), Amount) + N' but its QRV51 ' + QrvNo + N' is ' + CONVERT(NVARCHAR(30), QrvAmount) + N'.'
        FROM @Lines WHERE ISNULL(Amount, 0) <> QrvAmount;
    IF @Problem IS NULL
        SELECT TOP 1 @Problem = N'Advance ' + AdvanceNo + N' is in the list twice.' FROM @Lines GROUP BY AdvanceNo HAVING COUNT(*) > 1;
    IF @Problem IS NULL
        SELECT TOP 1 @Problem = N'QRV51 ' + l.QrvNo + N' (advance ' + l.AdvanceNo + N') was already given back by PV51 ' + d.RPDET_DOCNO + N'.'
        FROM @Lines l JOIN dbo.RP_DETAILS d ON d.RPDET_FYCODE = @FyCode AND d.RPDET_DOCTYPE = @DocType AND d.RPDET_BEFORE_DOCTYPE = @QrvType AND d.RPDET_BEFORE_DOCNO = l.QrvNo
        WHERE EXISTS (SELECT 1 FROM dbo.ACTION_STATUS WHERE ACTION_FYCODE = d.RPDET_FYCODE AND ACTION_DOCTYPE = d.RPDET_DOCTYPE AND ACTION_DOCNO = d.RPDET_DOCNO AND ACTION_KEY = @Key);
    IF @Problem IS NOT NULL
    BEGIN
        SELECT NULL AS DocumentNo, 'FAILED' AS status, LEFT(@Problem + N' Nothing was saved in FACTS.', 400) AS description;
        RETURN;
    END

    SELECT @Total = SUM(Amount) FROM @Lines;
    SET @MainAc = @CashAc;
    SELECT @PaidTo = ACMST_DESC FROM dbo.ACCOUNT_MASTER WHERE ACMST_DOCNO = @AdvanceAc;
    SET @Narr = LEFT(ISNULL(NULLIF(@Narr, N''), N'One POS advance return ' + @Ref)
                     + N' QRV51 ' + STUFF((SELECT N', ' + QrvNo FROM @Lines ORDER BY SrNo FOR XML PATH(''), TYPE).value('.', 'NVARCHAR(MAX)'), 1, 2, N''), 2000);

    BEGIN TRY
        BEGIN TRANSACTION;
        DECLARE @lock INT;
        EXEC @lock = sp_getapplock @Resource = N'ONEPOS_PV51_NUMBER', @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = 15000;
        IF @lock < 0 THROW 50001, 'The PV51 numbering is busy; try again.', 1;

        -- Leftover of an earlier try that FACTS didn't post (not normally there): removed, then saved again under its number.
        SELECT TOP 1 @DocNo = RP_DOCNO FROM dbo.RP_HEADER WITH (UPDLOCK) WHERE RP_FYCODE = @FyCode AND RP_DOCTYPE = @DocType AND RP_REFNO = @Ref;
        IF @DocNo IS NOT NULL
        BEGIN
            DELETE FROM dbo.RP_DETAILS WHERE RPDET_FYCODE = @FyCode AND RPDET_DOCTYPE = @DocType AND RPDET_DOCNO = @DocNo;
            DELETE FROM dbo.RP_HEADER WHERE RP_FYCODE = @FyCode AND RP_DOCTYPE = @DocType AND RP_DOCNO = @DocNo;
        END
        ELSE
        BEGIN
            EXEC dbo.usp_UpdateLastNoMaster_From_Transaction_Table @DocType, NULL;
            SET @DocNo = dbo.fn_GetNewDocNo(@DocType, '');
            WHILE EXISTS (SELECT 1 FROM dbo.RP_HEADER WITH (UPDLOCK, HOLDLOCK) WHERE RP_FYCODE = @FyCode AND RP_DOCTYPE = @DocType AND RP_DOCNO = @DocNo)
                SET @DocNo = dbo.fn_GetNewDocNo(@DocType, @DocNo);
        END

        -- Header as PV51 1001: 2802 paid out (sign -1), auto entry 0 (FACTS' posting adds line 0 from it, not booked).
        INSERT INTO dbo.RP_HEADER (RP_FYCODE, RP_DOCTYPE, RP_DOCNO, RP_CHEQUE_NO, RP_AMOUNT, RP_DOCDATE, RP_NARRATION, RP_CREATED_BY, RP_CREATED_TS,
            RP_AC_DOCNO, RP_SUBLEDGER_DOCNO, RP_CURR_DOCNO, RP_CURR_RATE, RP_FCAMOUNT, RP_MODE, RP_CHEQUE_DATE, RP_CHEQUE_TO, RP_PAID_TO, RP_DRCR_SIGN,
            RP_DIVN_DOCNO, RP_DEPT_DOCNO, RP_ALLOC_FCAMOUNT, RP_ALLOC_DISCOUNT_FCAMOUNT, RP_ACTIVE_STATUS, RP_BALANCE_AMOUNT, RP_EXCHANGE_DIFF_AMOUNT,
            RP_ALLOCATED_AMOUNT, RP_ANALYSIS_CODE_DOCNO, RP_REFNO, RP_REFDATE, RP_RECOVERY_SCHDULE, RP_AUTO_ENTRY, RP_ADV_FCAMOUNT, RP_ADV_AMOUNT, RP_REFDATE2,
            RP_AC_DOCNO2, RP_DIVN_DOCNO2, RP_DEPT_DOCNO2, RP_BANK_CHARGE_AMOUNT, RP_AMOUNT2, RP_BANK_CHARGE_FCAMOUNT, RP_FCAMOUNT2, RP_CURR_RATE2, RP_CURR_DOCNO2,
            RP_BEFORE_FYCODE, RP_BEFORE_DOCTYPE, RP_BEFORE_DOCNO)
        SELECT @FyCode, @DocType, @DocNo, N'', @Total, @DocDate, @Narr, @ClientID, GETDATE(),
            @AdvanceAc, NULL, N'AED', 1, @Total, @Mode, @DocDate, @PaidTo, @PaidTo, -1,
            @Divn, @Dept, 0, 0, 0, 0, 0,
            0, @Analysis, LEFT(@Ref, 100), @DocDate, 0, 0, @Total, @Total, @DocDate,
            @MainAc, @Divn, @Dept, 0, @Total, 0, @Total, 1, N'AED',
            @FyCode, @QrvType, (SELECT TOP 1 QrvNo FROM @Lines ORDER BY SrNo);

        -- A line per advance: Cr the outlet's cash account, linked to that advance's QRV51.
        INSERT INTO dbo.RP_DETAILS (RPDET_FYCODE, RPDET_DOCTYPE, RPDET_DOCNO, RPDET_DOCSRNO, RPDET_AMOUNT, RPDET_FCAMOUNT, RPDET_DOCDATE, RPDET_VALDATE, RPDET_NARRATION,
            RPDET_CURR_DOCNO, RPDET_CURR_RATE, RPDET_AC_DOCNO, RPDET_MODE, RPDET_CHEQUE_DATE, RPDET_BEFORE_FYCODE, RPDET_BEFORE_DOCTYPE, RPDET_BEFORE_DOCNO,
            RPDET_DRCR_SIGN, RPDET_DIVN_DOCNO, RPDET_DEPT_DOCNO, RPDET_AC_DOCNO_HEADER, RPDET_ANALYSIS_CODE_DOCNO, RPDET_AUTO_ENTRY)
        SELECT @FyCode, @DocType, @DocNo, SrNo, Amount, Amount, @DocDate, @DocDate, LEFT(N'Advance ' + AdvanceNo + N' QRV51 ' + QrvNo + N' paid back in cash', 2000),
            N'AED', 1, Ac, @Mode, @DocDate, @FyCode, @QrvType, QrvNo,
            1, @Divn, @Dept, @AdvanceAc, @Analysis, 1
        FROM @Lines;

        -- The last line: Dr 2802 POS CUSTOMER ADVANCES, the total.
        INSERT INTO dbo.RP_DETAILS (RPDET_FYCODE, RPDET_DOCTYPE, RPDET_DOCNO, RPDET_DOCSRNO, RPDET_AMOUNT, RPDET_FCAMOUNT, RPDET_DOCDATE, RPDET_VALDATE, RPDET_NARRATION,
            RPDET_CURR_DOCNO, RPDET_CURR_RATE, RPDET_AC_DOCNO, RPDET_MODE, RPDET_CHEQUE_DATE, RPDET_BEFORE_FYCODE, RPDET_BEFORE_DOCSRNO,
            RPDET_DRCR_SIGN, RPDET_DIVN_DOCNO, RPDET_DEPT_DOCNO, RPDET_AC_DOCNO_HEADER, RPDET_ANALYSIS_CODE_DOCNO, RPDET_AUTO_ENTRY)
        SELECT @FyCode, @DocType, @DocNo, (SELECT COUNT(*) FROM @Lines) + 1, @Total, @Total, @DocDate, @DocDate, NULL,
            N'AED', 1, @AdvanceAc, @Mode, @DocDate, @FyCode, 0,
            -1, @Divn, @Dept, @AdvanceAc, @Analysis, 2;

        -- The salesman of the person who did it (none: left empty).
        IF @Salesman IS NOT NULL UPDATE dbo.RP_HEADER SET RP_SMAN_DOCNO = @Salesman WHERE RP_FYCODE = @FyCode AND RP_DOCTYPE = @DocType AND RP_DOCNO = @DocNo;

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

    -- FACTS' own posting, as its Approve button runs it.
    DECLARE @Refused NVARCHAR(400) = NULL;
    DECLARE @Docs NVARCHAR(MAX) = N'<FACTS><PARAMETERS><COLUMN1>' + @DocType + N'</COLUMN1><COLUMN2>' + @DocNo + N'</COLUMN2></PARAMETERS></FACTS>';
    SET XACT_ABORT OFF;
    BEGIN TRY
        EXEC dbo.usp_ApproveDocuments @strFyCode = @FyCode, @strDocType = @DocType, @strXmlDocDetails = @Docs, @strLoginID = @ClientID, @strKey = @Key, @strMachineId = N'One POS';
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
        SET @Refused = LEFT(ERROR_MESSAGE(), 300);
    END CATCH
    SET XACT_ABORT ON;

    IF NOT EXISTS (SELECT 1 FROM dbo.ACTION_STATUS WHERE ACTION_FYCODE = @FyCode AND ACTION_DOCTYPE = @DocType AND ACTION_DOCNO = @DocNo AND ACTION_KEY = @Key)
    BEGIN
        -- Not posted: nothing stays in FACTS (the unposted PV51 moved no money; it is removed with its save log).
        DELETE FROM dbo.RP_DETAILS WHERE RPDET_FYCODE = @FyCode AND RPDET_DOCTYPE = @DocType AND RPDET_DOCNO = @DocNo;
        DELETE FROM dbo.RP_HEADER WHERE RP_FYCODE = @FyCode AND RP_DOCTYPE = @DocType AND RP_DOCNO = @DocNo;
        DELETE FROM dbo.ACCOUNT_TRANSACTION WHERE ACTRN_FYCODE = @FyCode AND ACTRN_DOCTYPE = @DocType AND ACTRN_DOCNO = @DocNo;
        DELETE FROM dbo.ADD_EDIT_DELETE_LOG WHERE AED_FYCODE = @FyCode AND AED_DOCTYPE = @DocType AND AED_DOCNO = @DocNo AND AED_MACHINE_ID = N'One POS' AND AED_STATUS = 'A';
        SELECT NULL AS DocumentNo, 'FAILED' AS status,
               LEFT(N'FACTS did not post the PV51: ' + ISNULL(@Refused, N'its posting step refused it') + N'. Nothing was saved in FACTS.', 400) AS description;
        RETURN;
    END

    SELECT @DocNo AS DocumentNo, 'SUCCESS' AS status, N'PV51 posted.' AS description;
END
