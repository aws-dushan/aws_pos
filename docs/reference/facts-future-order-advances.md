# FACTS changes for future-order advances

**For:** the FACTS developer · **From:** One POS (European Bakery outlets) · **Database:** FactsERPAWSEB

## What One POS does

A customer orders now for a later day (for example, a cake for Saturday) and pays an advance. On the collection day they pay the balance and take the order. Example: advance 50 by card, bill 100.

| When | FACTS document | Entry (net) |
|---|---|---|
| Order day: advance 50 by card | **QRV51**, posted, party AR / C0006, Others account 2315 | Dr **2315** POS credit card 50 / Cr C0006 50, then Dr C0006 50 / Cr **2802** POS customer advances 50. Net: Dr 2315 / Cr 2802 |
| Order day: advance in cash | **QRV51**, posted, Others account = the outlet's cash account (e.g. **2205**) | Net: Dr 2205 / Cr **2802** |
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
- Test bill POS51 **0001** (30 Oct) was posted with the old ADVANCE sign: it leaves 5.00 credit on 2802 and 10.00 debit on AR C0006. Please reverse it.

One POS writes and sends:
- `usp_ONEPOS_PostAdvance`: one QRV51 per advance.
- `usp_ONEPOS_SaveInvoice`, which already posts bills, links each bill to its advances:
  - On the POS51, `SAL_REFNO2` = "FO-… advances QRV51 …".
  - On each QRV51, `QRP_BEFORE_DOCTYPE` / `QRP_BEFORE_DOCNO` = the POS51.

## What FACTS has now

| Setting | State |
|---|---|
| PAYMENT_METHOD ADVANCE, POS51 | Sign **+1**: a bill paid by ADVANCE debits 2802 (checked on POS51 0002) |
| QRV51 posting (`usp_QRV_APPR_AccountsUpdation`) | For QRV51 it adds Dr party / Cr the QRV51 default account (DOCUMENT_MASTER QRV51 → **2802**); the 2802 line is made from the **Others** amount, so an advance is saved in Others mode (checked on QRV51 1001) |
| DOCUMENT_PROCEDURES, QRV51 posting step | DMP_POSTING_ENTRY = 1, as QRV50 |

## Still needed

**PAYMENT_METHOD ADVANCE, PSR51: sign −1.** It is +1, where all 89 other payment methods are −1 on PSR51. With +1, returning a bill paid by ADVANCE takes the advance off 2802 a second time instead of putting it back.

```sql
UPDATE dbo.PAYMENT_METHOD SET PM_SIGN = -1 WHERE PM_DOCNO = N'ADVANCE' AND PM_DOC_DOCTYPE = N'PSR51';
```

## For finance to confirm

- **VAT:** in UAE VAT, tax on an advance is due when the advance is received. In this design, VAT is booked on the POS51 at collection. If VAT must be booked on the advance itself, the QRV51 needs a VAT line and the POS51 a matching reduction.
