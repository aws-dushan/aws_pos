# 7. Operations and support

## Is it healthy?

| Check | How |
| --- | --- |
| Web and API up | Open the address; `GET /health` on the API answers `ok` |
| Versions, containers, backups | `ssh aws-app /opt/aws/onepos/bin/onepos status`, `ssh aws-data /opt/aws/onepos/bin/onepos-db status` |
| FACTS sync | Register shows when prices and stock were last read; failures are in `erp_sync` |
| FACTS posting | Administration → FACTS posting → Posting log, filter **Failed** / **Waiting** |
| Tills and printers | Devices → This branch's PCs |
| Emails | Administration → Daily summary & alerts → Send a test |
| Problems from staff | Administration → Problem reports |


![The audit log: every sign-in and change, newest first](manual/images/audit.jpg)

![Daily summary & alerts: alert limits, email list and the email server](manual/images/alerts.jpg)

## Common support jobs

| Situation | What to do |
| --- | --- |
| Bill failed to post: item has no FACTS code | Fix the item in FACTS (or its link in One POS), then **Re-push**. If finance will enter it, **Leave out**. |
| Bill failed: no FACTS payment method for a method at a location | Add the payment method in FACTS for that location (named `<location> <method>`); it is read within the hour, then **Re-push**. |
| Item shows "No price" | The branch's FACTS price type has no price for it: finance adds it in FACTS; it arrives within 5 minutes or with **Sync prices**. |
| Wrong payment method on a posted bill | Correct the payment in One POS and re-send under the same number: FACTS revises the POS51. Only with finance's agreement. |
| Till cannot print | Devices on that PC: service running? printer chosen? spooler state? **Test print**. Reinstall from **Download the installer** if needed. |
| User locked out | Wait a few minutes (PIN: after 5 tries; password: 15 minutes), or reset the PIN / password under Users. |
| Day did not close | Day & shifts: close the shifts One POS names, then close the day. |
| Docker Desktop on the dev PC hangs | End its processes, `wsl --shutdown`, start it again. |

## Never

- Never run scripts that change settings against a company someone set up by hand; use a scratch company.
- Never print, paste or commit the contents of an `.env` file or a FACTS connection string.
- Never write to FACTS from a developer PC without the business owner's explicit go-ahead; give them the script instead.
- Never let the old POS and One POS post the same branch on the same day.
- Never reuse an invoice number: FACTS would revise the existing POS51 with it. `db/maintenance/clear_transactions.sql`
  therefore does not reset the numbering.
- Never deploy to live a release that has not been checked first.
