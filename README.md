# Order Parser Backend

Extracts `item name / quantity / price` (plus vendor, order no., date, issuing authority)
from purchase orders, supply orders, indents, and rate contracts — PDF or image, any layout,
Hindi/English/handwritten — into one consistent JSON/CSV shape.

## How parsing decides local vs. AI

For every **PDF**, it tries a local parse first, for free, with no API call:

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
every **image** (no text layer to parse, and these forms are often handwritten
Hindi where OCR alone isn't reliable), falls back to Gemini, which reads the
page like a person would.

Every parse result carries a `source` field (`"local_pdf_parse"` or
`"ai_fallback"`) so you can see which path handled each document — useful for
tracking how much of your volume is being resolved for free.

**Tested against real documents:** of 3 sample PDFs from a working set, 1 was
a genuinely digital PO — parsed locally, all 9 line items + vendor/PO#/date
extracted correctly with zero API calls. The other 2 were scans with no text
layer at all and correctly fell straight through to AI.

## Setup

```bash
npm install
cp .env.example .env
# edit .env and paste your GOOGLE_API_KEY if you want Gemini fallback for scans/images
npm start
```

Server runs on `http://localhost:3001` by default.

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
- `extract.js` — `parseOrder()` orchestrates local-first-then-AI per file; `extractOrderFromFile()`
  is the AI path itself (builds the Gemini request — PDF or image bytes sent as inline data)
  with the extraction schema/prompt, retry-with-backoff, and JSON validation.
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
- If you start seeing local parses with wrong numbers on a new document layout, that means
  its header labels didn't match `CATEGORY_PATTERNS` in `tableParser.js` the way you'd
  expect — add the label variant you're seeing there rather than trusting the output blindly.
