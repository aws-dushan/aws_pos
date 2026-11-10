-- One POS: can a bank deposit QRV50 POST if the outlet's cash account gets a sub-ledger? Rehearsal, everything rolled back.
--   1. Adds a sub-ledger to the outlet cash account in SUBLEDGER_MASTER (key: account code + sub-ledger code), as finance would.
--   2. Saves the QRV50 as finance's 9063/9064 but with that sub-ledger as the party: party 2205 / ERBQS, mode OTHERS, Others 2322.
--   3. Posts it as FACTS' Approve button does (usp_ApproveDocuments, "Transaction Posting" = usp_QRV_APPR_AccountsUpdation).
--   4. Shows the ledger lines, and how the cash account looks in FACTS' account view and balance with lines with and without it.
-- Nothing stays: the sub-ledger, the QRV50 and its ledger lines are rolled back; the last QRV50 number is unchanged.
DECLARE @User NVARCHAR(20) = N'DushanF', @Cash NVARCHAR(20) = N'2205', @Sub NVARCHAR(20) = N'ERBQS', @SubName NVARCHAR(200) = N'AL QUSAIS - BANK DEPOSITS',
        @Bank NVARCHAR(20) = N'2322', @Amount NUMERIC(18,3) = 120.000, @Slip NVARCHAR(50) = N'REHEARSAL-SUB',
        @Date DATETIME = '2026-11-08', @Narr NVARCHAR(200) = N'Deposit REHEARSAL-SUB Al Qusais 08/11/2026 taken by Imesh';
DECLARE @FyCode NVARCHAR(6) = N'CFY', @DocType NVARCHAR(10) = N'QRV50', @DocNo NVARCHAR(20), @Key NVARCHAR(100) = N'usp_QRV_APPR_AccountsUpdation',
        @Divn NVARCHAR(20), @NextBefore NVARCHAR(40), @Err NVARCHAR(400) = NULL, @Docs NVARCHAR(MAX);
SELECT @Divn = DM_DIVN_DOCNO FROM dbo.DOCUMENT_MASTER WHERE DM_DOCNO = @DocType;
SET @NextBefore = dbo.fn_GetNewDocNo(@DocType, '');

SET XACT_ABORT OFF;
BEGIN TRANSACTION;
BEGIN TRY
    INSERT INTO dbo.SUBLEDGER_MASTER (SUBLMST_DOCTYPE, SUBLMST_DOCNO, SUBLMST_DESC, SUBLMST_CR_DAYS, SUBLMST_ACTIVE_STATUS, SUBLMST_TRANSACTION_STOP,
                                      SUBLMST_TRANSACTION_BLOCK_USERS, SUBLMST_REPORT_STOP, SUBLMST_REPORT_BLOCK_USERS)
    VALUES (@Cash, @Sub, @SubName, 0, 1, 0, 0, 0, 0);
    EXEC dbo.usp_UpdateLastNoMaster_From_Transaction_Table @DocType, NULL;
    SET @DocNo = dbo.fn_GetNewDocNo(@DocType, '');
    INSERT INTO dbo.QRP_HEADER (QRP_FYCODE, QRP_DOCTYPE, QRP_DOCNO, QRP_DOCDATE, QRP_NARRATION, QRP_DR_AC_DOCNO, QRP_DR_SUBLEDGER_DOCNO, QRP_CR_AC_DOCNO, QRP_CR_SUBLEDGER_DOCNO,
        QRP_DR_CURR_DOCNO, QRP_DR_CURR_RATE, QRP_CR_CURR_DOCNO, QRP_CR_CURR_RATE, QRP_AMOUNT, QRP_MODE_DOCNO, QRP_DR_DIVN_DOCNO, QRP_CR_DIVN_DOCNO,
        QRP_CREATED_BY, QRP_CREATED_TS, QRP_PREV_BAL_AMOUNT, QRP_RECEIVED_AMOUNT, QRP_CHANGE_AMOUNT, QRP_AC_DOCNO, QRP_SUBLEDGER_DOCNO, QRP_REFNO, QRP_REFDATE,
        QRP_CASH_AMOUNT, QRP_CHEQUE_AMOUNT, QRP_CARD_AMOUNT, QRP_OTH_AMOUNT, QRP_OTHAC_DOCNO, QRP_SAL_AMOUNT, QRP_DISC_AMOUNT, QRP_TEND_AMOUNT, QRP_BAL_AMOUNT)
    VALUES (@FyCode, @DocType, @DocNo, @Date, @Narr, N'2202', NULL, @Cash, @Sub,
        N'AED', 1, N'AED', 1, @Amount, N'OTHERS', @Divn, @Divn,
        @User, GETDATE(), 0, @Amount, 0, @Cash, @Sub, @Slip, @Date,
        0, 0, 0, @Amount, @Bank, 0, 0, 0, 0);
    INSERT INTO dbo.ADD_EDIT_DELETE_LOG (AED_UNIQUE_ID, AED_TS, AED_MACHINE_ID, AED_USER_CODE, AED_DOCNO, AED_DOCTYPE, AED_FYCODE, AED_STATUS)
    VALUES (NEWID(), GETDATE(), N'One POS', @User, @DocNo, @DocType, @FyCode, 'A');
    SET @Docs = N'<FACTS><PARAMETERS><COLUMN1>' + @DocType + N'</COLUMN1><COLUMN2>' + @DocNo + N'</COLUMN2></PARAMETERS></FACTS>';
    EXEC dbo.usp_ApproveDocuments @strFyCode = @FyCode, @strDocType = @DocType, @strXmlDocDetails = @Docs, @strLoginID = @User, @strKey = @Key, @strMachineId = N'One POS';
