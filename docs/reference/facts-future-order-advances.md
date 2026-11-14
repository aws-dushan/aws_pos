# FACTS changes for future-order advances

**For:** the FACTS developer · **From:** One POS (European Bakery outlets) · **Database:** FactsERPAWSEB

## What One POS does

A customer orders now for a later day (for example, a cake for Saturday) and pays an advance. On the collection day they pay the balance and take the order. Example: advance 50 by card, bill 100.

| When | FACTS document | Entry (net) |
|---|---|---|
| Order day: advance 50 by card | **QRV51**, posted | Dr **2315** POS credit card 50 / Cr **2802** POS customer advances 50 |
| Order day: advance in cash | **QRV51**, posted | Dr the outlet's cash account (e.g. **2205**) / Cr **2802** |
| Collection day: bill 100 | **POS51**, as today, paid by **ADVANCE 50** + **card 50** | ADVANCE line: Dr **2802** 50 / Cr AR C0006 50. Card line: Dr 2315 50 / Cr AR C0006 50. Sale: Dr AR C0006 100 / Cr sales 95.24 + VAT 4.76 |
| Bill returned | **PSR51** (copy of the POS51) | The advance back on 2802, the balance back to the card or cash |

Result over the whole order:

| Account | End |
|---|---|
| 2802 POS customer advances | 0 (credit while the order waits) |
| AR C0006 cash customer POS | 0 |
| 2315 card / cash account | Dr 100 (advance and balance, each on its own day) |
| Sales + VAT | Cr 100 |

- 2802 always shows the advances held for orders not yet collected.
- An advance given back on a cancelled order is not posted by One POS: finance books it.
- QRV51 **1001** (14 Nov, Dr 2802 / Cr AR C0006) is entered the other way round. Please reverse or delete it, together with test bills POS51 0001 and 0002 (30–31 Oct).

One POS writes and sends:
- `usp_ONEPOS_PostAdvance`: one QRV51 per advance.
- `usp_ONEPOS_SaveInvoice`, which already posts bills, links each bill to its advances:
  - On the POS51, `SAL_REFNO2` = "FO-… advances QRV51 …".
  - On each QRV51, `QRP_BEFORE_DOCTYPE` / `QRP_BEFORE_DOCNO` = the POS51.

## 1. Fix the sign of payment method ADVANCE

`usp_SAL_APPR_ReceiptAccountsUpdation` books each receipt line as `RD_AMOUNT * PM_SIGN`. ADVANCE is the only payment method whose sign is the opposite of all the others:

| PAYMENT_METHOD | PM_DOC_DOCTYPE | Now | Should be (as all 89 others) |
|---|---|---|---|
| ADVANCE (account 2802) | POS51 | −1 | **+1** |
| ADVANCE (account 2802) | PSR51 | +1 | **−1** |

With −1 a bill paid by ADVANCE **credits** 2802 and **debits** C0006: it books a new advance instead of using one. With +1 it debits 2802, as in the table above.

```sql
UPDATE dbo.PAYMENT_METHOD SET PM_SIGN =  1 WHERE PM_DOCNO = N'ADVANCE' AND PM_DOC_DOCTYPE = N'POS51';
UPDATE dbo.PAYMENT_METHOD SET PM_SIGN = -1 WHERE PM_DOCNO = N'ADVANCE' AND PM_DOC_DOCTYPE = N'PSR51';
```

## 2. Let QRV51 credit 2802 (one of these)

FACTS' QRV posting makes two lines: the receiving account debited and the party credited. The advance needs the card or cash account debited and 2802 credited.

| | How | What the QRV51 shows |
|---|---|---|
| **a** | Change the QRV51 posting: party stays AR / C0006, and the posting adds Dr C0006 / Cr 2802 | Four lines: Dr 2315, Cr C0006, Dr C0006, Cr 2802 |
| **b** | Add a sub-ledger under 2802 (e.g. C0006); the QRV51 is saved with party 2802 / sub-ledger and the card or cash account as the "Others" account | Two lines: Dr 2315, Cr 2802 |

Both give the same balances. Please tell us which one, so One POS saves the QRV51 to match.

Please also check QRV51's posting step. Its "Transaction Posting" row in DOCUMENT_PROCEDURES has DMP_POSTING_ENTRY = 0, where QRV50's has 1.

## For finance to confirm

- **VAT:** in UAE VAT, tax on an advance is due when the advance is received. In this design, VAT is booked on the POS51 at collection. If VAT must be booked on the advance itself, the QRV51 needs a VAT line and the POS51 a matching reduction.
