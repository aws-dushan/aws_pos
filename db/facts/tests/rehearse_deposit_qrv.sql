-- One POS: rehearse bank deposits as QRV50 (Quick Receipt Voucher-Bakery), one per outlet, built as finance's QRV50 9063
-- (MohamadI, 9 Nov 2026, on the FACTS screen):
--   Party (credited)          : the outlet's cash account, no sub-ledger
--   Others account (debited)  : the bank, 2322 EIB collection, with the amount as an "other" receipt (mode OTHERS), so QRV's
--                               default cash account (2202 Cash in hand) is not touched
--   Ref No / Ref date         : the bank slip or bag number and the deposit date; narration at most 50 characters
-- @Post = 1: also posted as FACTS' Approve button does (usp_ApproveDocuments, "Transaction Posting" = usp_QRV_APPR_AccountsUpdation).
--   9 Nov: FACTS' posting refuses it ("Party Account Not Specified in the Document!": the step needs a party sub-ledger, and a cash
--   account has none; a sub-ledger = the account code is refused at save, FK_QRP_HEADER_SUBLEDGER_MASTER). So 9063 stays unposted.
-- @Post = 0: saved only, as 9063 is now: the record that the cash was handed over; accounts make the RV50 from it.
-- Everything is rolled back at the end: no QRV50, no ledger lines, the last QRV50 number unchanged.
DECLARE @User NVARCHAR(20) = N'DushanF', @Bank NVARCHAR(20) = N'2322', @Date DATETIME = CONVERT(DATE, GETDATE()), @Post BIT = 0;
DECLARE @Outlets TABLE (Seq INT IDENTITY, Cash NVARCHAR(20), Outlet NVARCHAR(30), Amount NUMERIC(18,3), Slip NVARCHAR(20));
INSERT INTO @Outlets (Cash, Outlet, Amount, Slip) VALUES
    (N'2211', N'Mercato',          330.000, N'REHEARSAL01'),
    (N'2205', N'Al Qusais',        120.500, N'REHEARSAL02'),
    (N'2214', N'Al Barsha',        245.000, N'REHEARSAL03'),
    (N'2204', N'Preda Al Qusais',   80.250, N'REHEARSAL04'),
    (N'2213', N'Preda Al Barsha',   61.000, N'REHEARSAL05');

DECLARE @FyCode NVARCHAR(6) = N'CFY', @DocType NVARCHAR(10) = N'QRV50', @Key NVARCHAR(100) = N'usp_QRV_APPR_AccountsUpdation',
        @Divn NVARCHAR(20), @LastBefore NVARCHAR(40), @Seq INT = 1, @DocNo NVARCHAR(20), @Cash NVARCHAR(20), @Outlet NVARCHAR(30),
        @Amount NUMERIC(18,3), @Slip NVARCHAR(20), @Narr NVARCHAR(50), @Docs NVARCHAR(MAX), @Err NVARCHAR(400);
DECLARE @Done TABLE (Seq INT, DocNo NVARCHAR(20), Cash NVARCHAR(20), Outlet NVARCHAR(30), Amount NUMERIC(18,3), Slip NVARCHAR(20), Error NVARCHAR(400));
SELECT @Divn = DM_DIVN_DOCNO FROM dbo.DOCUMENT_MASTER WHERE DM_DOCNO = @DocType;
SELECT @LastBefore = dbo.fn_GetNewDocNo(@DocType, '');

SET XACT_ABORT OFF;
BEGIN TRANSACTION;
WHILE @@TRANCOUNT > 0 AND @Seq <= (SELECT MAX(Seq) FROM @Outlets)
BEGIN
    SELECT @Cash = Cash, @Outlet = Outlet, @Amount = Amount, @Slip = Slip FROM @Outlets WHERE Seq = @Seq;
    SET @Narr = LEFT(N'Deposit ' + @Slip + N' ' + @Outlet + N' ' + CONVERT(NVARCHAR(10), @Date, 103), 50);
    SET @Err = NULL;
    EXEC dbo.usp_UpdateLastNoMaster_From_Transaction_Table @DocType, NULL;
    SET @DocNo = dbo.fn_GetNewDocNo(@DocType, '');
    BEGIN TRY
        INSERT INTO dbo.QRP_HEADER (QRP_FYCODE, QRP_DOCTYPE, QRP_DOCNO, QRP_DOCDATE, QRP_NARRATION, QRP_DR_AC_DOCNO, QRP_DR_SUBLEDGER_DOCNO, QRP_CR_AC_DOCNO, QRP_CR_SUBLEDGER_DOCNO,
            QRP_DR_CURR_DOCNO, QRP_DR_CURR_RATE, QRP_CR_CURR_DOCNO, QRP_CR_CURR_RATE, QRP_AMOUNT, QRP_MODE_DOCNO, QRP_DR_DIVN_DOCNO, QRP_CR_DIVN_DOCNO,
            QRP_CREATED_BY, QRP_CREATED_TS, QRP_PREV_BAL_AMOUNT, QRP_RECEIVED_AMOUNT, QRP_CHANGE_AMOUNT, QRP_AC_DOCNO, QRP_SUBLEDGER_DOCNO, QRP_REFNO, QRP_REFDATE,
            QRP_CASH_AMOUNT, QRP_CHEQUE_AMOUNT, QRP_CARD_AMOUNT, QRP_OTH_AMOUNT, QRP_OTHAC_DOCNO, QRP_SAL_AMOUNT, QRP_DISC_AMOUNT, QRP_TEND_AMOUNT, QRP_BAL_AMOUNT)
        VALUES (@FyCode, @DocType, @DocNo, @Date, @Narr, N'2202', NULL, @Cash, NULL,
            N'AED', 1, N'AED', 1, @Amount, N'OTHERS', @Divn, @Divn,
            @User, GETDATE(), 0, @Amount, 0, @Cash, NULL, @Slip, @Date,
            0, 0, 0, @Amount, @Bank, 0, 0, 0, 0);
        INSERT INTO dbo.ADD_EDIT_DELETE_LOG (AED_UNIQUE_ID, AED_TS, AED_MACHINE_ID, AED_USER_CODE, AED_DOCNO, AED_DOCTYPE, AED_FYCODE, AED_STATUS)
        VALUES (NEWID(), GETDATE(), N'One POS', @User, @DocNo, @DocType, @FyCode, 'A');
        SET @Docs = N'<FACTS><PARAMETERS><COLUMN1>' + @DocType + N'</COLUMN1><COLUMN2>' + @DocNo + N'</COLUMN2></PARAMETERS></FACTS>';
        IF @Post = 1 EXEC dbo.usp_ApproveDocuments @strFyCode = @FyCode, @strDocType = @DocType, @strXmlDocDetails = @Docs, @strLoginID = @User, @strKey = @Key, @strMachineId = N'One POS';
    END TRY
    BEGIN CATCH
        SET @Err = LEFT(ERROR_MESSAGE(), 400);
    END CATCH
    INSERT INTO @Done VALUES (@Seq, @DocNo, @Cash, @Outlet, @Amount, @Slip, @Err);
    SET @Seq += 1;
