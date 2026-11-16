CREATE PROCEDURE dbo.usp_ONEPOS_PostDeposit
    @ClientID NVARCHAR(20),
    @BodyXML  XML
AS
/*
  One POS by AWS Distribution - an outlet's bank deposit into FACTS, POSTED.                              Created 16-11-2026 for One POS.

  The cashier takes cash from the drawer to the bank and records it on the till (amount, bag / bank slip number, who takes it).
  One QRV50 (Quick Receipt Voucher) per deposit, dated the deposit's business day, saved the way FACTS' screen saves a QRV in
  "Others" mode: the party (credited) is the outlet's cash account (PAYMENT_METHOD.PM_AC_DOCNO of its cash method on POS51,
  e.g. ERBQS CASH -> 2205), without a sub-ledger (the cash accounts have none, so FACTS' posting doesn't ask for one); the Others
  account (debited) is the bank collection account (2322 EIB - COLLECTION unless the XML says another); the default cash account
  (2202) is not touched. Division 50. Ref no = the bag / slip number. No department, no salesman.
  Posted the way FACTS' Approve button posts it: usp_ApproveDocuments, step usp_QRV_APPR_AccountsUpdation, which writes
  ACTION_STATUS and its log. Ledger: Dr 2322, Cr the outlet cash account.

  The same DepositId again (a retry, kept in QRP_UD_LABEL5) finds the QRV50 already posted and answers it. If FACTS refuses, nothing stays: the unposted
  QRV50 is removed again, and the answer is FAILED with FACTS' message.

  XML:  <data><Deposit>
          <DepositId>(One POS' id of the deposit)</DepositId> <DocDate>2026-11-16</DocDate> <LocationCode>ERBQS</LocationCode>
          <CashMode>ERBQS CASH</CashMode> <BankAccount>2322</BankAccount> <Amount>1250.00</Amount>
          <SlipNo>E4011842263120701</SlipNo> <TakenBy>Imesh</TakenBy> <Narration>…</Narration>
        </Deposit></data>
  Answer: DocumentNo (the QRV50 number), status (SUCCESS | FAILED), description.
  FACTS' procedures are not changed by this one; dropping it changes nothing else.
*/
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @FyCode NVARCHAR(6) = N'CFY', @DocType NVARCHAR(6) = N'QRV50', @Key NVARCHAR(50) = N'usp_QRV_APPR_AccountsUpdation',
            @Id NVARCHAR(40)        = @BodyXML.value('(/data/Deposit/DepositId)[1]', 'NVARCHAR(40)'),
            @DocDate DATETIME       = @BodyXML.value('(/data/Deposit/DocDate)[1]', 'DATETIME'),
            @Mode NVARCHAR(100)     = @BodyXML.value('(/data/Deposit/CashMode)[1]', 'NVARCHAR(100)'),
            @Bank NVARCHAR(20)      = ISNULL(NULLIF(@BodyXML.value('(/data/Deposit/BankAccount)[1]', 'NVARCHAR(20)'), N''), N'2322'),
            @Amount NUMERIC(18, 3)  = @BodyXML.value('(/data/Deposit/Amount)[1]', 'NUMERIC(18,3)'),
            @Slip NVARCHAR(50)      = @BodyXML.value('(/data/Deposit/SlipNo)[1]', 'NVARCHAR(50)'),
            @Narr NVARCHAR(2000)    = @BodyXML.value('(/data/Deposit/Narration)[1]', 'NVARCHAR(2000)'),
            @Tag NVARCHAR(50), @DocNo NVARCHAR(20), @CashAc NVARCHAR(20), @Divn NVARCHAR(20) = N'50';

    IF ISNULL(@Id, '') = '' OR @DocDate IS NULL OR ISNULL(@Mode, '') = '' OR ISNULL(@Amount, 0) <= 0 OR ISNULL(@Slip, '') = '' OR ISNULL(@ClientID, '') = ''
    BEGIN
        SELECT NULL AS DocumentNo, 'FAILED' AS status, N'Deposit id, date, cash method, an amount above zero, the slip number and the FACTS user are needed.' AS description;
        RETURN;
    END
    IF NOT EXISTS (SELECT 1 FROM dbo.USER_MASTER WHERE USER_LOGINID = @ClientID)
    BEGIN
        SELECT NULL AS DocumentNo, 'FAILED' AS status, LEFT(N'"' + @ClientID + N'" is not a FACTS user.', 400) AS description;
        RETURN;
    END
    SELECT TOP 1 @CashAc = PM_AC_DOCNO FROM dbo.PAYMENT_METHOD WHERE PM_DESC = @Mode AND PM_DOC_DOCTYPE = N'POS51' AND PM_AC_DOCNO IS NOT NULL;
    IF @CashAc IS NULL
    BEGIN
        SELECT NULL AS DocumentNo, 'FAILED' AS status, LEFT(N'"' + @Mode + N'" is not a FACTS POS payment method with an account.', 400) AS description;
        RETURN;
    END
    IF NOT EXISTS (SELECT 1 FROM dbo.ACCOUNT_MASTER WHERE ACMST_DOCNO = @Bank)
    BEGIN
        SELECT NULL AS DocumentNo, 'FAILED' AS status, LEFT(N'Bank account ' + @Bank + N' is not in FACTS.', 400) AS description;
        RETURN;
    END
    IF EXISTS (SELECT 1 FROM dbo.ACCOUNT_MASTER WHERE ACMST_DOCNO = @CashAc AND ISNULL(ACMST_SUBLEDGER_EXISTS, 0) = 1)
    BEGIN
        SELECT NULL AS DocumentNo, 'FAILED' AS status, LEFT(N'Cash account ' + @CashAc + N' now has sub-ledgers in FACTS, so a QRV50 needs one; One POS sends none.', 400) AS description;
        RETURN;
    END
    -- The key a retry finds this deposit by: "ONEPOS <id>" in the QRV's user-defined label 5 (FACTS' posting doesn't read it); the slip is its ref no.
    SET @Tag = LEFT(N'ONEPOS ' + @Id, 50);
    SET @Narr = LEFT(ISNULL(NULLIF(@Narr, N''), N'Deposit ' + @Slip), 2000);

    -- Sent before (a retry): posted -> answered as is.
    SELECT TOP 1 @DocNo = QRP_DOCNO FROM dbo.QRP_HEADER
    WHERE QRP_FYCODE = @FyCode AND QRP_DOCTYPE = @DocType AND QRP_UD_LABEL5 = @Tag
      AND EXISTS (SELECT 1 FROM dbo.ACTION_STATUS WHERE ACTION_FYCODE = QRP_FYCODE AND ACTION_DOCTYPE = QRP_DOCTYPE AND ACTION_DOCNO = QRP_DOCNO AND ACTION_KEY = @Key);
    IF @DocNo IS NOT NULL
    BEGIN
        SELECT @DocNo AS DocumentNo, 'SUCCESS' AS status, N'Already posted.' AS description;
        RETURN;
    END

    BEGIN TRY
        BEGIN TRANSACTION;
        DECLARE @lock INT;
        EXEC @lock = sp_getapplock @Resource = N'ONEPOS_QRV50_NUMBER', @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = 15000;
        IF @lock < 0 THROW 50001, 'The QRV50 numbering is busy; try again.', 1;

        -- Leftover of an earlier try that FACTS didn't post (not normally there): removed, then saved again under its number.
        SELECT TOP 1 @DocNo = QRP_DOCNO FROM dbo.QRP_HEADER WITH (UPDLOCK)
        WHERE QRP_FYCODE = @FyCode AND QRP_DOCTYPE = @DocType AND QRP_UD_LABEL5 = @Tag;
        IF @DocNo IS NOT NULL
            DELETE FROM dbo.QRP_HEADER WHERE QRP_FYCODE = @FyCode AND QRP_DOCTYPE = @DocType AND QRP_DOCNO = @DocNo;
        ELSE
        BEGIN
            EXEC dbo.usp_UpdateLastNoMaster_From_Transaction_Table @DocType, NULL;
            SET @DocNo = dbo.fn_GetNewDocNo(@DocType, '');
            WHILE EXISTS (SELECT 1 FROM dbo.QRP_HEADER WITH (UPDLOCK, HOLDLOCK) WHERE QRP_FYCODE = @FyCode AND QRP_DOCTYPE = @DocType AND QRP_DOCNO = @DocNo)
                SET @DocNo = dbo.fn_GetNewDocNo(@DocType, @DocNo);
        END

        -- "Others" mode: the party (outlet cash, no sub-ledger) is credited, the Others account (the bank) debited.
        INSERT INTO dbo.QRP_HEADER (QRP_FYCODE, QRP_DOCTYPE, QRP_DOCNO, QRP_DOCDATE, QRP_NARRATION, QRP_DR_AC_DOCNO, QRP_DR_SUBLEDGER_DOCNO, QRP_CR_AC_DOCNO, QRP_CR_SUBLEDGER_DOCNO,
            QRP_DR_CURR_DOCNO, QRP_DR_CURR_RATE, QRP_CR_CURR_DOCNO, QRP_CR_CURR_RATE, QRP_AMOUNT, QRP_MODE_DOCNO, QRP_DR_DIVN_DOCNO, QRP_CR_DIVN_DOCNO,
            QRP_CREATED_BY, QRP_CREATED_TS, QRP_PREV_BAL_AMOUNT, QRP_RECEIVED_AMOUNT, QRP_CHANGE_AMOUNT, QRP_AC_DOCNO, QRP_SUBLEDGER_DOCNO, QRP_REFNO, QRP_REFDATE,
            QRP_CASH_AMOUNT, QRP_CHEQUE_AMOUNT, QRP_CARD_AMOUNT, QRP_OTH_AMOUNT, QRP_OTHAC_DOCNO, QRP_SAL_AMOUNT, QRP_DISC_AMOUNT, QRP_TEND_AMOUNT, QRP_BAL_AMOUNT,
            QRP_UD_LABEL5)
        VALUES (@FyCode, @DocType, @DocNo, @DocDate, @Narr, N'2202', NULL, @CashAc, NULL,
            N'AED', 1, N'AED', 1, @Amount, N'OTHERS', @Divn, @Divn,
            @ClientID, GETDATE(), 0, @Amount, 0, @CashAc, NULL, LEFT(@Slip, 50), @DocDate,
            0, 0, 0, @Amount, @Bank, 0, 0, 0, 0,
            @Tag);

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
        -- Not posted: nothing stays in FACTS (the unposted QRV50 moved no money; it is removed with its save log).
        DELETE FROM dbo.QRP_HEADER WHERE QRP_FYCODE = @FyCode AND QRP_DOCTYPE = @DocType AND QRP_DOCNO = @DocNo;
        DELETE FROM dbo.ACCOUNT_TRANSACTION WHERE ACTRN_FYCODE = @FyCode AND ACTRN_DOCTYPE = @DocType AND ACTRN_DOCNO = @DocNo;
        DELETE FROM dbo.ADD_EDIT_DELETE_LOG WHERE AED_FYCODE = @FyCode AND AED_DOCTYPE = @DocType AND AED_DOCNO = @DocNo AND AED_MACHINE_ID = N'One POS' AND AED_STATUS = 'A';
        SELECT NULL AS DocumentNo, 'FAILED' AS status,
               LEFT(N'FACTS did not post the QRV50: ' + ISNULL(@Refused, N'its posting step refused it') + N'. Nothing was saved in FACTS.', 400) AS description;
        RETURN;
    END

    SELECT @DocNo AS DocumentNo, 'SUCCESS' AS status, N'QRV50 posted.' AS description;
END
