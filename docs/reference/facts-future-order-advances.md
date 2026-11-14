# FACTS changes for future-order advances

**For:** the FACTS developer · **From:** One POS (European Bakery outlets) · **Database:** FactsERPAWSEB

## What One POS does

A customer orders now for a later day (for example, a cake for Saturday) and pays an advance. On the collection day they pay the balance and take the order.

| When | FACTS document | Entry |
|---|---|---|
| Order day: advance 200 by Visa | **QRV51**, posted | Dr 2315 (Visa ledger) 200 / Cr **2802 POS CUSTOMER ADVANCES** 200 |
| Collection day: bill 500 | **POS51**, as today, paid by **ADVANCE 200** + **ERBQS VISA CARD 300** | ADVANCE line: Dr 2802 200 / Cr AR C0006 200. Visa line: Dr 2315 300 / Cr AR C0006 300 |
| Paid in full upfront | QRV51 for 500, then the POS51 paid by **ADVANCE 500** | 2802 comes back to zero |

- The balance of 2802 is always the total of advances for orders not yet collected.
- C0006 nets to zero on every bill, as it does today.
- When an order is cancelled and the advance given back, One POS does not post anything: finance books the refund by hand.

The procedures that post this are written by One POS:
- `usp_ONEPOS_PostAdvance` makes the QRV51.
- `usp_ONEPOS_SaveInvoice`, which already posts bills, links each bill to its advances:
  - On the POS51, `SAL_REFNO2` = "FO-… advances QRV51 …".
  - On each QRV51, `QRP_BEFORE_DOCTYPE` / `QRP_BEFORE_DOCNO` = the POS51.

They need only the two setup changes below.

## 1. Fix the sign of payment method ADVANCE

`usp_SAL_APPR_ReceiptAccountsUpdation` books each receipt line as `RD_AMOUNT * PM_SIGN`. ADVANCE is the only payment method whose sign is the opposite of all the others:

| PAYMENT_METHOD | PM_DOC_DOCTYPE | Now | Should be (as all 89 others) |
|---|---|---|---|
| ADVANCE (account 2802) | POS51 | −1 | **+1** |
| ADVANCE (account 2802) | PSR51 | +1 | **−1** |

With −1, a POS51 paid by ADVANCE **credits** 2802 and **debits** C0006: it books a new advance instead of using one. Test bills POS51 **0001** (30 Oct) and **0002** (31 Oct) show this, and they left 10.25 on C0006 and on 2802. Please also delete or reverse those two bills.

```sql
UPDATE dbo.PAYMENT_METHOD SET PM_SIGN =  1 WHERE PM_DOCNO = N'ADVANCE' AND PM_DOC_DOCTYPE = N'POS51';
UPDATE dbo.PAYMENT_METHOD SET PM_SIGN = -1 WHERE PM_DOCNO = N'ADVANCE' AND PM_DOC_DOCTYPE = N'PSR51';
```

## 2. Let QRV51 post to 2802

QRV posting (`usp_QRV_APPR_AccountsUpdation`) needs the party (account + sub-ledger) to exist in SUBLEDGER_MASTER. Account 2802 has no sub-ledger today, so a QRV51 crediting 2802 is refused at posting ("Party Account Not Specified").

Please add a sub-ledger under **2802**, preferably **C0006** (the POS cash customer): SUBLMST_DOCTYPE = '2802', SUBLMST_DOCNO = 'C0006'. If you use another code, `usp_ONEPOS_PostAdvance` takes the first sub-ledger of 2802.

Please also check QRV51's posting step. Its "Transaction Posting" row in DOCUMENT_PROCEDURES has DMP_POSTING_ENTRY = 0, where QRV50's has 1.

## For finance to confirm

- **VAT:** in UAE VAT, tax on an advance is due when the advance is received. In this design, VAT is booked on the POS51 at collection. If VAT must be booked on the advance itself, the QRV51 needs a VAT line and the POS51 a matching reduction.
- **Ledger:** 2802 POS CUSTOMER ADVANCES is the advances account.
