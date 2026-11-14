CREATE PROCEDURE dbo.usp_ONEPOS_PostAdvance
    @ClientID NVARCHAR(20),
    @BodyXML  XML
AS
/*
  One POS by AWS Distribution - a future order's advance into FACTS, POSTED.                              Created 13-11-2026 for One POS.

  A customer orders now for a later day and pays an advance. The advance waits on 2802 POS CUSTOMER ADVANCES until the order is
  collected; the bill (POS51, sent by usp_ONEPOS_SaveInvoice on the collection day) is then paid by ADVANCE, which takes it off 2802.

  One QRV51 (Quick Receipt Voucher-POS) per advance, dated the day it was taken, saved the way FACTS' screen saves a QRV in
  "Others" mode: the party (credited) is 2802 with its sub-ledger; the Others account (debited) is the account of the payment
  method the advance was paid by (PAYMENT_METHOD.PM_AC_DOCNO of the POS51 row, e.g. 2315 for cards, 2205 for ERBQS CASH); the
  default cash account (2202) is not touched. Department = the outlet (ERBQS…), division 50. Ref no = One POS' advance number.
  Posted the way FACTS' Approve button posts it: usp_ApproveDocuments, step usp_QRV_APPR_AccountsUpdation (no user limit),
  which writes ACTION_STATUS and its log.
  An advance given back (a cancelled order) is not sent: finance books it by hand.

  Needs in FACTS first (set up by the FACTS developer):
    - a sub-ledger under account 2802 (C0006 is taken if there, else the first one), so the QRV51 party is complete;
    - the payment method ADVANCE with sign +1 on POS51 (-1 on PSR51), so a bill paid by ADVANCE debits 2802.

  The same DocumentNo again (a retry) finds the QRV51 already posted and answers it. If FACTS refuses, nothing stays: the
  unposted QRV51 is removed again, and the answer is FAILED with FACTS' message.

  XML:  <data><Advance>
          <DocumentNo>ADV-EBL-01-000001</DocumentNo> <Type>Receipt</Type>
          <DocDate>2026-11-14</DocDate> <LocationCode>ERBQS</LocationCode> <ReceiptMode>ERBQS VISA CARD</ReceiptMode> <Amount>200.00</Amount>
          <FutureOrderNo>FO-EBL-01-000001</FutureOrderNo> <CollectionDate>2026-11-16</CollectionDate>
          <CustomerName>…</CustomerName> <MobileNo>…</MobileNo> <Narration>…</Narration> <CreatedBy>…</CreatedBy>
        </Advance></data>
  Answer: DocumentNo (the QRV51 number), status (SUCCESS | FAILED), description.
  FACTS' procedures are not changed by this one; dropping it changes nothing else.
*/
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @FyCode NVARCHAR(6) = N'CFY', @DocType NVARCHAR(6) = N'QRV51', @Key NVARCHAR(50) = N'usp_QRV_APPR_AccountsUpdation', @AdvanceAc NVARCHAR(20) = N'2802',
            @Ref NVARCHAR(20)       = @BodyXML.value('(/data/Advance/DocumentNo)[1]', 'NVARCHAR(20)'),
            @Type NVARCHAR(10)      = ISNULL(@BodyXML.value('(/data/Advance/Type)[1]', 'NVARCHAR(10)'), N'Receipt'),
            @DocDate DATETIME       = @BodyXML.value('(/data/Advance/DocDate)[1]', 'DATETIME'),
            @Loc NVARCHAR(20)       = @BodyXML.value('(/data/Advance/LocationCode)[1]', 'NVARCHAR(20)'),
            @Mode NVARCHAR(100)     = @BodyXML.value('(/data/Advance/ReceiptMode)[1]', 'NVARCHAR(100)'),
            @Amount NUMERIC(18, 3)  = @BodyXML.value('(/data/Advance/Amount)[1]', 'NUMERIC(18,3)'),
            @Narr NVARCHAR(2000)    = @BodyXML.value('(/data/Advance/Narration)[1]', 'NVARCHAR(2000)'),
            @DocNo NVARCHAR(20), @PayAc NVARCHAR(20), @Sub NVARCHAR(20), @Dept NVARCHAR(20), @Divn NVARCHAR(20) = N'50';

    IF @Type <> N'Receipt'
    BEGIN
        SELECT NULL AS DocumentNo, 'FAILED' AS status, N'Only advance receipts are posted; an advance given back is booked by finance.' AS description;
        RETURN;
    END
    IF ISNULL(@Ref, '') = '' OR @DocDate IS NULL OR ISNULL(@Loc, '') = '' OR ISNULL(@Mode, '') = '' OR ISNULL(@Amount, 0) <= 0 OR ISNULL(@ClientID, '') = ''
    BEGIN
        SELECT NULL AS DocumentNo, 'FAILED' AS status, N'Document number, date, location, payment method, an amount above zero and the FACTS user are needed.' AS description;
        RETURN;
    END
    IF NOT EXISTS (SELECT 1 FROM dbo.USER_MASTER WHERE USER_LOGINID = @ClientID)
    BEGIN
        SELECT NULL AS DocumentNo, 'FAILED' AS status, LEFT(N'"' + @ClientID + N'" is not a FACTS user.', 400) AS description;
        RETURN;
    END
    SELECT TOP 1 @PayAc = PM_AC_DOCNO FROM dbo.PAYMENT_METHOD WHERE PM_DESC = @Mode AND PM_DOC_DOCTYPE = N'POS51' AND PM_AC_DOCNO IS NOT NULL;
    IF @PayAc IS NULL
    BEGIN
        SELECT NULL AS DocumentNo, 'FAILED' AS status, LEFT(N'"' + @Mode + N'" is not a FACTS POS payment method with an account.', 400) AS description;
        RETURN;
    END
    SELECT TOP 1 @Sub = SUBLMST_DOCNO FROM dbo.SUBLEDGER_MASTER WHERE SUBLMST_DOCTYPE = @AdvanceAc ORDER BY CASE WHEN SUBLMST_DOCNO = N'C0006' THEN 0 ELSE 1 END, SUBLMST_DOCNO;
    IF @Sub IS NULL
    BEGIN
        SELECT NULL AS DocumentNo, 'FAILED' AS status, N'Account 2802 POS CUSTOMER ADVANCES has no sub-ledger in FACTS yet, so a QRV51 can''t post to it. The FACTS developer adds one (e.g. C0006).' AS description;
        RETURN;
    END
    SELECT @Dept = DEPT_DOCNO FROM dbo.DEPARTMENT_MASTER WHERE DEPT_DOCNO = @Loc;
    SET @Narr = LEFT(ISNULL(NULLIF(@Narr, N''), N'One POS advance ' + @Ref), 2000);

    -- Sent before (a retry): posted -> answered as is.
    SELECT TOP 1 @DocNo = QRP_DOCNO FROM dbo.QRP_HEADER
    WHERE QRP_FYCODE = @FyCode AND QRP_DOCTYPE = @DocType AND QRP_REFNO = @Ref
      AND EXISTS (SELECT 1 FROM dbo.ACTION_STATUS WHERE ACTION_FYCODE = QRP_FYCODE AND ACTION_DOCTYPE = QRP_DOCTYPE AND ACTION_DOCNO = QRP_DOCNO AND ACTION_KEY = @Key);
    IF @DocNo IS NOT NULL
    BEGIN
        SELECT @DocNo AS DocumentNo, 'SUCCESS' AS status, N'Already posted.' AS description;
        RETURN;
    END

    BEGIN TRY
        BEGIN TRANSACTION;
        DECLARE @lock INT;
        EXEC @lock = sp_getapplock @Resource = N'ONEPOS_QRV51_NUMBER', @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = 15000;
        IF @lock < 0 THROW 50001, 'The QRV51 numbering is busy; try again.', 1;

        -- Leftover of an earlier try that FACTS didn't post (not normally there): removed, then saved again under its number.
        SELECT TOP 1 @DocNo = QRP_DOCNO FROM dbo.QRP_HEADER WITH (UPDLOCK) WHERE QRP_FYCODE = @FyCode AND QRP_DOCTYPE = @DocType AND QRP_REFNO = @Ref;
        IF @DocNo IS NOT NULL
            DELETE FROM dbo.QRP_HEADER WHERE QRP_FYCODE = @FyCode AND QRP_DOCTYPE = @DocType AND QRP_DOCNO = @DocNo;
        ELSE
        BEGIN
            EXEC dbo.usp_UpdateLastNoMaster_From_Transaction_Table @DocType, NULL;
            SET @DocNo = dbo.fn_GetNewDocNo(@DocType, '');
            WHILE EXISTS (SELECT 1 FROM dbo.QRP_HEADER WITH (UPDLOCK, HOLDLOCK) WHERE QRP_FYCODE = @FyCode AND QRP_DOCTYPE = @DocType AND QRP_DOCNO = @DocNo)
                SET @DocNo = dbo.fn_GetNewDocNo(@DocType, @DocNo);
        END

        -- "Others" mode: the party (2802 / sub-ledger) is credited, the Others account (the payment method's) debited.
        INSERT INTO dbo.QRP_HEADER (QRP_FYCODE, QRP_DOCTYPE, QRP_DOCNO, QRP_DOCDATE, QRP_NARRATION, QRP_DR_AC_DOCNO, QRP_DR_SUBLEDGER_DOCNO, QRP_CR_AC_DOCNO, QRP_CR_SUBLEDGER_DOCNO,
            QRP_DR_CURR_DOCNO, QRP_DR_CURR_RATE, QRP_CR_CURR_DOCNO, QRP_CR_CURR_RATE, QRP_AMOUNT, QRP_MODE_DOCNO, QRP_DR_DIVN_DOCNO, QRP_DR_DEPT_DOCNO, QRP_CR_DIVN_DOCNO, QRP_CR_DEPT_DOCNO,
            QRP_CREATED_BY, QRP_CREATED_TS, QRP_PREV_BAL_AMOUNT, QRP_RECEIVED_AMOUNT, QRP_CHANGE_AMOUNT, QRP_AC_DOCNO, QRP_SUBLEDGER_DOCNO, QRP_REFNO, QRP_REFDATE,
            QRP_CASH_AMOUNT, QRP_CHEQUE_AMOUNT, QRP_CARD_AMOUNT, QRP_OTH_AMOUNT, QRP_OTHAC_DOCNO, QRP_SAL_AMOUNT, QRP_DISC_AMOUNT, QRP_TEND_AMOUNT, QRP_BAL_AMOUNT)
        VALUES (@FyCode, @DocType, @DocNo, @DocDate, @Narr, N'2202', NULL, @AdvanceAc, @Sub,
            N'AED', 1, N'AED', 1, @Amount, N'OTHERS', @Divn, @Dept, @Divn, @Dept,
            @ClientID, GETDATE(), 0, @Amount, 0, @AdvanceAc, @Sub, @Ref, @DocDate,
            0, 0, 0, @Amount, @PayAc, 0, 0, 0, 0);

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
        -- Not posted: nothing stays in FACTS (the unposted QRV51 moved no money; it is removed with its save log).
        DELETE FROM dbo.QRP_HEADER WHERE QRP_FYCODE = @FyCode AND QRP_DOCTYPE = @DocType AND QRP_DOCNO = @DocNo;
        DELETE FROM dbo.ACCOUNT_TRANSACTION WHERE ACTRN_FYCODE = @FyCode AND ACTRN_DOCTYPE = @DocType AND ACTRN_DOCNO = @DocNo;
        DELETE FROM dbo.ADD_EDIT_DELETE_LOG WHERE AED_FYCODE = @FyCode AND AED_DOCTYPE = @DocType AND AED_DOCNO = @DocNo AND AED_MACHINE_ID = N'One POS' AND AED_STATUS = 'A';
        SELECT NULL AS DocumentNo, 'FAILED' AS status,
               LEFT(N'FACTS did not post the QRV51: ' + ISNULL(@Refused, N'its posting step refused it') + N'. Nothing was saved in FACTS.', 400) AS description;
        RETURN;
    END

    SELECT @DocNo AS DocumentNo, 'SUCCESS' AS status, N'QRV51 posted.' AS description;
END
