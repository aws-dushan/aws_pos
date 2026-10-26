# One POS by AWS Distribution

Restaurant point of sale for the group's companies and branches. Same stack, design system and motion kit as AWS One.
Requirements and development plan: the "One POS by AWS Distribution — Requirements & Development Plan" doc.

## Run locally

```powershell
./start-dev.ps1
```

- Database: Docker Postgres on port 5434 (`docker compose up -d db`)
- API: http://localhost:5090 (.NET 10; applies `db/migrations` on start)
- Web: http://localhost:3100 (Next.js; proxies `/api` and `/hubs` to the API)
- First sign-in on an empty database: `admin` / `admin123`

## Layout

| Path | What |
| --- | --- |
| `web/` | Next.js app (all screens). `src/app/(app)` = signed-in screens, `login/` back office, `till/` PIN pad |
| `web/src/prototype/` | Pre-server prototype of register, floor and payment (reference for phases 1–2; not shipped, not linted) |
| `src/OnePos.Api/` | ASP.NET Core API: `Platform/` (auth, companies, branches, users, roles, audit, idempotency, live hub) |
| `db/migrations/` | SQL migrations, applied once each in name order |
| `tools/brand/` | Logo builder (`build_pos_logo.py`, from AWS One's `build_logo.py`) |

## Phase 0 (foundations) — done

- Companies (ERP: none / AWS One / FACTS, VAT, currency) and branches (table service on/off, service charge, day control)
- Users with back-office password and till PIN (HMAC, unique per company, lockout); roles with permissions and limits,
  incl. dashboard visibility (register sales / branch sales)
- Row-level security per company; audit log; idempotent writes (`Idempotency-Key`); live updates (SignalR `/hubs/live`)
- Web: sign-in, touch PIN pad, Company › Branch switcher, reconnecting banner, admin screens, AWS One theme and animations

## Phase 1 (register and devices) — done

- Menu: categories, items (photo, Arabic name, station), option groups with required/optional choices and prices; per-branch
  availability, branch price, "sold out today"
- Touch register: takeaway / delivery / dine-in (table name until the floor plan in phase 2), options, notes, discounts within role
  limits, send, void, park; totals with VAT per line, service charge on dine-in
- Payments: cash with change, card, other, voucher, customer account; split / part payments; refunds within role limits
- Receipts: tax invoice on screen and on the receipt printer; reprint from Orders
- Dashboard: register sales (on a till) and branch sales, per role; live
- Registers (tills) per branch; a browser is set up as a till for one register
- Device Service (`src/OnePos.DeviceService`, Windows service on 127.0.0.1:5199): receipt printer via the Windows driver (raw
  ESC/POS raster, Arabic OK), cash drawer, pole display; install with `tools/install-device-service.ps1`
- Customer display (`/display`) on the till's second screen, fed live by the register

Run the device service locally for testing: `dotnet run --project src/OnePos.DeviceService`. A printer named `file:C:\path\out.bin`
writes the printer's bytes to a file instead of printing.

## Phase 2 (restaurant operations) — in progress

Done:
- Combos / set menus: option groups whose choices must all be menu items (with an ERP item code where the company posts to
  FACTS); each component keeps its own kitchen station. A combo has no ERP code and no price of its own: each choice carries its
  price in the combo (it starts at the item's menu price). FACTS gets a line per chosen item (its own code) at that price, the
  discount and VAT shared by amount; credit notes and repacking per bill do the same
- Floors and tables (`/tables` designer: drag on a snap grid, round / square / long, seats); live floor (`/floor`): free, seated,
  bill printed, reserved, minutes seated, running total
- Seat a table with guests; move, join tables, merge two orders, split bill by item (separate bill or another table)
- One device edits an order at a time ("Open on Till 1 · Sara", take over); table service can't be switched off with dine-in orders open

- Kitchen: stations (kitchen / bar) with optional printers, tickets per station, kitchen display, cancel tickets. A per-branch
  **Kitchen** switch: off for a café or counter (no Send, no tickets, no kitchen display)
- Returns and refunds as UAE tax credit notes (item returns with restock / wastage, amount refunds, return window, limits)
- Business day and shifts (`/day`): day open / close per the branch's day control (Manual, Automatic on a schedule, Cashier-run),
  shift float counted by denomination, cash in / out / safe drops, X report, blind closing count, variance within tolerance or
  manager approval, day Z report, bank deposits, reopen the last day. A till takes payments only with an open shift.

- Approvals (`/approvals`): a discount, refund (over the limit, outside the return window, or without the refund right) or cash out
  above the cashier's limit asks for a manager: PIN on the same till, or a request approved remotely (live, bell in the header).
  The approval covers that one action, once, within 15 minutes; everything is audited.
- ERP connection per company (Companies & branches → **FACTS connection**, administrators): the SQL Server connection string is
  tested, stored encrypted (Data Protection, keys DPAPI-protected on Windows) and never shown again; a warning if the login can write.

- Paper fallback (`/paper`, managers): numbered blank order pads to print ahead of time (`/paper/pad`, four per A4); after
  an outage each slip is keyed in and becomes a paid order of the open day with a tax invoice number (slip number kept, entered
  once only, nothing sent to the kitchen).

Phase 2 is complete.

## Phase 4 (customers, reports) — in progress

- Customers (`/customers`): optional on every order. The register finds a regular by phone (any format: +971 5…, 05…) or name
  and attaches them (visits, spend, favourite, notes such as allergies); a paid order with a new phone and a name creates one.
  A delivery needs a phone and an address before it's paid; nothing else asks for a customer.
- Reports (`/reports`, reports.view): a range of business days for this branch or all of mine. Net sales, net of VAT,
  refunds, discounts, by day or hour, by order type, and tables by item, category, day, payment method, cashier and branch,
  each exportable to CSV. Item sales are each line's share of what its order was paid less that item's credit notes; refunds
  of an amount show on their own line so the items add up to net sales.

- Reservations (`/reservations`, table-service branches): bookings by day with name, phone (a known customer is recognised),
  guests, time, duration and the tables to hold; a table can't be booked twice for overlapping times. The floor shows a
  table's booking in the two hours before; "Seat booking" opens the dine-in order on its tables with the customer. Cancel,
  no-show and restore; an empty seated order that's thrown away puts the booking back to booked.
- Order numbers are given when the first item is added, so an order started and left empty uses no number.
- Stock (`/stock`): wastage by reason (expired, damaged, quality, customer return, staff meal, other) in the business day,
  in the day's Z report, taken off by its recorder the same day or a manager; for an ERP branch it waits as "to post" (to the
  outlet's wastage location, once posting is switched on). Deliveries: stock-moving transfers into the branch's FACTS
  location (e.g. STV50 from the Al Khabaisi main store), read from FACTS, checked in with any differences noted; the
  branch's own transfer requests (STR50) are listed apart.
- Gift vouchers and loyalty points, each off until an administrator switches it on for the company (Companies & branches).
  Vouchers have a code (no look-alike characters), pay all or part of a bill at any branch, can expire, and a refund can be
  given as a new voucher (store credit, its code on the credit note). Loyalty: a customer on a paid order earns points at the
  company's rate on what wasn't paid with points; points pay a bill from a minimum; a refund takes back what its share earned
  or is given back as points. `/vouchers`: issue (goodwill, promotion, sold), print, cancel, history; open vouchers and points
  outstanding with their value.
- Recipes and ingredient stock (`/ingredients`): ingredients with a unit (kg, g, l, ml, pcs), cost per unit and a low-stock
  level; a recipe on each menu item (Menu → item → Recipe) and on modifier options (e.g. extra cheese), with the cost of one
  against the price. A combo choice uses its item's recipe. A paid order (and a keyed-in paper slip) takes its recipes off the
  branch's stock; items returned "back to stock" put them back; wasted menu items take them off (and back if the wastage is
  taken off). Receive deliveries (a new cost per unit becomes the ingredient's cost), record ingredient waste with a reason,
  count the shelves (managers; the difference is kept as the count's variance). Food cost per item, and usage over days: cost
  of what sold by the recipes, food cost % of the sales of items with a recipe, waste and count differences.
- When a recipe's ingredients run short, per branch (Companies & branches → branch): Allow (sell; stock can go below zero),
  Warn (the register marks the item "Ingredients low" and warns when it's added) or Block (the item shows "Out of
  ingredients" and an order can't take more than the branch has of the added item's ingredients; lowering a quantity is
  always allowed).
- Delivery platforms (set up under Administration → Delivery platforms; Back office has only the Delivery platform
  report, `/platforms`): the company's list (Talabat, Deliveroo, Careem, Noon Food, Keeta, Smiles…) with each
  one's commission. At the register a delivery is "Own delivery" or a platform's, with the platform's order number (needed;
  no phone or address, the platform delivers). The kitchen ticket reads "Talabat #TB-48213". The platform pays (method
  "Platform": what it owes the outlet); a refund can go back through the platform. Per platform over business days, this
  branch or all: orders, sales, refunds, commission at each order's rate, what it owes and the expected payout. Entered by
  hand from the platform's tablet; live links to the platforms' APIs need partner access from each platform.
  Payouts, a company setting (Administration → Delivery platforms, off by default: reconciled elsewhere, e.g. the ERP). On:
  managers record each payout (platform, date received, amount, commission kept, statement reference, optional period),
  take one off if it was wrong; the report adds received in the days chosen and what each platform still owes (all
  branches, to date: owed less payouts and the commission kept). The dashboard splits delivery into own and each platform.
- Order-ready screen (`/pickup`, opened from Devices on the PC driving a TV): takeaway and delivery order numbers Preparing
  and Ready to collect (large, a chime and a highlight as each turns ready; English and Arabic headings). Per branch
  (Companies & branches): Off; Automatic, no taps (with a kitchen: ready when the kitchen finishes; without one: ready as
  soon as it's paid); or Cashier taps ready (the waiting numbers sit in a strip on the register, one tap each, with undo).
  Nobody marks orders collected: ready numbers leave by themselves after the branch's minutes (default 10).

- No sale (Register, pos.nosale): opens the cash drawer without a sale, with a reason; recorded with who, till and shift,
  counted on the day's Z report.
- Exceptions report (Reports → Exceptions): discounts, voided orders, voided items, refunds and no-sales over the days chosen,
  with who did each (and who approved). Every report table exports to Excel (.xlsx), CSV, or PDF (a print-ready page).
- Register: the order's details (customer, table, platform, address) fold to one line once nothing needed is missing. Each
  item is one slim row (quantity, name, options and note, price); tapping it opens its controls (− / qty / +, note,
  remove), all 44 px touch targets. Discount sits behind a chip; Send, Bill and Pay share one row. A 1366×768 till shows
  about seven items at once.

- Digital receipt (Receipt & display → "QR code to the digital receipt", per branch, off by default): paid receipts print a
  QR code; it opens the receipt on the customer's phone (`/r/<token>`, no sign-in; a long random token per order; payment
  references and kitchen tickets left out), to keep, print or save as PDF.

- Device status (Devices → "This branch's PCs", branch.manage): every PC running One POS reports each minute — online or
  last seen, who's signed in, its Device Service version (or none), receipt printer and its state from the Windows spooler
  (ready, paper out, offline, error…), last print and last error. A PC with the Device Service is listed by its name.

- Daily summary and alerts (always on; limits and the email list under Administration → Daily summary & alerts): when a branch closes
  its day, a summary (net sales against the same day last week, orders and average, cash variance, discounts, refunds,
  voids, no-sales, wastage, best sellers) and alerts over the company's limits (voids, refunds, no-sales, discount %, cash
  variance beyond the branch's tolerance, shifts not counted; many shifts fold into one line). Under the newspaper icon for
  people with reports for that branch; emailed to a list where the company's email server (SMTP, administrators, password
  protected) is set up, sent in the background each minute.

- Device Service installer and self-update (REQ HW-01): an MSI (`tools/release-device-service.ps1 -Version x.y.z -WebOrigin
  https://<One POS address>`, WiX 5; the address is built in, so on a till a double-click is enough)
  installs the service (automatic start, restarts if it stops) and the One POS tray icon (starts with Windows: running or not,
  printer state, test print, check for updates). Each till's service learns its One POS server from the web app (only that
  address, from that address), checks every 6 hours and installs a newer release quietly after checking its SHA-256;
  per-PC switch and "Check for updates" / "Update now" under Devices. Devices offers "Download the installer" on a PC
  without the service. The installer isn't code-signed yet (Windows SmartScreen warns until it is).

