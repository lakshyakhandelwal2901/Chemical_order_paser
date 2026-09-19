# Order Parser Backend

Extracts `item name / quantity / price` (plus vendor, order no., date, issuing authority)
from purchase orders, supply orders, indents, rate contracts, quotations, and spreadsheet-style
order sheets — PDF, image, DOCX, XLSX, CSV, or TXT — into one consistent JSON/CSV shape.

## How parsing decides local vs. AI

For every **PDF**, **DOCX**, **XLSX**, **CSV**, or **TXT** file, it tries a local parse first, for free, with no API call:

1. Check if the PDF has a real text layer (`pdfTextExtract.js`). Many government
   documents are actually scans/photocopies saved as PDF — those have **zero**
   extractable text, so this check alone routes them straight to AI.
2. If there's text, reconstruct the document as rows and columns by text position
   (`tableParser.js`): find the item table's header row, work out column boundaries
   from where each header label sits on the page, then read each row — including
   item names that wrap onto a second line, which is very common in these tables.
3. Score the result's confidence. Only if it's **high** (most rows have both a
   item name and a number) does the local parse get used as-is.
4. Best-effort regex pulls vendor name / PO number / PO date / issuing authority
   from the text above the table (`headerMetadata.js`). This is looser than the
   table parser — if it can't find a field, that field is just `null`, and it
   doesn't block using the locally-parsed items.

Any PDF that fails step 1 or doesn't clear the confidence bar in step 3, and
every **image** (no text layer to parse), falls back to Azure Document Intelligence. DOCX files
with only embedded images also use the OCR path after the text extractor finds
no table. The OCR response is requested with table overlay data, then routed
back into the same table parser so the result still becomes structured order
data.

Every parse result carries a `source` field (`"local_pdf_parse"` or
`"azure_document_intelligence"`) so you can see which path handled each document — useful for
tracking how much of your volume is being resolved for free.

**Tested against real documents:** of 3 sample PDFs from a working set, 1 was
a genuinely digital PO — parsed locally, all 9 line items + vendor/PO#/date
extracted correctly with zero API calls. The other 2 were scans with no text
layer at all and were routed through Azure Document Intelligence.

## Setup

```bash
npm install
cp .env.example .env
# edit .env and set your Azure Document Intelligence endpoint and key for scans/images
npm run seed   # creates demo users in data/app.db (see "Authentication" below)
npm start
```

Server runs on `http://localhost:3001` by default.

## Authentication & database (Phase 1 foundation)

Requests, products, rate contracts, stock, and users now persist in a local
SQLite file at `data/app.db` (created automatically on first run from
`schema.sql` — see `db.js`). Login is real: `POST /api/auth/login` checks a
bcrypt password hash and issues an httpOnly session cookie, `/api/auth/me`
returns the signed-in user, `/api/auth/logout` clears the session.

**If you already have a `data/app.db` from before this section existed:**
`db.js` now runs a small column-migration step right after `schema.sql`,
because `CREATE TABLE IF NOT EXISTS` only creates a table the *first* time —
it never adds a column to a table that already exists on disk. Every column
added to an existing table since this schema first shipped is listed in
`db.js`'s `COLUMN_MIGRATIONS` array and gets added automatically (via
`ALTER TABLE ... ADD COLUMN`, checked against `PRAGMA table_info` first, so
it's safe to run on every startup) — no need to delete your database or lose
existing data. Verified against a simulated pre-migration database with real
rows in it: all missing columns were added, every existing row was untouched,
and a real request submission against the migrated schema worked end to end.
**Going forward:** any future column added to an *existing* table needs an
entry in that array too, or anyone running an older checkout hits the same
"table X has no column named Y" error on their next `npm start`. New tables
and new indexes don't need an entry — `CREATE TABLE/INDEX IF NOT EXISTS`
already handles those correctly regardless of when they were added.

`npm run seed` (`seedUsers.js`) creates one demo user per role if they don't
already exist:

| username | password    | role        |
|----------|-------------|-------------|
| rohit    | sales123    | SALESPERSON |
| priya    | manage123   | MANAGEMENT  |
| admin    | admin123    | ADMIN       |

**Change or replace these before this runs anywhere but your own machine** —
there's no user-management UI yet, so for now new users are added by editing
`seedUsers.js` or inserting into the `users` table directly.

