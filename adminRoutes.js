import { Router } from "express";
import multer from "multer";
import { db } from "./db.js";
import { requireAuth, requireRole } from "./auth.js";
import { parsePriceListWorkbook } from "./priceListImport.js";
import { parseBusyItemsWorkbook } from "./busyItemsImport.js";
import { detectBrand } from "./brandDetection.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const router = Router();

const findProductByCodeBrand = db.prepare("SELECT id FROM products WHERE product_code = ? AND brand = ?");
const insertProduct = db.prepare(
  "INSERT INTO products (product_code, product_name, brand, mrp, pack_size, active) VALUES (?, ?, ?, ?, ?, 1)"
);
const updateProductRow = db.prepare(
  "UPDATE products SET product_name = ?, mrp = ?, pack_size = COALESCE(?, pack_size), updated_at = datetime('now') WHERE id = ?"
);
const insertImportRecord = db.prepare(
  `INSERT INTO price_list_imports (brand, file_name, imported_by, rows_seen, rows_inserted, rows_updated, rows_skipped)
   VALUES (?, ?, ?, ?, ?, ?, ?)`
);
const listImports = db.prepare(`
  SELECT pli.id, pli.brand, pli.file_name, pli.rows_seen, pli.rows_inserted, pli.rows_updated, pli.rows_skipped, pli.created_at,
         u.display_name AS imported_by_name, u.username AS imported_by_username
  FROM price_list_imports pli
  LEFT JOIN users u ON u.id = pli.imported_by
  ORDER BY pli.id DESC
`);

// POST /api/admin/price-lists  (multipart: file, brand?)
// One brand's price list per upload - none of the real vendor files we
// tested against (Borosil, Whatman/Cytiva, HiMedia) had a brand column of
// their own. `brand` is optional: if omitted, it's detected from the
// filename - first against brands used in past uploads (confident, and the
// whole point given these files repeat every quarter/year), then falling
// back to stripping common non-brand tokens (Price/List/years/months) from
// the filename and taking what's left. Either way `brand`/`brand_source` in
// the response says what was actually used, so a bad guess is visible.
router.post("/price-lists", requireAuth, requireRole("ADMIN"), upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded. Use field name 'file'." });

  let brand = req.body?.brand?.trim() || null;
  let brandSource = brand ? "explicit" : null;

  if (!brand) {
    const detected = detectBrand(req.file.originalname);
    if (!detected) {
      return res.status(400).json({
        error: "brand is required (couldn't detect one from the filename - pass it explicitly).",
      });
    }
    brand = detected.brand;
    brandSource = detected.source;
  }

  let parsed;
  try {
    parsed = parsePriceListWorkbook(req.file.buffer);
  } catch (err) {
    return res.status(400).json({ error: `Could not read this file as a spreadsheet: ${err.message}` });
  }

  if (parsed.sheets.length === 0) {
    return res
      .status(422)
      .json({ error: "Could not detect a product code/name table in any sheet of this file." });
  }

  let rowsSeen = 0;
  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  const applyImport = db.transaction(() => {
    for (const sheet of parsed.sheets) {
      rowsSeen += sheet.rowsSeen;
      skipped += sheet.rowsSkipped;
      for (const row of sheet.rows) {
        const existing = findProductByCodeBrand.get(row.code, brand);
        if (existing) {
          updateProductRow.run(row.name, row.price, row.packSize, existing.id);
          updated++;
        } else {
          insertProduct.run(row.code, row.name, brand, row.price, row.packSize);
          inserted++;
        }
      }
    }
  });
  applyImport();

  insertImportRecord.run(brand, req.file.originalname, req.user.id, rowsSeen, inserted, updated, skipped);

  res.status(201).json({
    brand,
    brand_source: brandSource,
    file_name: req.file.originalname,
    sheets: parsed.sheets.map((s) => ({
      sheet: s.sheetName,
      columns: s.columns,
      rows_seen: s.rowsSeen,
      rows_skipped: s.rowsSkipped,
    })),
    rows_seen: rowsSeen,
    rows_inserted: inserted,
    rows_updated: updated,
    rows_skipped: skipped,
  });
});

// GET /api/admin/price-lists - upload history, so admin can see what's been imported.
router.get("/price-lists", requireAuth, requireRole("ADMIN"), (req, res) => {
  res.json({ imports: listImports.all() });
});

const findProductByNameBrand = db.prepare("SELECT id FROM products WHERE product_name = ? AND brand = ?");
const insertBusyProduct = db.prepare(
  "INSERT INTO products (product_name, brand, purchase_price, active) VALUES (?, ?, ?, 1)"
);
// ponytail: COALESCE so a row with no Sale Price this time doesn't wipe out
// a purchase_price that came from an earlier upload - only overwrite when
// this file actually has a value.
const updateBusyProductPrice = db.prepare(
  "UPDATE products SET purchase_price = COALESCE(?, purchase_price), updated_at = datetime('now') WHERE id = ?"
);
const aliasExistsForProduct = db.prepare("SELECT id FROM product_aliases WHERE product_id = ? AND alias_text = ?");
const insertProductAlias = db.prepare("INSERT INTO product_aliases (product_id, alias_text) VALUES (?, ?)");

// POST /api/admin/busy-items (multipart: file)
// A real Busy "List of Items" export - Name/Alias/Group Name/Sale Price.
// Only touches purchase_price and aliases; product_code and mrp stay under
// the price-list import's control (MRP comes from the Price List, purchase
// price comes from Busy - this is that rule). Matches existing products by
// exact (product_name, brand) text and creates new ones (no code - Busy
// exports don't have one) when Busy has an item a price list hasn't seen.
router.post("/busy-items", requireAuth, requireRole("ADMIN"), upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded. Use field name 'file'." });

  let parsed;
  try {
    parsed = parseBusyItemsWorkbook(req.file.buffer);
  } catch (err) {
    return res.status(400).json({ error: `Could not read this file as a spreadsheet: ${err.message}` });
  }

  if (!parsed.columns || parsed.columns.name === -1 || parsed.columns.brand === -1) {
    return res.status(422).json({ error: "Could not detect Name/Group Name columns in this file." });
  }

  let inserted = 0;
  let updated = 0;
  let aliasesAdded = 0;

  const applyImport = db.transaction(() => {
    for (const row of parsed.rows) {
      const existing = findProductByNameBrand.get(row.name, row.brand);
      let productId;
      if (existing) {
        updateBusyProductPrice.run(row.purchasePrice, existing.id);
        productId = existing.id;
        updated++;
      } else {
        productId = insertBusyProduct.run(row.name, row.brand, row.purchasePrice).lastInsertRowid;
        inserted++;
      }
      if (row.alias && !aliasExistsForProduct.get(productId, row.alias)) {
        insertProductAlias.run(productId, row.alias);
        aliasesAdded++;
      }
    }
  });
  applyImport();

  res.status(201).json({
    file_name: req.file.originalname,
    columns: parsed.columns,
    rows_seen: parsed.rowsSeen,
    rows_skipped: parsed.rowsSkipped,
    products_inserted: inserted,
    products_updated: updated,
    aliases_added: aliasesAdded,
  });
});

export default router;
