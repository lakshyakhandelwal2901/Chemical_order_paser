import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import multer from "multer";
import { db } from "./db.js";
import { requireAuth, requireRole } from "./auth.js";
import { parseOrder } from "./extract.js";
import { matchProduct } from "./productMatching.js";
import { checkInventoryBulk } from "./inventoryCheck.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadsDir = path.join(__dirname, "uploads");
fs.mkdirSync(uploadsDir, { recursive: true });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

const router = Router();

const REQUEST_TYPES = ["ORDER", "RATE_CONTRACT", "QUOTATION"];

function defaultDeliveryDate() {
  const date = new Date();
  date.setDate(date.getDate() + 7);
  return date.toISOString().slice(0, 10);
}

function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9.\-_]/g, "_");
}

const insertRequest = db.prepare(
  `INSERT INTO requests
     (file_number, file_name, file_type, salesperson_id, party_name, party_matched, delivery_date, status, original_file_path)
   VALUES (?, ?, ?, ?, ?, ?, ?, 'PROCESSING', ?)`
);
const finalizeFileNumber = db.prepare("UPDATE requests SET file_number = ? WHERE id = ?");

// ponytail: file_number is derived from the row's own autoincrement id
// (10000 + id) instead of a separate counter table - one less piece of
// state to keep in sync. The insert-then-update below is safe without a
// transaction because better-sqlite3 is synchronous and nothing else can
// run on Node's single thread between the two calls.
function createRequestRow({ fileName, requestType, salespersonId, partyName, partyMatched, deliveryDate, originalFilePath }) {
  const { lastInsertRowid: requestId } = insertRequest.run(
    "PENDING",
    fileName,
    requestType,
    salespersonId,
    partyName,
    partyMatched,
    deliveryDate,
    originalFilePath
  );
  const fileNumber = String(10000 + Number(requestId));
  finalizeFileNumber.run(fileNumber, requestId);
  return { requestId, fileNumber };
}

