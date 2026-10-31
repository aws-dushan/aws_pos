# 2. Development

## Before you start

Development needs .NET 10, Node 20+ and Docker; `start-dev.ps1` starts the database, API and web app together, and the
API applies the migrations on start. Scripts and tests that change settings (FACTS connection, branch settings, roles)
must run against a scratch company, or snapshot and restore what they touch, never against a company set up by hand.

## Repository layout

| Path | What |
| --- | --- |
| `web/src/app/(app)/` | Signed-in screens, one folder per menu entry (`register`, `stock`, `reports`, `admin/…`) |
| `web/src/app/{login,till,display,pickup,r}` | Back-office sign-in, till PIN pad, customer display, order-ready TV, public receipt |
| `web/src/components/` | Shared screens and dialogs (`pos-payment.tsx`, `day-closing.tsx`, `stock-requests.tsx`…) and `ui/` (design system) |
| `web/src/lib/` | API client (`api.ts`), Device Service client (`device.ts`), receipt drawing (`receipt-draw.ts`), exports, shortcuts |
| `src/OnePos.Api/` | API, see [Architecture](01-architecture.md) |
| `src/OnePos.DeviceService/`, `src/OnePos.DeviceTray/`, `installer/` | Till software and its MSI (WiX 5) |
| `db/migrations/` | Database migrations, applied once each in name order |
| `db/facts/` | One POS' procedures for FACTS, `tests/` rehearsals, `fixes/` one-off corrections |
| `db/maintenance/` | Hand-run scripts (clear transactions, remove tills); read them before running |
| `deploy/` | Release and server scripts, see [Servers and releases](06-servers-and-releases.md) |
| `tools/` | Logo builder, Device Service release script, FACTS procedure installer, docs builder |

## Rules the code follows

- **Money and quantities** are `decimal` / `numeric(14,2)`, rounded half away from zero with `Money.Round`. `Math.Round`,
  `double` and `float` for money are banned by `BannedSymbols.txt` and fail the build.
- **Dates** come from the branch's business day (`Platform/BusinessClock`), never `DateTime.Today` or `DateTime.Now` (banned).
- **One transaction per unit of work** through `Db.Company(companyId, …)`; live events are sent after the commit.
- **Every write that a till may retry** carries an `Idempotency-Key` header (the web API client adds it).
- **Permissions** are checked in the endpoint with `scope.Require("<key>")`; a new right is added to `Permissions.All`
  and, where it fits, to the preset roles.
- **Errors for users** are thrown as `DomainException("plain sentence")`; the web shows the message as is, so write it
  for a cashier.
- **Screens** start from the user's task, one obvious primary button, everyday words (e.g. "New combo", "Change BOM"),
  and must work on a 1024×768 till.
- **Optional features** get an on/off setting (company or branch), usually off by default.
- **Every page follows the header branch**; add an "All my branches" switch only where comparing helps.
- **The receipt** is drawn twice and must stay in step: `web/src/lib/receipt-draw.ts` (screen and browser print) and
  `src/OnePos.DeviceService/ReceiptRenderer.cs` (printer).

## Adding a database change

1. Create `db/migrations/NNNN_short_name.sql` with the next number. Start it with a comment saying what and why.
2. New company-owned tables get `company_id`, row-level security and a policy, like the existing ones (see 0001), and
   grants to `onepos_app`.
3. Use `CREATE OR REPLACE` / `IF NOT EXISTS` where a rerun could happen; each file runs in its own transaction.
4. Start the API: it applies the file, or stops with the file name and the error.
5. Never edit a migration that has been released; add a new one.

## Adding a screen

1. Add the folder under `web/src/app/(app)/<name>/page.tsx`.
2. Add it to `SCREENS` in `web/src/components/modules.tsx` with its label, group, hint and permission (`perm`), plus
   `tableOnly`, `kitchenOnly`, `factsOnly` or `rewardsOnly` where it applies.
3. Build its API in `src/OnePos.Api/Pos/<Area>.cs` and map it in `Program.cs`.

## Checks before a release

```powershell
dotnet build OnePos.slnx -c Release     # banned symbols and warnings fail here
cd web; npm run lint; npm run build
```

Then follow [Servers and releases](06-servers-and-releases.md).
