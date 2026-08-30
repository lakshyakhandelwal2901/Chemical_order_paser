import { extractPdfLines, hasTextLayer } from "./pdfTextExtract.js";
import { parseItemTable } from "./tableParser.js";
import { extractHeaderMetadata } from "./headerMetadata.js";

const OCR_SPACE_ENDPOINT = "https://api.ocr.space/parse/image";
const OCR_SPACE_DEMO_KEY = "helloworld";

const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif"];

function isPdfFile(file) {
  const originalName = (file.originalname || "").toLowerCase();
  if (file.mimetype === "application/pdf" || originalName.endsWith(".pdf")) {
    return true;
  }

  const header = file.buffer?.subarray?.(0, 4)?.toString("ascii") ?? "";
  return header === "%PDF";
}
function getOcrSpaceApiKey() {
  return process.env.OCR_SPACE_API_KEY || process.env.OCRSPACE_API_KEY || OCR_SPACE_DEMO_KEY;
}

function getMimeType(file) {
  if (file.mimetype && file.mimetype !== "application/octet-stream") {
    return file.mimetype;
  }

  const name = (file.originalname || "").toLowerCase();
  if (name.endsWith(".pdf")) return "application/pdf";
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  if (name.endsWith(".webp")) return "image/webp";
  if (name.endsWith(".gif")) return "image/gif";
  return "application/pdf";
}

function buildOcrSpaceFormData(file) {
  const mimeType = getMimeType(file);
  const formData = new FormData();
  formData.append("file", new Blob([file.buffer], { type: mimeType }), file.originalname || "upload");
  formData.append("language", "auto");
  formData.append("isOverlayRequired", "true");
  formData.append("isTable", "true");
  formData.append("scale", "true");
  formData.append("detectOrientation", "true");
  formData.append("OCREngine", "3");
  if (mimeType === "application/pdf") {
    formData.append("filetype", "PDF");
  }
  return formData;
}

function normalizeOverlayLines(pageLines) {
  const result = [];
  for (const line of pageLines || []) {
    const words = Array.isArray(line?.Words) ? line.Words : [];
    const items = words
      .map((word) => ({
        text: String(word?.WordText ?? "").trim(),
        x: Number(word?.Left ?? 0),
      }))
      .filter((item) => item.text.length > 0)
      .sort((a, b) => a.x - b.x);
    if (items.length > 0) {
      result.push({ items });
    }
  }
  return result;
}

function parsedTextLineToItems(lineText) {
  const text = String(lineText ?? "").trim();
  if (!text) return [];

  if (text.includes("|")) {
    const cells = text
      .split("|")
      .map((cell) => cell.trim())
      .filter((cell) => cell.length > 0 && cell !== "---" && !/^:?-{3,}:?$/.test(cell));

    if (cells.length > 1) {
      return cells.map((cell, index) => ({ text: cell, x: index * 100 }));
    }
  }

  return [{ text, x: 0 }];
}

function ocrResultsToLines(parsedResults) {
  const lines = [];
  for (const pageResult of parsedResults || []) {
    const parsedText = String(pageResult?.ParsedText ?? "").trim();
    if (parsedText) {
      for (const rawLine of parsedText.split(/\r?\n/)) {
        const items = parsedTextLineToItems(rawLine);
        if (items.length > 0) {
          lines.push({ items });
        }
      }
      continue;
    }

    const overlayLines = normalizeOverlayLines(pageResult?.TextOverlay?.Lines);
    if (overlayLines.length > 0) {
      lines.push(...overlayLines);
    }
  }
  return lines;
}