Later, when needed (not built now): the full Arabic right-to-left interface, an own online ordering page per branch, and
offline mode.

## Phase 6 (Arabic, branding) — in progress

- Bilingual receipts and credit notes (per branch: English and Arabic, or English only): the company's Arabic legal name,
  the branch's Arabic name and address, "فاتورة ضريبية", Arabic labels on totals, payments and change, and each item's Arabic
  name under its English one (kept on the sale line, so reprints match). The screen draws the same lines as the printer.
- Company logo (Receipt & display screen): printed at the top of receipts and credit notes (converted to black and white for
  thermal paper), on the on-screen receipt, and on the customer display's welcome screen.
- Receipt header settings per branch with a live preview: logo, company name, address, phone, TRN on bills (tax invoices
  and credit notes always show it), email, website, table, customer, till and cashier; extra header lines and footer.
- Customer display pictures: shown full screen between orders in turn (seconds each, optional from/until dates, every branch
  or one branch, hidden or shown, ordered).

## Phase 3 (ERP) — in progress

- FACTS item sync (reads only): the company's item type and division (European Bakery: FG, division 50) into the menu,
  sub-category as category, unit and its decimals from FACTS. New items arrive switched off ("new from FACTS"); gone or
  sale-blocked items switch off. Prices are not taken from FACTS yet: an item without a price can't be sold. Hourly, or
  "Sync items" on the Menu screen.