`npm test` (`auth.test.js`) is a small assert-based smoke test for the
password-hashing and session lifecycle (create → validate → expire →
destroy) against a throwaway database file — run it after touching
`auth.js` or `db.js`.

**Not yet wired up:** the existing parse/quotation/inventory endpoints below
are still open, unauthenticated routes — `requireAuth`/`requireRole` from
`auth.js` aren't applied to them yet. That's deliberate: those endpoints will
move behind the new Sales/Management portals as those get built (see the
frontend's `/sales`, `/management`, and `/legacy-demo` routes), rather than
gating the old single-user flow first and then throwing that gating away.

## Sales request intake (Phase 2)

`POST /api/requests` (`SALESPERSON`/`ADMIN` only) — the real endpoint behind
the frontend's `/sales` form. Multipart form data: `file`, `party_name`,
`request_type` (`ORDER` | `RATE_CONTRACT` | `QUOTATION`), `delivery_date`
(optional, defaults to today + 7 days).

What it does, in order: validates the fields, writes the uploaded file to
`uploads/`, creates the `requests` row (`file_number` is just `10000 + id`,
no separate counter table), runs the existing parse pipeline from
`extract.js` against the file, and writes whatever line items it finds into
`request_products`. Status goes `PROCESSING` → `READY_FOR_REVIEW` once
parsing succeeds. The salesperson only ever gets back `{ file_number,
party_name, request_type, delivery_date }` in the response — never the
extracted items, prices, or stock, per the plan.

**Deliberately not done here (later phases):**
- `product_id`, brand, code, sku, `rc_price`, `mrp`, `purchase_price`, `stock`, and
  `short_by` on `request_products` all stay `NULL` — that's Phase 4
  (product master + busyNotify wiring), not built yet.
- If parsing throws (e.g. a scanned file and Azure isn't configured), the
  request row still gets created but stays at `PROCESSING` and the error is
  only logged server-side (`console.error`) — there's no `FAILED` status in
  the schema yet, so a request stuck at `PROCESSING` is today's signal that
  it needs attention.
- No `GET /api/requests` yet — that's the Management dashboard, Phase 5.
  Verified this phase by querying `data/app.db` directly instead.

## Product matching (Phase 3)

`productMatching.js` resolves a raw extracted item name (e.g. from
`request_products.product_name_raw`) to a row in `products`, so a request
knows *which* product it's actually asking for. It ports the same
normalize + token-overlap scoring already used in
`busyNotify_mock_api/main.py` (`match_score`/`item_alias_score`) rather than
inventing a second matching approach — same 0.45 acceptance threshold, same
"exact code → exact/fuzzy name or alias" order. No new dependency.

`requestsRoutes.js` now calls this for every parsed item and, when a match
clears the threshold, copies over `product_id`/`brand`/`code`/`sku` — never
price, stock, or MRP; pulling those in for a matched product is Phase 4.

`npm run seed:products` (`seedProducts.js`) seeds `products` from
`busyNotify_mock_api/inventory.json` — the same 66 real chemical/reagent
names the mock pricing API already uses, not invented data — plus four
hand-picked illustrative aliases (e.g. `"IPA"` → *Isopropanol Alcohol
Molecular Grade*) demonstrating the exact case the plan describes: text with
no name overlap at all, resolved only because an alias exists.

**Try it yourself** (after `npm run seed`, `npm run seed:products`, and
`npm start` in one terminal):

```bash
# log in as rohit and save the session cookie
curl -c cookies.txt -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" -d '{"username":"rohit","password":"sales123"}'

# submit test-fixtures/sample_order_for_matching.csv, which contains an exact
# name match, an alias-only match ("IPA"), and one item with no match at all
curl -b cookies.txt -X POST http://localhost:3001/api/requests \
  -F "file=@test-fixtures/sample_order_for_matching.csv" \
  -F "party_name=Test Hospital" -F "request_type=ORDER" -F "delivery_date=2026-09-20"
```

Then check `request_products` in `data/app.db` (e.g. with the `sqlite3` CLI
or a SQLite viewer) — `Citric Acid Monohydrate` and `IPA` should both have a
`product_id` filled in, the unmatched item should not.

`npm test` now also runs `productMatching.test.js` — exact-code, exact-name,
fuzzy/partial-name, alias-only, and no-match cases against a throwaway DB.

## Purchase price + stock (Phase 4, partial)

Once an item is matched (or not) by Phase 3, `requestsRoutes.js` calls
`checkInventoryBulk()` (`inventoryCheck.js` - already existed, previously only
used by the legacy `/api/parse-orders/check-inventory` route) against
`busyNotify_mock_api`, which stands in for the live Busy integration. When
Phase 3 already resolved a `sku`, it's passed through for an exact lookup;
otherwise busyNotify falls back to its own name-fuzzy-match. Results write
`stock`, `short_by`, and `purchase_price` onto `request_products`. A
busyNotify outage is caught and logged, not fatal - the request and its items
are already saved either way.

**Still blocked on real source documents** (per your Phase 4 field mapping):
- **MRP** — needs the real Price List Excel. `PRICE_LIST_SAMPLE.pdf` in the
  project files turned out to be a 32-page technical catalog (codes + specs)
  with no price data anywhere in it, so it's not usable as-is for this.
- **RC price** — `rate_contracts`/`rate_contract_items` have no import path
  yet. `RATE_CONTRACT_SAMPLE.pdf` showed real rates are per-unit (`"3.38 per
  ml"`, hence the `rate_unit` column added earlier) and keyed by item name +
  brand, not a shared code - matching this will need brand as a signal, which
  `productMatching.js` doesn't use yet.

## Management portal (Phase 5)

The read side Phases 2-4 had nothing to exercise except direct SQL until now.

- `GET /api/requests?type=` — dashboard list (`MANAGEMENT`/`ADMIN` only).
- `GET /api/requests/:id` — single request with its line items.
- `PATCH /api/requests/:id` — update `status` and/or per-item `comment`. This
  is the plan's "human-in-the-loop" step. Only status and comment are
  editable for now — correcting a matched item's name/price/qty directly is
  a further increment if wanted.

Frontend: `/management` is now a real dashboard (type tabs, status badges,
clickable rows), `/management/requests/[id]` is the review screen (items
table with Code/SKU, brand, quantity, file price, purchase price, stock,
short-by, and an editable comment per row; unmatched items get a "No match"
badge; a status dropdown + Save at the bottom).

**Verification note:** the list/detail/update endpoints were tested directly
(role gating, data correctness, validation) and the pages were confirmed to
render and route correctly through the real dev server. The client-side
rendering itself (React mounting, state updates from typing in a comment
box) could not be checked with an actual browser in this environment — no
headless browser or display is available here, and downloading one is
blocked by this sandbox's network allowlist. Worth a manual click-through on
your machine before relying on it.

## Price list import (Admin, partial)

`POST /api/admin/price-lists` (`ADMIN` only, multipart: `file`, `brand`) —
`priceListImport.js` auto-detects the code/name/price columns per sheet
rather than expecting a fixed template. Built and tested against your three
real vendor files, not a guessed format:

| File | Sheets | Columns found | Rows |
|---|---|---|---|
| Borosil | Lab Consumable, Labquest | different in each sheet | 2,918 |
| Whatman/Cytiva | Sheet1 | `Cat No.` / `Product Description` / `2026 INR LP` | 1,997 |
| HiMedia | Aug(2026) | `Code` / `Name` / `Rate` (skips a title row, and a duplicate `Code.1` column) | 29,968 |

None of the three have a brand column — brand is whichever vendor's file
you're uploading, passed as a form field. Real vendor files turned out to
have two things worth knowing about: duplicate codes within one file (~18%
of HiMedia's rows — all harmless re-listings under different catalog
sections, verified none had conflicting prices) handled as upsert-safe, and
non-numeric price cells like `"On Request"` or `"Refer to page no. 1166"`
(~6% of HiMedia) treated as "no MRP on file" rather than a parse error.

Upsert key is `(product_code, brand)` — re-uploading a brand's updated price
list refreshes existing rows instead of duplicating them.

**Matching is now brand-aware** (`productMatching.js`): when the same
product name exists under two different brands and nothing disambiguates
them, `matchProduct()` returns `candidates: [...]` instead of silently
picking one. An optional `brandHint` resolves it directly when the source
document names a brand. This was necessary before price-list import could
be useful at all — 24k+ real products loaded, many sharing generic names,
would have made the old brand-blind matcher actively wrong.

**Performance note:** matching was originally one SQL query per product for
its aliases — fine against the ~66 seed products, catastrophic against
24,338 real ones (24k+ queries per single item match). Fixed to one query
total. What's left after that fix is the O(n) fuzzy-scoring scan itself:
~110-140ms per item against the full HiMedia set. That's a few seconds for a
typical multi-item order, not broken, but a real scaling ceiling — an
indexed candidate-narrowing step (SQLite FTS5, most likely) would be the
right fix if the product master keeps growing. Didn't build that here; it's
Phase 7 (hardening) territory, not this increment.

**Not built yet:**
- No admin UI for this — upload it with curl/Postman for now, same as every
  backend-first increment so far.
- The brand-ambiguity resolution you asked for (flag + dropdown, auto-pick
  by stock-then-price) isn't wired into `requestsRoutes.js` yet.
  `matchProduct()` can detect and report ambiguity; nothing acts on it
  during request creation yet, and `request_products.candidate_products`
  isn't populated.
- Rate contract upload (Excel + OCR reuse, per-customer RC price) — next.
- `/admin` landing page.

### Brand detection from filename

`brand` on `POST /api/admin/price-lists` is now optional. `brandDetection.js`
tries, in order:

1. **Known brands** — every brand name an admin has explicitly typed before
   (from `price_list_imports` history) is checked against the filename
   first. This is the case that matters for recurring uploads: once
   "Borosil" has been uploaded once, next quarter's file gets recognized
   even with a completely different filename, dates, and "final"/"v2"-style
   suffixes.
2. **Guessed** — for a brand never seen before, the filename is split on
   `_`/`-`/spaces, stripped of the extension and common non-brand tokens
   (`Price`, `List`, `PL`, years, months, `del`, `final`, `v1`, `v2`...), and
   whatever's left first is the guess.

Every response includes `brand` and `brand_source` (`"explicit"` /
`"known"` / `"guessed"`) so a bad guess is visible rather than silent —
passing `brand` explicitly always overrides detection either way.

**Verified end-to-end**, not just against the heuristic in isolation:
uploaded Borosil and HiMedia with no `brand` field at all (both correctly
guessed), then uploaded a second Borosil file with an unrelated filename
(`..._2728-final.xlsx`) and confirmed it was recognized as the *known*
brand "Borosil" and correctly upserted (0 inserted, 2,895 updated) rather
than creating a second, differently-spelled brand's worth of duplicate
products.

## Busy items import (real data, not the mock)

**Correction worth being explicit about:** `busyNotify_mock_api`'s ~66-item
inventory is fictional placeholder data, not a real Busy export — it's only
ever stood in for the *mechanism* of a live Busy integration (an HTTP call,
a response shape to parse), and its stock/price numbers were never meant to
be read as real. Don't rely on them for anything beyond exercising that code
path.

`POST /api/admin/busy-items` (`ADMIN` only, multipart: `file`) imports a
real Busy "List of Items" export instead — `busyItemsImport.js` reads
`Name` / `Alias` / `Group Name` / `Sale Price`, auto-detecting columns the
same way `priceListImport.js` does. Two things differ from the price-list
import: brand (`Group Name`) is read per row from the file itself, not
supplied separately, since Busy's own export already tracks it per item;
and only `purchase_price` and aliases are touched — `product_code` and
`mrp` stay under the price-list import's control, keeping the "MRP from
Price List, purchase price from Busy" split intact. Matches existing
products by exact `(product_name, brand)` text; a `Sale Price` of exactly
`0` is treated as "not entered" (real data — about half the file has it at
0 with `MRP` set instead), not a genuine zero cost.

**Verified against the real 165-row ACCUREX file:** first upload — 165
inserted, 1 alias added (the file's one real populated alias, `CALCIUM
100ML` → `CA-4`). Re-uploaded the identical file — 0 inserted, 165
updated, 0 duplicate aliases, confirming the upsert and re-upload path both
work correctly.

**Still genuinely blocked:** stock. This particular Busy export type is a
product-master list, not a stock report — no quantity/stock column exists
in it at all. The stock-based auto-pick logic built for brand-ambiguity
resolution is mechanically sound but has no real data to check against yet;
it needs an actual Busy stock export, which hasn't been provided.

## Brand-ambiguity resolution

When `productMatching.js` finds two+ different-brand products tied on
name/alias score, `requestsRoutes.js` no longer just takes the top-ranked
one silently. `buildRequestProductRows()` batches a stock lookup (via
`checkInventoryBulk`) for *every* candidate of every ambiguous item in one
request-wide call, then auto-picks whichever candidate has confirmed stock
≥ the requested quantity (cheapest first if more than one qualifies) —
falling back to the top-ranked candidate as a provisional pick when no
one's stock is confirmed sufficient. Either way, `request_products.
candidate_products` stays populated with every candidate (brand, stock,
purchase price) so the pick is never silent.

Management's request detail page (`/management/requests/[id]`) renders
that as a dropdown in the Brand column for any flagged row — "Multiple
brands" badge, each option showing brand + known/unknown stock — and
`PATCH /api/requests/:id` accepts a `product_id` override per item,
validated against that row's actual candidates (rejects anything else with
a 400). Choosing a different candidate correctly refreshes
`purchase_price`/`stock`/`short_by` to that candidate's own numbers, not
the previous pick's — this was a real bug caught while testing (switching
brands left the old candidate's stock figures on screen) and is fixed.

**Verified end-to-end** with a deliberately ambiguous pair (same name, two
brands — one with a real busyNotify SKU and confirmed stock, one
price-list-only with unknown stock): auto-pick correctly chose the
confirmed-stock candidate, `candidate_products` listed both, overriding via
PATCH to the other candidate correctly swept its price/stock across too,
and an invalid `product_id` was correctly rejected.

## Full field-sourcing spec

Confirmed field-by-field mapping, now fully wired:

| Field | Source | Where |
|---|---|---|
| Item name | Uploaded file, matched against price list | `request_products.product_name_raw` (raw) → `product_id` (matched) |
| Pack size / spec | Uploaded file | `request_products.pack_size` / `.specification` — parsed straight from the order, not matched against anything yet (see below) |
| Code | Price list | `request_products.code`, from the matched product |
| Brand | Price list | `request_products.brand`, from the matched product |
| Quantity | Uploaded file | `request_products.quantity_required` |
| Purchase price | Busy, via busyNotify | `request_products.purchase_price` |
| MRP | Price list | `request_products.mrp` |
| Stock | Busy, via busyNotify | `request_products.stock` |
| GST | Busy, via busyNotify | `request_products.gst` |

Two real things changed to get here, both caught by testing against real
data rather than assumed correct:

- **MRP was never actually being copied onto `request_products`** despite
  the column existing since Phase 1 — `buildRequestProductRows()` matched a
  product with a real price-list MRP and just... didn't carry it over.
  Fixed; verified against a real Borosil item (price-list MRP ₹165 now
  correctly distinct from the order's own quoted price of ₹150 on the same
  row, rather than being silently absent).
- **`checkInventoryBulk`'s response merge was clobbering busyNotify's own
  `pack_size` field** with the (empty) input value instead of passing it
  through. Not itself used yet, but was a real bug sitting there; fixed
  while wiring GST through the same response.

`priceListImport.js` now also detects a pack-size/capacity column
(`products.pack_size`) when a vendor's file has one — Borosil's "Capacity"
column does, Whatman/HiMedia don't, and that's fine, it stays null.
`busyNotify_mock_api`'s mock inventory now carries an illustrative
`gst_percent` (18%, flat) on every item — same accuracy caveat as the rest
of that mock's data, it's there to exercise the retrieval mechanism, not to
be a real GST source.

**Not yet built:** pack size/spec isn't used as a matching signal — it's
captured from the upload and (when the price list has it) from the matched
product, so Management can visually compare the two, but the matcher itself
doesn't score on it. Real vendor files are inconsistent enough about this
column (only 1 of 4 tested files has a clean one) that a heuristic here
risked being shakier than the rest of this system's real-data-tested
matching, so it's deferred rather than rushed.

## Management/Sales UI batch

A set of smaller, related changes, mostly UI:

- **S.No columns** on the dashboard and every item table.
- **Specs column** — `pack_size`/`specification` promoted from a subtitle to
  their own column.
- **Request-level comment** (`requests.comment`, distinct from
  `request_products.comment` which is per line item) — editable inline on
  the dashboard (autosaves on blur) and in the detail page's "Request note"
  field.
- **Totals row**, type-aware: Order = Σ(qty × file price); Quotation =
  Σ(qty × MRP × (1 + GST% − discount%)); Rate Contract = Σ(qty × rc_price).
  Recomputes live as you change the brand dropdown or type a discount —
  doesn't wait for Save.
- **Delivered tab** — a request moves out of the other tabs and into
  "Delivered" the moment its status is set to `DELIVERED`. This is
  client-side filtering on the existing list endpoint, not a new backend
  status filter — kept simple since the dataset doesn't need it yet.
- **Discount** (`request_products.discount`, percentage) — editable input,
  shown for `QUOTATION` requests. MRP/GST columns are also quotation-only
  now (Order shows File Price/Purchase, Rate Contract shows RC Price).
- **Brand alternatives always offered, not just on a scoring tie**:
  `matchProduct()` now checks whether the winning product's exact name
  exists under other brands in the product master *regardless* of whether
  this particular query happened to score them equally — e.g. one brand
  wins outright via an exact alias match, but a same-named product under a
  different brand still shows up as a selectable alternative. Verified with
  a case built specifically to NOT tie on score (one candidate boosted by
  an alias) — alternatives still appeared.
- **Live updates on brand switch**: changing the dropdown now updates Code,
  MRP, Purchase, GST, Stock, and Short By immediately (computed client-side
  from the candidate's own data), not just after Save. This was a real gap
  in the previous version — the dropdown changed the value but the table
  kept showing the old candidate's numbers until you saved.
- **RC party search** on the Sales form (`RATE_CONTRACT` only) — live
  autocomplete against `GET /api/rate-contracts/parties`, "Other" option
  always available, and submission is blocked until either a real party is
  selected or "Other" is explicitly confirmed (`party_matched` stored on the
  request, visible to Management as "(other)" next to the party name).
  **Will return empty results today** — rate contract import still doesn't
  exist, so `rate_contracts` has no rows yet; every RC submission will go
  through "Other" until that's built.

**Found while wiring this up, not assumed correct:** `request_products.
rc_price` has existed since Phase 1 but was never actually included in the
detail endpoint's SELECT — fixed, now exposed for the totals row to use
once rate contract import populates it.

**Worth flagging honestly:** the quotation total formula needs both MRP
(price-list-sourced) and GST (busyNotify-sourced) on the same item, but
today those two data sources don't share an identity — price-list products
have no `sku`, so they never resolve against busyNotify's inventory, and
vice versa. In practice no single product currently has both fields
populated at once; the total falls back to "—" until that's resolved (most
likely by capturing SKU during price-list import too, once there's a real
shared identifier to key on).

## Endpoints

### `POST /api/parse-order`
Single file. `multipart/form-data`, field name `file`.

```bash
curl -X POST http://localhost:3001/api/parse-order \
  -F "file=@PO.pdf"
```

Response:
```json
{
  "filename": "PO.pdf",
  "success": true,
  "source": "local_pdf_parse",
  "data": {
    "document_type": "purchase_order",
    "issuing_authority": "Mahatma Gandhi Medical College and Hospital",
    "vendor_name": "VEDANT SALES CORPORATION",
    "order_number": "SM1/DOM/GS0002994",
    "order_date": "2026-08-08",
    "reference_number": null,
    "currency": "INR",
    "items": [
      {
        "item_name": "Aluminium Potassium Sulphate Didecahydrate LR",
        "specification": "500GRB",
        "quantity": 1,
        "quantity_unit": "Nos",
        "unit_rate": 419.00,
        "amount": 252.15
      }
    ],
    "total_amount": 25149.07,
    "notes": null
  }
}
```

### `POST /api/parse-quotation`
Single-file quotation intake with the same multipart shape and parsed response as `/api/parse-order`.

```bash
curl -X POST http://localhost:3001/api/parse-quotation \
  -F "file=@quotation.pdf"
```

### `POST /api/parse-orders`
Batch. Field name `files` (repeat for each file, up to 25). Returns per-file results
**and** a flattened `flat_items` array — every line item from every order in one table,
ready to drop into a spreadsheet or your app's database.

```bash
curl -X POST http://localhost:3001/api/parse-orders \
  -F "files=@order1.pdf" \
  -F "files=@order2.jpg" \
  -F "files=@order3.jpeg"
```

### `POST /api/parse-orders/csv`
Same as above, but streams back a CSV file (`orders.csv`) of the flattened item table
instead of JSON — useful for a straight download button in your web app.

### `POST /api/parse-orders/check-inventory`
Same as the batch parse endpoint, but after flattening the extracted rows it sends
all items with `quantity > 0` to the busyNotify mock API `POST /api/v1/inventory/check-bulk`
and returns the inventory match results alongside the parsed orders.

### `POST /api/parse-orders/quote`
Same as the batch parse endpoint, but sends the flattened rows to the busyNotify mock API
`POST /api/v1/pricing/quote` and returns the priced quotation alongside the parsed orders.
Pass `customer_id`, `customer_name`, and optionally `quotation_date` as multipart form fields
when uploading the files.

### `POST /api/parse-orders/quote/pdf`
Same as `/api/parse-orders/quote`, but returns a downloadable PDF quotation instead of JSON.

## Files

- `pdfTextExtract.js` — low-level PDF text extraction with position data (`pdfjs-dist`),
  grouped into reading-order lines per page. Also the text-layer check that flags scans.
- `tableParser.js` — the local table reconstruction: header detection, column-boundary
  mapping from x-positions, row parsing (with wrapped-line merging), confidence scoring.
- `headerMetadata.js` — best-effort regex extraction of vendor/PO#/date/issuing authority
  from the text above the table.
- `extract.js` — `parseOrder()` orchestrates local-first-then-Azure per file;
  `extractOrderFromFile()` is the OCR path itself (uploads the PDF/image to Azure Document Intelligence,
  converts the overlay text back into the table parser input shape, and validates the JSON-like result).
- `normalize.js` — flattens parsed orders into one `what / quantity / price` row-per-item
  table (`flattenOrders`, now includes `parsed_by`) and turns that into CSV (`rowsToCsv`).
- `server.js` — Express routes wiring it together, with bounded concurrency for batches.

## Notes

- Max 20MB per file, 25 files per batch — adjust the `multer` limits in `server.js` if needed.
- Fields the model (or the local parser) can't determine come back as `null` rather than a
  guess — the AI path is explicitly instructed not to fabricate numbers. Check `notes` on
  each AI-parsed order for anything flagged as ambiguous (common with handwritten indents).
- Locally-parsed orders leave `document_type`, `reference_number`, and `total_amount` as
  `null` — those need judgment calls the table parser doesn't attempt. If you need them
  filled in for every order, set the confidence bar in `tableParser.js` (`scoreConfidence`)
  higher, or just always call the AI path.
- Rate-limit/server errors (`429`/`500`/`529`) are retried with exponential backoff automatically.
- Swap `GEMINI_MODEL` in `.env` if you want to pin a specific model version.
- Set `BUSYNOTIFY_API_BASE_URL` in `.env` if the inventory service is not running at `http://127.0.0.1:8000`.
- Set `AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT` and `AZURE_DOCUMENT_INTELLIGENCE_KEY` in `.env`
  for scanned PDF and image OCR.
- If you start seeing local parses with wrong numbers on a new document layout, that means
  its header labels didn't match `CATEGORY_PATTERNS` in `tableParser.js` the way you'd
  expect — add the label variant you're seeing there rather than trusting the output blindly.


# how to run 

everything would be ran in its own terminal window 

backend 
  - (Set-ExecutionPolicy -Scope Process -ExecutionPolicy RemoteSigned) ; (& "d:\vs code\claude scraper\.venv\Scripts\Activate.ps1")
  - (.venv) PS D:\vs code\claude scraper> npm start

frontend
  - PS D:\vs code\claude scraper> (Set-ExecutionPolicy -Scope Process -ExecutionPolicy RemoteSigned) ; (& "d:\vs code\claude scraper\.venv\Scripts\Activate.ps1")
  - (.venv) PS D:\vs code\claude scraper> set-Location 'd:\vs code\claude scraper\frontend'
  - (.venv) PS D:\vs code\claude scraper\frontend> npm run dev

busyNotify api 
   # set terminal for its own repo  ' cd "D:\vs code\busyNotify_mock_api" '
  - PS D:\vs code\busyNotify_mock_api> (Set-ExecutionPolicy -Scope Process -ExecutionPolicy RemoteSigned) ; (& "d:\vs code\busyNotify_mock_api\.venv\Scripts\Activate.ps1")
  - (.venv) PS D:\vs code\busyNotify_mock_api> uvicorn main:app --reload --port 8000