const insertRequestProduct = db.prepare(`
  INSERT INTO request_products
    (request_id, product_id, product_name_raw, pack_size, specification, brand, code, sku,
     quantity_required, file_price, mrp, purchase_price, stock, gst, short_by, candidate_products)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertRequestProductRows = db.transaction((requestId, rows) => {
  for (const row of rows) {
    insertRequestProduct.run(
      requestId,
      row.product_id,
      row.item.item_name ?? "Unknown item",
      row.item.pack_size ?? null,
      row.item.specification ?? null,
      row.brand,
      row.code,
      row.sku,
      row.item.quantity ?? null,
      row.item.unit_rate ?? null,
      row.mrp,
      row.purchase_price,
      row.stock,
      row.gst,
      row.short_by,
      row.candidate_products
    );
  }
});
const markReadyForReview = db.prepare(
  "UPDATE requests SET status = 'READY_FOR_REVIEW', updated_at = datetime('now') WHERE id = ?"
);

function candidateLookupKey(itemIndex, candidateIndex) {
  return `${itemIndex}:${candidateIndex}`;
}

// Phase 3 (matching) + purchase price/stock/GST from Busy + brand-ambiguity
// resolution, all in one batched pass before anything is written. Needs to
// happen before insert, not after, because resolving an ambiguous brand tie
// requires knowing each candidate's stock first.
//
// busyNotify_mock_api stands in for the live Busy integration - it only
// knows about its own ~66 mock SKUs, so purchase_price/stock/gst for a
// price-list-only product (Borosil, HiMedia, Whatman...) will generally come
// back unknown (null), not zero, until it's actually connected. Never
// throws - a busyNotify outage shouldn't sink a request that's already
// building; those fields just stay null for whatever it couldn't reach.
async function buildRequestProductRows(fileNumber, items) {
  const matches = items.map((item) => ({ item, match: matchProduct(item.item_name) }));

  const lookupRows = [];
  matches.forEach(({ item, match }, itemIndex) => {
    if (!match) return;
    const candidates = match.candidates ?? [{ product: match.product, score: match.score }];
    candidates.forEach((candidate, candidateIndex) => {
      lookupRows.push({
        item_name: candidate.product.product_name,
        sku: candidate.product.sku || undefined,
        quantity: item.quantity ?? 1,
        source_file: candidateLookupKey(itemIndex, candidateIndex),
      });
    });
  });

  const stockByKey = new Map();
  if (lookupRows.length > 0) {
    try {
      const result = await checkInventoryBulk(lookupRows);
      for (const r of result.items) {
        if (r.found) stockByKey.set(r.source_file, { stock: r.available_quantity, price: r.unit_price, gst: r.gst_percent ?? null });
      }
    } catch (err) {
      console.error(`busyNotify inventory check failed for request ${fileNumber}:`, err.message);
    }
  }

  return matches.map(({ item, match }, itemIndex) => {
    if (!match) {
      return {
        item,
        product_id: null,
        brand: null,
        code: null,
        sku: null,
        mrp: null,
        purchase_price: null,
        stock: null,
        gst: null,
        short_by: null,
        candidate_products: null,
      };
    }

    // Not just a scoring tie anymore - matchProduct() also sets candidates
    // when the winner was picked confidently but the same product exists
    // under other brands too. Either way, the same stock-then-price ranking
    // below picks the default and the row stays selectable.
    const hasAlternatives = Boolean(match.candidates);
    const rawCandidates = match.candidates ?? [{ product: match.product, score: match.score }];
    const enrichedCandidates = rawCandidates.map((c, candidateIndex) => {
      const stockInfo = stockByKey.get(candidateLookupKey(itemIndex, candidateIndex));
      return {
        product_id: c.product.id,
        brand: c.product.brand,
        code: c.product.product_code,
        sku: c.product.sku,
        mrp: c.product.mrp,
        score: c.score,
        stock: stockInfo?.stock ?? null,
        purchase_price: stockInfo?.price ?? null,
        gst: stockInfo?.gst ?? null,
      };
    });

    // Auto-pick: prefer a candidate with confirmed-sufficient stock, cheapest
    // among those if more than one qualifies. Falls back to the top-ranked
    // (best name/alias score) candidate when no one's stock is confirmed
    // sufficient - still just a provisional pick, which is exactly why
    // candidate_products stays populated either way for manual override.
    let chosen = enrichedCandidates[0];
    if (hasAlternatives) {
      const requiredQty = item.quantity ?? 0;
      const sufficient = enrichedCandidates
        .filter((c) => c.stock !== null && c.stock >= requiredQty)
        .sort((a, b) => (a.purchase_price ?? Infinity) - (b.purchase_price ?? Infinity));
      if (sufficient.length > 0) chosen = sufficient[0];
    }

    return {
      item,
      product_id: chosen.product_id,
      brand: chosen.brand,
      code: chosen.code,
      sku: chosen.sku,
      mrp: chosen.mrp,
      purchase_price: chosen.purchase_price,
      stock: chosen.stock,
      gst: chosen.gst,
      short_by: chosen.stock !== null ? Math.max(0, (item.quantity ?? 0) - chosen.stock) : null,
      candidate_products: hasAlternatives ? JSON.stringify(enrichedCandidates) : null,
    };
  });
}

// POST /api/requests   (multipart/form-data: file, party_name, request_type, delivery_date)
// Salesperson-only intake. Returns just enough to confirm submission - never
// extracted items, prices, or stock (per the plan, that stays in Management).
router.post("/", requireAuth, requireRole("SALESPERSON", "ADMIN"), upload.single("file"), async (req, res) => {
  const partyName = req.body?.party_name?.trim();
  const requestType = req.body?.request_type;
  const deliveryDate = req.body?.delivery_date || defaultDeliveryDate();

  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded. Use field name 'file'." });
  }
  if (!partyName) {
    return res.status(400).json({ error: "party_name is required." });
  }
  if (!REQUEST_TYPES.includes(requestType)) {
    return res.status(400).json({ error: `request_type must be one of: ${REQUEST_TYPES.join(", ")}` });
  }
  if (Number.isNaN(new Date(deliveryDate).getTime())) {
    return res.status(400).json({ error: "delivery_date is not a valid date." });
  }

  // Rate contract requests must go through the party search - either a real
  // match, or an explicit "Other" acknowledgment that nothing matched. This
  // is a required signal from the client, not a guess the server makes, so
  // a request that skips the search entirely (party_matched missing) is
  // rejected rather than silently treated as unmatched.
  let partyMatched = null;
  if (requestType === "RATE_CONTRACT") {
    if (req.body?.party_matched === undefined) {
      return res.status(400).json({
        error: "party_matched is required for RATE_CONTRACT requests (search and select a party, or confirm 'Other').",
      });
    }
    partyMatched = req.body.party_matched === "true" ? 1 : 0;
  }

  // Persist the original file before anything else - the request record
  // must exist even if parsing below fails.
  const storedName = `${Date.now()}-${sanitizeFilename(req.file.originalname)}`;
  fs.writeFileSync(path.join(uploadsDir, storedName), req.file.buffer);

  const { requestId, fileNumber } = createRequestRow({
    fileName: req.file.originalname,
    requestType,
    salespersonId: req.user.id,
    partyName,
    partyMatched,
    deliveryDate,
    originalFilePath: path.join("uploads", storedName),
  });

  // Reuses extract.js's parsing pipeline (local-first, Azure OCR fallback -
  // already built), resolves each item to the product master via
  // productMatching.js (Phase 3, brand-aware), looks up purchase price +
  // stock from Busy (Phase 4, partial), and resolves any brand ambiguity
  // using stock-then-price before writing anything. MRP and RC price still
  // need the real Price List/Rate Contract sources.
  try {
    const { data } = await parseOrder(req.file);
    const rows = await buildRequestProductRows(fileNumber, data?.items ?? []);
    insertRequestProductRows(requestId, rows);
    markReadyForReview.run(requestId);
  } catch (err) {
    // ponytail: no FAILED status in the schema yet - a request stuck at
    // PROCESSING is the current signal that it needs attention. Logged
    // server-side only; the salesperson still gets a normal confirmation,
    // since parsing issues are a Management-side concern per the plan.
    console.error(`Parsing failed for request ${fileNumber} (${req.file.originalname}):`, err.message);
  }

  res.status(201).json({
    request_id: requestId,
    file_number: fileNumber,
    party_name: partyName,
    request_type: requestType,
    delivery_date: deliveryDate,
  });
});

const REQUEST_STATUSES = ["PROCESSING", "READY_FOR_REVIEW", "IN_PROGRESS", "DELIVERED", "CANCELLED"];

const listRequestsAll = db.prepare(`
  SELECT r.id, r.file_number, r.file_name, r.file_type, r.party_name, r.party_matched, r.delivery_date, r.status, r.submission_date, r.comment,
         u.display_name AS salesperson_name, u.username AS salesperson_username
  FROM requests r
  JOIN users u ON u.id = r.salesperson_id
  ORDER BY r.id DESC
`);
const listRequestsByType = db.prepare(`
  SELECT r.id, r.file_number, r.file_name, r.file_type, r.party_name, r.party_matched, r.delivery_date, r.status, r.submission_date, r.comment,
         u.display_name AS salesperson_name, u.username AS salesperson_username
  FROM requests r
  JOIN users u ON u.id = r.salesperson_id
  WHERE r.file_type = ?
  ORDER BY r.id DESC
`);
const getRequestById = db.prepare(`
  SELECT r.id, r.file_number, r.file_name, r.file_type, r.party_name, r.party_matched, r.delivery_date, r.status, r.submission_date, r.comment,
         u.display_name AS salesperson_name, u.username AS salesperson_username
  FROM requests r
  JOIN users u ON u.id = r.salesperson_id
  WHERE r.id = ?
`);
const listItemsByRequest = db.prepare(`
  SELECT id, product_name_raw, pack_size, specification, brand, code, sku,
         quantity_required, file_price, mrp, purchase_price, stock, gst, discount, rc_price, short_by, comment, candidate_products
  FROM request_products
  WHERE request_id = ?
  ORDER BY id ASC
`);
const updateStatus = db.prepare("UPDATE requests SET status = ?, updated_at = datetime('now') WHERE id = ?");
const updateRequestComment = db.prepare("UPDATE requests SET comment = ?, updated_at = datetime('now') WHERE id = ?");
const updateItemComment = db.prepare(
  "UPDATE request_products SET comment = ?, updated_at = datetime('now') WHERE id = ? AND request_id = ?"
);
const updateItemDiscount = db.prepare(
  "UPDATE request_products SET discount = ?, updated_at = datetime('now') WHERE id = ? AND request_id = ?"
);
const getItemForOverride = db.prepare(
  "SELECT candidate_products, quantity_required FROM request_products WHERE id = ? AND request_id = ?"
);
const updateItemProductChoice = db.prepare(`
  UPDATE request_products
  SET product_id = ?, brand = ?, code = ?, sku = ?, mrp = ?, purchase_price = ?, stock = ?, gst = ?, short_by = ?, updated_at = datetime('now')
  WHERE id = ? AND request_id = ?
`);

function requestDetail(id) {
  const request = getRequestById.get(id);
  if (!request) return null;
  const items = listItemsByRequest.all(id).map((item) => ({
    ...item,
    candidate_products: item.candidate_products ? JSON.parse(item.candidate_products) : null,
  }));
  return { ...request, items };
}

// GET /api/requests?type=ORDER|RATE_CONTRACT|QUOTATION
// Management-only. This is the read side Phases 2-4 have had nothing to
// verify against except direct SQL - the dashboard list view.
router.get("/", requireAuth, requireRole("MANAGEMENT", "ADMIN"), (req, res) => {
  const type = req.query.type;
  const rows = type ? listRequestsByType.all(type) : listRequestsAll.all();
  res.json({ requests: rows });
});

// GET /api/requests/:id - single request plus its line items.
router.get("/:id", requireAuth, requireRole("MANAGEMENT", "ADMIN"), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid request id." });
  const detail = requestDetail(id);
  if (!detail) return res.status(404).json({ error: "Request not found." });
  res.json(detail);
});

// PATCH /api/requests/:id  { status?, items?: [{ id, comment?, product_id? }] }
// The "human-in-the-loop" step from the plan: Management sets status, can
// PATCH /api/requests/:id  { status?, comment?, items?: [{ id, comment?, discount?, product_id? }] }
// The "human-in-the-loop" step from the plan: Management sets status,
// leaves a request-level note, annotates/discounts line items, and - when a
// row has brand alternatives - can pick between them. product_id must be
// one of that row's actual candidates (or its current product_id);
// correcting the parsed name/price/qty directly is a further increment.
router.patch("/:id", requireAuth, requireRole("MANAGEMENT", "ADMIN"), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid request id." });
  if (!getRequestById.get(id)) return res.status(404).json({ error: "Request not found." });

  const { status, comment, items } = req.body || {};
  if (status !== undefined && !REQUEST_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${REQUEST_STATUSES.join(", ")}` });
  }
  if (items !== undefined && !Array.isArray(items)) {
    return res.status(400).json({ error: "items must be an array." });
  }

  for (const item of items ?? []) {
    if (!item || typeof item.id !== "number") continue;
    if (item.discount !== undefined && item.discount !== null && (typeof item.discount !== "number" || item.discount < 0 || item.discount > 100)) {
      return res.status(400).json({ error: `discount for item ${item.id} must be a number between 0 and 100.` });
    }
    if (item.product_id === undefined) continue;
    const row = getItemForOverride.get(item.id, id);
    if (!row) return res.status(400).json({ error: `Item ${item.id} does not belong to this request.` });
    const candidates = row.candidate_products ? JSON.parse(row.candidate_products) : [];
    if (!candidates.some((c) => c.product_id === item.product_id)) {
      return res.status(400).json({ error: `product_id ${item.product_id} is not one of item ${item.id}'s candidates.` });
    }
  }

  const applyUpdate = db.transaction(() => {
    if (status !== undefined) updateStatus.run(status, id);
    if (comment !== undefined) updateRequestComment.run(comment ?? null, id);
    for (const item of items ?? []) {
      if (!item || typeof item.id !== "number") continue;
      if (item.comment !== undefined) updateItemComment.run(item.comment ?? null, item.id, id);
      if (item.discount !== undefined) updateItemDiscount.run(item.discount ?? null, item.id, id);
      if (item.product_id !== undefined) {
        const row = getItemForOverride.get(item.id, id);
        const candidates = row.candidate_products ? JSON.parse(row.candidate_products) : [];
        const chosen = candidates.find((c) => c.product_id === item.product_id);
        const shortBy = chosen.stock !== null ? Math.max(0, (row.quantity_required ?? 0) - chosen.stock) : null;
        updateItemProductChoice.run(
          chosen.product_id,
          chosen.brand,
          chosen.code,
          chosen.sku,
          chosen.mrp,
          chosen.purchase_price,
          chosen.stock,
          chosen.gst,
          shortBy,
          item.id,
          id
        );
      }
    }
  });
  applyUpdate();

  res.json(requestDetail(id));
});

export default router;
