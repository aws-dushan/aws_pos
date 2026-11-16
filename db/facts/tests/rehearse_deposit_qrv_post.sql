-- One POS: does a bank deposit QRV50 POST with the outlet cash account as party and NO sub-ledger? Rehearsal, everything rolled back.
-- FACTS' usp_QRV_APPR_AccountsUpdation asks for a party sub-ledger only when the party account has ACMST_SUBLEDGER_EXISTS = 1;
-- the outlet cash accounts (2204, 2205, 2211, 2213, 2214) have 0. Expected: Dr 2322 (Others), Cr 2205 (party), nothing on 2202.
DECLARE @User NVARCHAR(20) = N'POSBAKERY', @Cash NVARCHAR(20) = N'2205', @Bank NVARCHAR(20) = N'2322', @Amount NUMERIC(18,3) = 120.000,
        @Slip NVARCHAR(50) = N'REHEARSAL-POST', @Date DATETIME = '2026-11-15', @Narr NVARCHAR(200) = N'Deposit REHEARSAL-POST Al Qusais 15/11/2026 taken by Imesh';
DECLARE @FyCode NVARCHAR(6) = N'CFY', @DocType NVARCHAR(10) = N'QRV50', @DocNo NVARCHAR(20), @Key NVARCHAR(100) = N'usp_QRV_APPR_AccountsUpdation',
        @Divn NVARCHAR(20), @NextBefore NVARCHAR(40), @Err NVARCHAR(400) = NULL, @Docs NVARCHAR(MAX);
SELECT @Divn = DM_DIVN_DOCNO FROM dbo.DOCUMENT_MASTER WHERE DM_DOCNO = @DocType;
SET @NextBefore = dbo.fn_GetNewDocNo(@DocType, '');

SET XACT_ABORT OFF;
BEGIN TRANSACTION;
BEGIN TRY
    EXEC dbo.usp_UpdateLastNoMaster_From_Transaction_Table @DocType, NULL;
    SET @DocNo = dbo.fn_GetNewDocNo(@DocType, '');
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
    EXEC dbo.usp_ApproveDocuments @strFyCode = @FyCode, @strDocType = @DocType, @strXmlDocDetails = @Docs, @strLoginID = @User, @strKey = @Key, @strMachineId = N'One POS';
END TRY
BEGIN CATCH
    SET @Err = LEFT(ERROR_MESSAGE(), 400);
END CATCH

SELECT @DocNo AS QRV50_no, @Err AS error, @@TRANCOUNT AS open_tran,
       (SELECT COUNT(*) FROM dbo.ACTION_STATUS WHERE ACTION_FYCODE = @FyCode AND ACTION_DOCTYPE = @DocType AND ACTION_DOCNO = @DocNo AND ACTION_KEY = @Key) AS posted;
IF @@TRANCOUNT > 0
    SELECT a.ACTRN_DOCSRNO, a.ACTRN_AC_DOCNO, LEFT(m.ACMST_DESC, 35) AS account, a.ACTRN_SUBLEDGER_DOCNO, a.ACTRN_AMOUNT, a.ACTRN_NARRATION, a.ACTRN_REF_NO, a.ACTRN_DIVN_DOCNO
    FROM dbo.ACCOUNT_TRANSACTION a LEFT JOIN dbo.ACCOUNT_MASTER m ON m.ACMST_DOCNO = a.ACTRN_AC_DOCNO
    WHERE a.ACTRN_FYCODE = @FyCode AND a.ACTRN_DOCTYPE = @DocType AND a.ACTRN_DOCNO = @DocNo ORDER BY a.ACTRN_DOCSRNO;

IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
SELECT 'Rolled back' AS done,
       (SELECT COUNT(*) FROM dbo.QRP_HEADER WHERE QRP_FYCODE = @FyCode AND QRP_DOCTYPE = @DocType AND QRP_REFNO = @Slip) AS qrv_left,
       @NextBefore AS next_qrv_before, dbo.fn_GetNewDocNo(@DocType, '') AS next_qrv_now;