END

-- 1. Each outlet: posted? (ACTION_STATUS = FACTS' "posted"; Error = FACTS' message if it refused)
SELECT d.Seq, d.Outlet, d.Cash, d.DocNo, d.Amount, d.Slip, d.Error,
       (SELECT COUNT(*) FROM dbo.ACTION_STATUS WHERE ACTION_FYCODE = @FyCode AND ACTION_DOCTYPE = @DocType AND ACTION_DOCNO = d.DocNo AND ACTION_KEY = @Key) AS posted,
       (SELECT TOP 1 QRP_POSTED_BY FROM dbo.QRP_HEADER WHERE QRP_FYCODE = @FyCode AND QRP_DOCTYPE = @DocType AND QRP_DOCNO = d.DocNo) AS posted_by,
       @@TRANCOUNT AS open_tran
FROM @Done d ORDER BY d.Seq;
-- 1b. The QRV50s as saved (what accounts will see in FACTS' QRV50 list).
SELECT q.QRP_DOCNO, q.QRP_DOCDATE, q.QRP_MODE_DOCNO, q.QRP_CR_AC_DOCNO AS party, m.ACMST_DESC, q.QRP_OTHAC_DOCNO AS others_ac, q.QRP_OTH_AMOUNT, q.QRP_AMOUNT,
       q.QRP_REFNO, q.QRP_REFDATE, q.QRP_NARRATION, q.QRP_CREATED_BY, q.QRP_POSTED_BY
FROM dbo.QRP_HEADER q JOIN @Done d ON d.DocNo = q.QRP_DOCNO LEFT JOIN dbo.ACCOUNT_MASTER m ON m.ACMST_DOCNO = q.QRP_CR_AC_DOCNO
WHERE q.QRP_FYCODE = @FyCode AND q.QRP_DOCTYPE = @DocType ORDER BY q.QRP_DOCNO;
-- 2. The ledger lines (FACTS: + = credit, - = debit). Expected per outlet: 2322 bank debited, the outlet's cash credited, nothing on 2202.
SELECT a.ACTRN_DOCNO, a.ACTRN_DOCSRNO, a.ACTRN_AC_DOCNO, m.ACMST_DESC, a.ACTRN_SUBLEDGER_DOCNO, a.ACTRN_AMOUNT, a.ACTRN_NARRATION, a.ACTRN_REF_NO, a.ACTRN_DIVN_DOCNO
FROM dbo.ACCOUNT_TRANSACTION a JOIN @Done d ON d.DocNo = a.ACTRN_DOCNO LEFT JOIN dbo.ACCOUNT_MASTER m ON m.ACMST_DOCNO = a.ACTRN_AC_DOCNO
WHERE a.ACTRN_FYCODE = @FyCode AND a.ACTRN_DOCTYPE = @DocType ORDER BY a.ACTRN_DOCNO, a.ACTRN_DOCSRNO;
-- 3. FACTS' logs: "A" saved, "R" posted.
SELECT AED_DOCNO, AED_STATUS, AED_USER_CODE FROM dbo.ADD_EDIT_DELETE_LOG l JOIN @Done d ON d.DocNo = l.AED_DOCNO
WHERE l.AED_FYCODE = @FyCode AND l.AED_DOCTYPE = @DocType ORDER BY AED_DOCNO, AED_STATUS;

IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
SELECT 'Rolled back' AS done,
       (SELECT COUNT(*) FROM dbo.QRP_HEADER WHERE QRP_FYCODE = @FyCode AND QRP_DOCTYPE = @DocType AND QRP_REFNO LIKE N'REHEARSAL%') AS qrv_left,
       (SELECT COUNT(*) FROM dbo.ACCOUNT_TRANSACTION WHERE ACTRN_FYCODE = @FyCode AND ACTRN_DOCTYPE = @DocType AND ACTRN_NARRATION LIKE N'Deposit REHEARSAL%') AS ledger_left,
       @LastBefore AS next_qrv_before, dbo.fn_GetNewDocNo(@DocType, '') AS next_qrv_now;