async function withRetry(fn, { retries = 2, baseDelayMs = 1200 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const status = error?.status ?? error?.response?.status ?? error?.cause?.status;
      const retryable = status === 429 || status === 500 || status === 502 || status === 503 || status === 504 || status === 529;
      if (!retryable || attempt === retries) {
        throw error;
      }
      const delay = baseDelayMs * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

function finalizeParsedOrder(parsed, notes) {
  parsed.items = Array.isArray(parsed.items) ? parsed.items : [];
  parsed.currency = parsed.currency || "INR";
  parsed.items = parsed.items.map((item) => ({
    ...item,
    pack_size: item.pack_size ?? item.quantity_unit ?? null,
  }));
  return {
    document_type: parsed.document_type ?? "unknown",
    issuing_authority: parsed.issuing_authority ?? null,
    vendor_name: parsed.vendor_name ?? null,
    order_number: parsed.order_number ?? null,
    order_date: parsed.order_date ?? null,
    reference_number: parsed.reference_number ?? null,
    currency: parsed.currency,
    items: parsed.items,
    total_amount: parsed.total_amount ?? null,
    notes: parsed.notes ?? notes ?? null,
  };
}

async function extractOrderFromOcrSpace(file) {
  const apiKey = getOcrSpaceApiKey();
  const formData = buildOcrSpaceFormData(file);
  formData.append("apikey", apiKey);

  const response = await withRetry(() =>
    fetch(OCR_SPACE_ENDPOINT, {
      method: "POST",
      body: formData,
    })
  );

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw new Error(`OCR.space returned a non-JSON response: ${error.message}`);
  }

  const errorText = [payload?.ErrorMessage, payload?.ErrorDetails].filter(Boolean).join(" ").trim();
  if (!response.ok || payload?.IsErroredOnProcessing) {
    throw new Error(errorText || `OCR.space failed with status ${response.status}.`);
  }

  const lines = ocrResultsToLines(payload?.ParsedResults);
  const { items, confidence, headerLine } = parseItemTable(lines);
  if (items.length === 0) {
    throw new Error(errorText || "OCR.space returned text, but no item table could be detected.");
  }

  const metadata = extractHeaderMetadata(lines, headerLine);
  const notes = confidence === "high"
    ? "Parsed via OCR.space OCR fallback."
    : `Parsed via OCR.space OCR fallback with ${confidence} confidence; please review extracted rows.`;

  return finalizeParsedOrder(
    {
      document_type: "unknown",
      issuing_authority: metadata.issuing_authority,
      vendor_name: metadata.vendor_name,
      order_number: metadata.order_number,
      order_date: metadata.order_date,
      reference_number: null,
      currency: "INR",
      items,
      total_amount: null,
      notes,
    },
    notes
  );
}

/**
 * Extracts structured order data from a single uploaded file (PDF or image)
 * using OCR.space for the fallback path.
 * @param {{ buffer: Buffer, mimetype: string, originalname: string }} file
 * @returns {Promise<object>} parsed order JSON
 */
export async function extractOrderFromFile(file) {
  return extractOrderFromOcrSpace(file);
}

/**
 * Attempts a fast, free local parse of a digital PDF (real text layer, not a
 * scan): locates the item table by its header row, reconstructs columns from
 * x-positions, and reads best-effort vendor/order metadata from the text
 * above it. Returns null if the PDF has no text layer, or if the resulting
 * parse doesn't clear the confidence bar - both mean "let the AI handle it".
 *
 * @param {Buffer} buffer
 * @returns {Promise<object|null>}
 */
async function tryLocalPdfParse(buffer) {
  const hasText = await hasTextLayer(buffer);
  if (!hasText) return null; // scanned/rasterized PDF - no text to parse locally

  const lines = await extractPdfLines(buffer);
  const { items, confidence, headerLine } = parseItemTable(lines);
  if (confidence !== "high") return null; // table wasn't reliably recognized - let AI handle it

  const metadata = extractHeaderMetadata(lines, headerLine);

  return {
    document_type: "unknown",
    issuing_authority: metadata.issuing_authority,
    vendor_name: metadata.vendor_name,
    order_number: metadata.order_number,
    order_date: metadata.order_date,
    reference_number: null,
    currency: "INR",
    items: items.map((item) => ({
      ...item,
      pack_size: item.pack_size ?? item.quantity_unit ?? null,
    })),
    total_amount: null,
    notes: "Parsed locally from the PDF's text layer (no AI call). Some fields the AI would infer (document_type, reference_number, total_amount) are left null.",
  };
}

/**
 * Parses one uploaded file into the standard order schema, trying the fast
 * local PDF table parser first and only calling OCR.space when that isn't
 * possible or isn't confident enough. Images go straight to OCR.space, since
 * there's no text layer to parse locally.
 *
 * @param {{ buffer: Buffer, mimetype: string, originalname: string }} file
 * @returns {Promise<{ source: "local_pdf_parse"|"ocr_space", data: object }>}
 */
export async function parseOrder(file) {
  if (isPdfFile(file)) {
    try {
      const local = await tryLocalPdfParse(file.buffer);
      if (local) return { source: "local_pdf_parse", data: local };
    } catch (err) {
      // local parsing is best-effort - any failure just falls through to AI
      console.warn(`Local PDF parse failed for ${file.originalname}, falling back to OCR.space:`, err.message);
    }
  }

  const data = await extractOrderFromOcrSpace(file);
  return { source: "ocr_space", data };
}
