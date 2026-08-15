import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import { parseOrder } from "./extract.js";
import { flattenOrders, rowsToCsv } from "./normalize.js";
import { checkInventoryBulk } from "./inventoryCheck.js";
import { quoteFromParsedRows } from "./quotation.js";
import { buildQuotationPdfBuffer } from "./quotationPdf.js";

if (!process.env.GOOGLE_API_KEY) {
  console.warn(
    "GOOGLE_API_KEY is missing. Local PDF parsing will still work, but scanned PDFs/images will fail until you set the Gemini key."
  );
}

const app = express();
const PORT = process.env.PORT || 3001;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 25 }, // 20MB/file, up to 25 files per batch
});

app.use(cors());
app.use(express.json());

// --- Single file ---------------------------------------------------------
// POST /api/parse-order   (multipart/form-data, field name: "file")
app.post("/api/parse-order", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded. Use field name 'file'." });
  }

  try {
    const { source, data } = await parseOrder(req.file);
    res.json({ filename: req.file.originalname, success: true, source, data });
  } catch (err) {
    res.status(422).json({ filename: req.file.originalname, success: false, error: err.message });
  }
});

// --- Batch -----------------------------------------------------------------
// POST /api/parse-orders   (multipart/form-data, field name: "files", repeatable)
// Returns per-file results plus a flattened what/quantity/price table across all of them.
app.post("/api/parse-orders", upload.array("files", 25), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: "No files uploaded. Use field name 'files'." });
  }

  // Process with limited concurrency so we don't blow through rate limits on big batches.
  const CONCURRENCY = 4;
  const results = new Array(req.files.length);
  let cursor = 0;

  async function worker() {
    while (cursor < req.files.length) {
      const index = cursor++;
      const file = req.files[index];
      try {
        const { source, data } = await parseOrder(file);
        results[index] = { filename: file.originalname, success: true, source, data };
      } catch (err) {
        results[index] = { filename: file.originalname, success: false, error: err.message };
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const successfulOrders = results
    .filter((r) => r.success)
    .map((r) => ({ filename: r.filename, source: r.source, data: r.data }));
  const flatRows = flattenOrders(successfulOrders);

  res.json({
    results,
    flat_items: flatRows,
    summary: {
      total_files: req.files.length,
      succeeded: results.filter((r) => r.success).length,
      failed: results.filter((r) => !r.success).length,
      parsed_locally: results.filter((r) => r.source === "local_pdf_parse").length,
      parsed_by_ai: results.filter((r) => r.source === "ai_fallback").length,
      total_line_items: flatRows.length,
    },
  });
});

// --- Batch as CSV ------------------------------------------------------
// Same as /api/parse-orders but responds with a downloadable CSV of the flat item table.
app.post("/api/parse-orders/csv", upload.array("files", 25), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: "No files uploaded. Use field name 'files'." });
  }

  const CONCURRENCY = 4;
  const results = new Array(req.files.length);
  let cursor = 0;

  async function worker() {
    while (cursor < req.files.length) {
      const index = cursor++;
      const file = req.files[index];
      try {
        const { source, data } = await parseOrder(file);
        results[index] = { filename: file.originalname, success: true, source, data };
      } catch (err) {
        results[index] = { filename: file.originalname, success: false, error: err.message };
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const successfulOrders = results
    .filter((r) => r.success)
    .map((r) => ({ filename: r.filename, source: r.source, data: r.data }));
  const flatRows = flattenOrders(successfulOrders);
  const csv = rowsToCsv(flatRows);

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", 'attachment; filename="orders.csv"');
  res.send(csv);
});

// --- Batch parse + inventory check ----------------------------------------
// Parses uploaded files, flattens the extracted items, then sends all items
// with quantity > 0 to the busyNotify mock API /api/v1/inventory/check-bulk.
app.post("/api/parse-orders/check-inventory", upload.array("files", 25), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: "No files uploaded. Use field name 'files'." });
  }

  const CONCURRENCY = 4;
  const results = new Array(req.files.length);
  let cursor = 0;

  async function worker() {
    while (cursor < req.files.length) {
      const index = cursor++;
      const file = req.files[index];
      try {
        const { source, data } = await parseOrder(file);
        results[index] = { filename: file.originalname, success: true, source, data };
      } catch (err) {
        results[index] = { filename: file.originalname, success: false, error: err.message };
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const successfulOrders = results
    .filter((r) => r.success)
    .map((r) => ({ filename: r.filename, source: r.source, data: r.data }));
  const flatRows = flattenOrders(successfulOrders);

  try {
    const inventoryCheck = await checkInventoryBulk(flatRows);

    res.json({
      results,
      flat_items: flatRows,
      inventory_check: inventoryCheck,
      summary: {
        total_files: req.files.length,
        succeeded: results.filter((r) => r.success).length,
        failed: results.filter((r) => !r.success).length,
        parsed_locally: results.filter((r) => r.source === "local_pdf_parse").length,
        parsed_by_ai: results.filter((r) => r.source === "ai_fallback").length,
        total_line_items: flatRows.length,
        inventory_checked_items: inventoryCheck.checked ?? 0,
        inventory_skipped_items: inventoryCheck.skipped?.length ?? 0,
      },
    });
  } catch (err) {
    res.status(502).json({
      results,
      flat_items: flatRows,
      error: err.message,
      summary: {
        total_files: req.files.length,
        succeeded: results.filter((r) => r.success).length,
        failed: results.filter((r) => !r.success).length,
        parsed_locally: results.filter((r) => r.source === "local_pdf_parse").length,
        parsed_by_ai: results.filter((r) => r.source === "ai_fallback").length,
        total_line_items: flatRows.length,
      },
    });
  }
});

// --- Batch parse + quotation ----------------------------------------------
// Parses uploaded files, flattens the extracted items, then sends all items
// with quantity > 0 to the busyNotify mock API /api/v1/pricing/quote.
app.post("/api/parse-orders/quote", upload.array("files", 25), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: "No files uploaded. Use field name 'files'." });
  }

  const CONCURRENCY = 4;
  const results = new Array(req.files.length);
  let cursor = 0;

  async function worker() {
    while (cursor < req.files.length) {
      const index = cursor++;
      const file = req.files[index];
      try {
        const { source, data } = await parseOrder(file);
        results[index] = { filename: file.originalname, success: true, source, data };
      } catch (err) {
        results[index] = { filename: file.originalname, success: false, error: err.message };
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const successfulOrders = results
    .filter((r) => r.success)
    .map((r) => ({ filename: r.filename, source: r.source, data: r.data }));
  const flatRows = flattenOrders(successfulOrders);

  try {
    const quotation = await quoteFromParsedRows(flatRows, {
      customer_id: req.body?.customer_id ?? null,
      customer_name: req.body?.customer_name ?? null,
      quotation_date: req.body?.quotation_date ?? null,
    });

    res.json({
      results,
      flat_items: flatRows,
      quotation,
      summary: {
        total_files: req.files.length,
        succeeded: results.filter((r) => r.success).length,
        failed: results.filter((r) => !r.success).length,
        parsed_locally: results.filter((r) => r.source === "local_pdf_parse").length,
        parsed_by_ai: results.filter((r) => r.source === "ai_fallback").length,
        total_line_items: flatRows.length,
        quoted_items: quotation.checked ?? 0,
        skipped_items: quotation.skipped?.length ?? 0,
        priced_from_rate_card: quotation.summary?.priced_from_rate_card ?? 0,
        priced_from_inventory: quotation.summary?.priced_from_inventory ?? 0,
      },
    });
  } catch (err) {
    res.status(502).json({
      results,
      flat_items: flatRows,
      error: err.message,
      summary: {
        total_files: req.files.length,
        succeeded: results.filter((r) => r.success).length,
        failed: results.filter((r) => !r.success).length,
        parsed_locally: results.filter((r) => r.source === "local_pdf_parse").length,
        parsed_by_ai: results.filter((r) => r.source === "ai_fallback").length,
        total_line_items: flatRows.length,
      },
    });
  }
});

// --- Batch parse + quotation PDF ------------------------------------------
// Same as /api/parse-orders/quote, but returns a downloadable PDF quotation.
app.post("/api/parse-orders/quote/pdf", upload.array("files", 25), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: "No files uploaded. Use field name 'files'." });
  }

  const CONCURRENCY = 4;
  const results = new Array(req.files.length);
  let cursor = 0;

  async function worker() {
    while (cursor < req.files.length) {
      const index = cursor++;
      const file = req.files[index];
      try {
        const { source, data } = await parseOrder(file);
        results[index] = { filename: file.originalname, success: true, source, data };
      } catch (err) {
        results[index] = { filename: file.originalname, success: false, error: err.message };
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const successfulOrders = results
    .filter((r) => r.success)
    .map((r) => ({ filename: r.filename, source: r.source, data: r.data }));
  const flatRows = flattenOrders(successfulOrders);

  try {
    const quotation = await quoteFromParsedRows(flatRows, {
      customer_id: req.body?.customer_id ?? null,
      customer_name: req.body?.customer_name ?? null,
      quotation_date: req.body?.quotation_date ?? null,
    });

    const pdfBuffer = await buildQuotationPdfBuffer(quotation);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="quotation.pdf"');
    res.send(pdfBuffer);
  } catch (err) {
    res.status(502).json({
      results,
      flat_items: flatRows,
      error: err.message,
    });
  }
});

app.get("/", (req, res) =>
  res.json({
    status: "ok",
    message: "Order parser backend. Use /api/parse-order, /api/parse-orders/check-inventory, or /api/parse-orders/quote.",
  })
);

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.listen(PORT, () => {
  console.log(`Order parser backend listening on http://localhost:${PORT}`);
});