- Stock per branch from its FACTS location (STOCK_LOCATION_MASTER), every 5 minutes; shown on the register and Menu.
- "Switch on what sold here": items the branch's FACTS location sold (POS documents) in the last 14 days.
- Decimal quantities: half a cake, weights (the till asks for the amount of KG / LTR items), up to the unit's decimals.

- FACTS posting (Administration → FACTS posting): each paid bill (and keyed-in paper slip) goes to FACTS the way the outlet
  POS (Polaris) posts: the same XML to `usp_FQAPI_PWA_POS_SaveInvoice`, which makes a POS51 document numbered with our invoice
  number (sending it again revises it, never doubles). A bill is queued when paid at a branch with a "posts from" date (the
  day Polaris stops there); the sender sends the queue only while an administrator has posting switched on (off by default),
  retries with growing waits, and shows failures (e.g. an item without a FACTS code) in the posting log with retry / leave
  out. Dry run: a day's bills as they'd go, nothing sent. Card payments carry the FACTS card type the cashier picks (VISA,
  MASTER, MAESTRO, Diners… read from FACTS' payment methods per location, with cash and the delivery platforms; read
  by themselves every hour and as soon as a branch's FACTS location is set). Refunds: a
  setting, not posted (finance enters them) or SR50 credit notes through a FACTS procedure from the FACTS developer (they
  wait until it's set). Wastage isn't posted: finance posts it in FACTS (to the outlet's W location, FIFO batch) and notes
  the FACTS document on the Stock screen.

To decide with the business: outlet prices and promotions (FACTS RP covers few outlet items; CPL50 is a wholesale list),
posting sales (POS51) and returns (SR50 / STV50) to FACTS, and the switch-over from the current outlet POS.
