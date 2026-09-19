-- Phase 1 foundation schema (see README.md "Database" section for how these
-- map onto the workflow plan). Run automatically on server start by db.js -
-- every statement is idempotent so this is safe to apply repeatedly.

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('SALESPERSON', 'MANAGEMENT', 'ADMIN')),
  display_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT UNIQUE,
  product_code TEXT,
  product_name TEXT NOT NULL,
  brand TEXT,
  alias_number TEXT,
  unit TEXT,
  pack_size TEXT,
  mrp REAL,
  purchase_price REAL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ponytail: not in the original table list, but "map free-text OCR output
-- onto the right product" needs somewhere to store the name variants that
-- point at one product_id. Kept as its own table since a product can have
-- more than one alias (the plan's single `alias_number` field on `products`
-- is preserved above as-is for whatever that field means in your ERP).
CREATE TABLE IF NOT EXISTS product_aliases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  alias_text TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stock (
  product_id INTEGER PRIMARY KEY REFERENCES products (id) ON DELETE CASCADE,
  available_quantity REAL NOT NULL DEFAULT 0,
  reserved_quantity REAL NOT NULL DEFAULT 0,
  warehouse TEXT,
  last_updated TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rate_contracts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  party_name TEXT NOT NULL,
  valid_from TEXT,
  valid_until TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rate_contract_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rate_contract_id INTEGER NOT NULL REFERENCES rate_contracts (id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products (id),
  rc_price REAL NOT NULL,
  -- ponytail: free text, not a constrained enum - real rate-contract
  -- documents use inconsistent unit wording ("per ml", "per pc", "per stp",
  -- "per roll"...) and forcing them into a fixed list would reject valid
  -- data. rc_price alone is ambiguous without this (see RATE_CONTRACT_SAMPLE.pdf:
  -- "3.38 per ml" vs "649.00 per roll" are not comparable numbers).
  rate_unit TEXT
);

CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_number TEXT NOT NULL UNIQUE,
  file_name TEXT NOT NULL,
  file_type TEXT NOT NULL CHECK (file_type IN ('ORDER', 'RATE_CONTRACT', 'QUOTATION')),
  salesperson_id INTEGER NOT NULL REFERENCES users (id),
  party_name TEXT NOT NULL,
  -- ponytail: only meaningful for RATE_CONTRACT requests - whether party_name
  -- was picked from the known-parties autocomplete (1) or entered via the
  -- "Other" fallback because nothing matched (0). NULL for ORDER/QUOTATION,
  -- which don't go through that flow.
  party_matched INTEGER,
  submission_date TEXT NOT NULL DEFAULT (datetime('now')),
  delivery_date TEXT,
  status TEXT NOT NULL DEFAULT 'PROCESSING'
    CHECK (status IN ('PROCESSING', 'READY_FOR_REVIEW', 'IN_PROGRESS', 'DELIVERED', 'CANCELLED')),
  original_file_path TEXT,
  -- ponytail: request-level note, separate from request_products.comment
  -- (which is per line item) - shown/editable straight from the Management
  -- dashboard list, not just the detail page.
  comment TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS request_products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL REFERENCES requests (id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products (id),
  product_name_raw TEXT NOT NULL,
  -- ponytail: pack_size/specification are what the uploaded file itself
  -- said (parsed by extract.js) - kept distinct from products.pack_size
  -- (what the price list says) so Management can visually compare the two,
  -- rather than silently picking one. Not yet used as a matching signal.
  pack_size TEXT,
  specification TEXT,
  brand TEXT,
  code TEXT,
  sku TEXT,
  quantity_required REAL,
  file_price REAL,
  rc_price REAL,
  mrp REAL,
  purchase_price REAL,
  stock REAL,
  gst REAL,
  -- ponytail: percentage, quotation-specific - editable by Management when
  -- preparing a quote. NULL/0 for ORDER and RATE_CONTRACT line items.
  discount REAL,
  short_by REAL,
  comment TEXT,
  -- ponytail: JSON array of {product_id, brand, sku, score} - populated only
  -- when matching found multiple equally-good, different-brand candidates
  -- and couldn't confidently pick one. NULL for a normal confident match.
  candidate_products TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_requests_status ON requests (status);
CREATE INDEX IF NOT EXISTS idx_requests_salesperson ON requests (salesperson_id);
CREATE INDEX IF NOT EXISTS idx_request_products_request ON request_products (request_id);
CREATE INDEX IF NOT EXISTS idx_product_aliases_product ON product_aliases (product_id);

-- ponytail: partial (only enforced when both are set) so busyNotify-sourced
-- rows with product_code/brand left NULL never conflict with each other or
-- with price-list-sourced rows. This is what makes re-uploading a brand's
-- price list an upsert instead of creating duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS idx_products_code_brand
  ON products (product_code, brand)
  WHERE product_code IS NOT NULL AND brand IS NOT NULL;

CREATE TABLE IF NOT EXISTS price_list_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  brand TEXT NOT NULL,
  file_name TEXT NOT NULL,
  imported_by INTEGER REFERENCES users (id),
  rows_seen INTEGER NOT NULL DEFAULT 0,
  rows_inserted INTEGER NOT NULL DEFAULT 0,
  rows_updated INTEGER NOT NULL DEFAULT 0,
  rows_skipped INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