END TRY
BEGIN CATCH
    SET @Err = LEFT(ERROR_MESSAGE(), 400);
END CATCH

-- 1. Posted? (Error = FACTS' message if it refused)
SELECT @DocNo AS QRV50_no, @Err AS error, @@TRANCOUNT AS open_tran,
       (SELECT COUNT(*) FROM dbo.ACTION_STATUS WHERE ACTION_FYCODE = @FyCode AND ACTION_DOCTYPE = @DocType AND ACTION_DOCNO = @DocNo AND ACTION_KEY = @Key) AS posted;
IF @@TRANCOUNT > 0
BEGIN
    -- 2. The ledger lines (FACTS: + = credit, - = debit). Hoped for: 2322 debited 120, 2205 / ERBQS credited 120, nothing on 2202.
    SELECT a.ACTRN_DOCSRNO, a.ACTRN_AC_DOCNO, m.ACMST_DESC, a.ACTRN_SUBLEDGER_DOCNO, a.ACTRN_AMOUNT, a.ACTRN_NARRATION, a.ACTRN_REF_NO, a.ACTRN_DIVN_DOCNO
    FROM dbo.ACCOUNT_TRANSACTION a LEFT JOIN dbo.ACCOUNT_MASTER m ON m.ACMST_DOCNO = a.ACTRN_AC_DOCNO
    WHERE a.ACTRN_FYCODE = @FyCode AND a.ACTRN_DOCTYPE = @DocType AND a.ACTRN_DOCNO = @DocNo ORDER BY a.ACTRN_DOCSRNO;
    -- 3. FACTS' account view for the cash account: one row before (2205 itself); does the sub-ledger add a second row?
    SELECT ACMST_DOCNO, ACMST_SUBLEDGER_DOCNO, LEFT(ACMST_DESC, 40) AS name FROM dbo.vw_AccountMaster_Report WHERE ACMST_DOCNO = @Cash;
    -- 4. The cash account's balance (all lines since 1 Oct), split by sub-ledger: POS51 lines have none, the QRV line has ERBQS.
    SELECT ISNULL(a.ACTRN_SUBLEDGER_DOCNO, '(none)') AS subledger, COUNT(*) AS lines, SUM(a.ACTRN_AMOUNT) AS net_credit
    FROM dbo.ACCOUNT_TRANSACTION a WHERE a.ACTRN_AC_DOCNO = @Cash AND a.ACTRN_DOCDATE >= '2026-10-01' GROUP BY a.ACTRN_SUBLEDGER_DOCNO;
    -- 5. A bill (POS51) still posts to the cash account without a sub-ledger: the account itself is unchanged.
    SELECT ACMST_DOCNO, ACMST_SUBLEDGER_TYPE_DOCNO, ACMST_ACTYPE_DOCNO FROM dbo.ACCOUNT_MASTER WHERE ACMST_DOCNO = @Cash;
END

IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
SELECT 'Rolled back' AS done,
       (SELECT COUNT(*) FROM dbo.SUBLEDGER_MASTER WHERE SUBLMST_DOCTYPE = @Cash AND SUBLMST_DOCNO = @Sub) AS subledger_left,
       (SELECT COUNT(*) FROM dbo.QRP_HEADER WHERE QRP_FYCODE = @FyCode AND QRP_DOCTYPE = @DocType AND QRP_REFNO = @Slip) AS qrv_left,
       @NextBefore AS next_qrv_before, dbo.fn_GetNewDocNo(@DocType, '') AS next_qrv_now;
