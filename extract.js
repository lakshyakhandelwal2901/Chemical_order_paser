import mammoth from "mammoth";
import JSZip from "jszip";
import * as XLSX from "xlsx";
import { extractPdfLines, hasTextLayer } from "./pdfTextExtract.js";
import { parseItemTable } from "./tableParser.js";
import { extractHeaderMetadata } from "./headerMetadata.js";

const AZURE_DOCUMENT_INTELLIGENCE_API_VERSION = "2024-11-30";
const AZURE_DOCUMENT_INTELLIGENCE_MODEL_ID = "prebuilt-layout";

const OCR_SPACE_ENDPOINT = "https://api.ocr.space/parse/image";
const OCR_SPACE_DEMO_KEY = "helloworld";

const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif"];

const LOCAL_DOC_EXTENSIONS = new Set([".docx", ".xlsx", ".xls", ".csv", ".txt", ".tsv"]);

function getFileExtension(file) {
  const originalName = (file.originalname || "").toLowerCase();
  const match = originalName.match(/\.[^.]+$/);
  return match ? match[0] : "";
}

function isWordFile(file) {
  const extension = getFileExtension(file);
  return extension === ".docx" || file.mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
}

function isSpreadsheetFile(file) {
  const extension = getFileExtension(file);
  return (
    extension === ".xlsx" ||
    extension === ".xls" ||
    extension === ".csv" ||
    extension === ".tsv" ||
    file.mimetype === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    file.mimetype === "application/vnd.ms-excel" ||
    file.mimetype === "text/csv" ||
    file.mimetype === "text/tab-separated-values"
  );
}

function isTextFile(file) {
  const extension = getFileExtension(file);
  return extension === ".txt" || extension === ".csv" || extension === ".tsv" || file.mimetype === "text/plain";
}

function isLocalDocumentFile(file) {
  const extension = getFileExtension(file);
  return LOCAL_DOC_EXTENSIONS.has(extension) || isWordFile(file) || isSpreadsheetFile(file) || isTextFile(file);
}

function isPdfFile(file) {
  const originalName = (file.originalname || "").toLowerCase();
  if (file.mimetype === "application/pdf" || originalName.endsWith(".pdf")) {
    return true;
  }

  const header = file.buffer?.subarray?.(0, 4)?.toString("ascii") ?? "";
  return header === "%PDF";
}

function getAzureDocumentIntelligenceEndpoint() {
  const endpoint = process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT || process.env.DI_ENDPOINT || "";
  return endpoint.trim();
}

function getAzureDocumentIntelligenceKey() {
  const key = process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY || process.env.DI_KEY || "";
  return key.trim();
}

function hasAzureDocumentIntelligenceConfig() {
  return Boolean(getAzureDocumentIntelligenceEndpoint() && getAzureDocumentIntelligenceKey());
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

function normalizeAzureEndpoint(endpoint) {
  return String(endpoint || "").replace(/\/+$/, "");
}

function azurePagesToLines(pages) {
  const lines = [];
  for (const page of pages || []) {
    for (const line of page?.lines || []) {
      const words = Array.isArray(line?.words) ? line.words : [];
      const items = words
        .map((word) => ({
          text: String(word?.content ?? "").trim(),
          x: Array.isArray(word?.polygon) && word.polygon.length > 0 ? Number(word.polygon[0] ?? 0) : 0,
        }))
        .filter((item) => item.text.length > 0)
        .sort((a, b) => a.x - b.x);

      if (items.length > 0) {
        lines.push({ items });
        continue;
      }

      const content = String(line?.content ?? "").trim();
      if (content) {
        lines.push({ items: [{ text: content, x: 0 }] });
      }
    }
  }

  return lines;
}

function azureTablesToLines(tables) {
  const rowsByTable = [];

  for (const table of tables || []) {
    const rows = new Map();

    for (const cell of table?.cells || []) {
      const rowIndex = Number(cell?.rowIndex ?? 0);
      const columnIndex = Number(cell?.columnIndex ?? 0);
      const text = String(cell?.content ?? "").trim();
      if (!text) continue;

      if (!rows.has(rowIndex)) {
        rows.set(rowIndex, []);
      }

      rows.get(rowIndex).push({ text, x: columnIndex * 100 });
    }

    const orderedRows = Array.from(rows.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([, items]) => ({ items: items.sort((a, b) => a.x - b.x) }))
      .filter((row) => row.items.length > 0);

    rowsByTable.push(...orderedRows);
  }

  return rowsByTable;
}

function normalizeOverlayLines(pageLines) {
  const fragments = [];
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
      fragments.push({
        top: Number(line?.MinTop ?? items[0].x ?? 0),
        items,
      });
    }
  }

  fragments.sort((a, b) => a.top - b.top || a.items[0].x - b.items[0].x);

  const grouped = [];
  const rowThreshold = 25;

  for (const fragment of fragments) {
    const lastRow = grouped[grouped.length - 1];
    if (lastRow && Math.abs(fragment.top - lastRow.top) <= rowThreshold) {
      lastRow.items.push(...fragment.items);
      lastRow.top = Math.min(lastRow.top, fragment.top);
      continue;
    }

    grouped.push({
      top: fragment.top,
      items: [...fragment.items],
    });
  }

  return grouped
    .map((row) => ({ items: row.items.sort((a, b) => a.x - b.x) }))
    .filter((line) => line.items.length > 0);
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

function documentTextLineToItems(lineText) {
  const text = String(lineText ?? "").trim();
  if (!text) return [];

  if (text.includes("|") || text.includes("\t")) {
    const separator = text.includes("|") ? "|" : "\t";
    const cells = text
      .split(separator)
      .map((cell) => cell.trim())
      .filter((cell) => cell.length > 0 && cell !== "---" && !/^:?-{3,}:?$/.test(cell));

    if (cells.length > 1) {
      return cells.map((cell, index) => ({ text: cell, x: index * 100 }));
    }
  }

  if (/\s{2,}/.test(text)) {
    const cells = text
      .split(/\s{2,}/)
      .map((cell) => cell.trim())
      .filter((cell) => cell.length > 0);

    if (cells.length > 1 && /\d|item|qty|quantity|rate|price|amount|unit|make|product|name/i.test(text)) {
      return cells.map((cell, index) => ({ text: cell, x: index * 100 }));
    }
  }

  return [{ text, x: 0 }];
}

function linesFromText(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => documentTextLineToItems(line))
    .filter((line) => line.length > 0)
    .map((items) => ({ items }));
}

function linesFromRows(rows) {
  return rows
    .map((row) => {
      const items = [];
      for (let index = 0; index < row.length; index += 1) {
        const cell = row[index];
        const text = String(cell ?? "").replace(/\s+/g, " ").trim();
        if (text) {
          items.push({ text, x: index * 100 });
        }
      }
      return { items };
    })
    .filter((line) => line.items.length > 0);
}

async function extractDocxLines(file) {
  const result = await mammoth.extractRawText({ buffer: file.buffer });
  return linesFromText(result.value);
}

function guessImageMimeType(fileName) {
  const lowerName = String(fileName ?? "").toLowerCase();
  if (lowerName.endsWith(".png")) return "image/png";
  if (lowerName.endsWith(".jpg") || lowerName.endsWith(".jpeg")) return "image/jpeg";
  if (lowerName.endsWith(".webp")) return "image/webp";
  if (lowerName.endsWith(".gif")) return "image/gif";
  return null;
}

async function extractDocxImageFallback(file) {
  const archive = await JSZip.loadAsync(file.buffer);
  const imageEntries = Object.values(archive.files)
    .filter((entry) => !entry.dir && /^word\/media\//i.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  let lastError = null;
  for (const entry of imageEntries) {
    const imageMimeType = guessImageMimeType(entry.name);
    if (!imageMimeType) continue;

    const imageBuffer = await entry.async("nodebuffer");
    try {
      const embeddedFile = {
        buffer: imageBuffer,
        mimetype: imageMimeType,
        originalname: entry.name.split("/").pop() || file.originalname || "embedded-image",
      };

      if (hasAzureDocumentIntelligenceConfig()) {
        return await extractOrderFromAzureDocumentIntelligence(embeddedFile);
      }

      return await extractOrderFromOcrSpace(embeddedFile);
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) {
    throw lastError;
  }

  throw new Error(`No extractable text or embedded images were found in ${file.originalname}.`);
}

function readWorkbookFromFile(file) {
  const extension = getFileExtension(file);
  if (extension === ".csv" || extension === ".tsv" || isTextFile(file)) {
    return XLSX.read(file.buffer.toString("utf8"), { type: "string" });
  }

  return XLSX.read(file.buffer, { type: "buffer" });
}

function scoreParseResult(candidate, existing) {
  const rank = { high: 3, medium: 2, low: 1, none: 0 };
  const currentRank = rank[candidate.confidence] ?? 0;
  const existingRank = rank[existing.confidence] ?? 0;

  if (currentRank !== existingRank) {
    return currentRank > existingRank;
  }

  return candidate.items.length > existing.items.length;
}

async function tryLocalDocumentParse(file) {
  if (isWordFile(file)) {
    const lines = await extractDocxLines(file);
    const { items, confidence, headerLine } = parseItemTable(lines);
    if (items.length === 0) {
      return extractDocxImageFallback(file);
    }

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
      notes:
        confidence === "high"
          ? "Parsed locally from DOCX text with no OCR call."
          : "Parsed locally from DOCX text. Please review rows with lower confidence.",
    };
  }

  if (isSpreadsheetFile(file)) {
    const workbook = readWorkbookFromFile(file);
    let bestResult = null;

    for (const sheetName of workbook.SheetNames || []) {
      const sheet = workbook.Sheets[sheetName];
      if (!sheet) continue;

      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: "" });
      const lines = linesFromRows(rows);
      const { items, confidence, headerLine } = parseItemTable(lines);
      if (items.length === 0) continue;

      const candidate = { items, confidence, headerLine, lines, sheetName };
      if (!bestResult || scoreParseResult(candidate, bestResult)) {
        bestResult = candidate;
      }
    }

    if (!bestResult) {
      throw new Error(`No item table could be detected in ${file.originalname}.`);
    }

    const metadata = extractHeaderMetadata(bestResult.lines, bestResult.headerLine);
    return {
      document_type: "unknown",
      issuing_authority: metadata.issuing_authority,
      vendor_name: metadata.vendor_name,
      order_number: metadata.order_number,
      order_date: metadata.order_date,
      reference_number: null,
      currency: "INR",
      items: bestResult.items.map((item) => ({
        ...item,
        pack_size: item.pack_size ?? item.quantity_unit ?? null,
      })),
      total_amount: null,
      notes:
        bestResult.confidence === "high"
          ? `Parsed locally from spreadsheet sheet ${bestResult.sheetName} with no OCR call.`
          : `Parsed locally from spreadsheet sheet ${bestResult.sheetName}. Please review rows with lower confidence.`,
    };
  }

  if (isTextFile(file)) {
    const lines = linesFromText(file.buffer.toString("utf8"));
    const { items, confidence, headerLine } = parseItemTable(lines);
    if (items.length === 0) {
      throw new Error(`No item table could be detected in ${file.originalname}.`);
    }

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
      notes:
        confidence === "high"
          ? "Parsed locally from plain text with no OCR call."
          : "Parsed locally from plain text. Please review rows with lower confidence.",
    };
  }

  return null;
}

function ocrResultsToLines(parsedResults) {
  const lines = [];
  for (const pageResult of parsedResults || []) {
    const overlayLines = normalizeOverlayLines(pageResult?.TextOverlay?.Lines);
    if (overlayLines.length > 0) {
      lines.push(...overlayLines);
      continue;
    }

    const parsedText = String(pageResult?.ParsedText ?? "").trim();
    if (parsedText) {
      for (const rawLine of parsedText.split(/\r?\n/)) {
        const items = parsedTextLineToItems(rawLine);
        if (items.length > 0) {
          lines.push({ items });
        }
      }
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollAzureDocumentIntelligence(operationUrl) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await fetch(operationUrl, {
      headers: {
        "Ocp-Apim-Subscription-Key": getAzureDocumentIntelligenceKey(),
      },
    });

    if (!response.ok) {
      const message = await response.text().catch(() => "");
      throw new Error(`Azure Document Intelligence poll failed with status ${response.status}. ${message}`.trim());
    }

    const payload = await response.json();
    const status = String(payload?.status ?? "").toLowerCase();
    if (status === "succeeded") {
      return payload;
    }

    if (status === "failed") {
      throw new Error(payload?.error?.message || "Azure Document Intelligence failed to process the document.");
    }

    await sleep(1000);
  }

  throw new Error("Azure Document Intelligence did not complete within the polling window.");
}

async function extractOrderFromAzureDocumentIntelligence(file) {
  const endpoint = normalizeAzureEndpoint(getAzureDocumentIntelligenceEndpoint());
  const analyzeUrl = `${endpoint}/documentintelligence/documentModels/${AZURE_DOCUMENT_INTELLIGENCE_MODEL_ID}:analyze?api-version=${AZURE_DOCUMENT_INTELLIGENCE_API_VERSION}`;

  const response = await fetch(analyzeUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "Ocp-Apim-Subscription-Key": getAzureDocumentIntelligenceKey(),
    },
    body: file.buffer,
  });

  if (response.status !== 202) {
    const message = await response.text().catch(() => "");
    throw new Error(`Azure Document Intelligence analyze failed with status ${response.status}. ${message}`.trim());
  }

  const operationLocation = response.headers.get("operation-location") || response.headers.get("Operation-Location");
  if (!operationLocation) {
    throw new Error("Azure Document Intelligence did not return an operation-location header.");
  }

  const payload = await pollAzureDocumentIntelligence(operationLocation);
  const analyzeResult = payload?.analyzeResult || {};
  const tables = analyzeResult?.tables || [];
  const pages = analyzeResult?.pages || [];
  const lines = tables.length > 0 ? azureTablesToLines(tables) : azurePagesToLines(pages);
  const { items, confidence, headerLine } = parseItemTable(lines);
  if (items.length === 0) {
    throw new Error("Azure Document Intelligence returned text, but no item table could be detected.");
  }

  const metadata = extractHeaderMetadata(lines, headerLine);
  const notes = confidence === "high"
    ? "Parsed via Azure Document Intelligence OCR fallback."
    : `Parsed via Azure Document Intelligence OCR fallback with ${confidence} confidence; please review extracted rows.`;

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
 * using Azure Document Intelligence for the fallback path.
 * @param {{ buffer: Buffer, mimetype: string, originalname: string }} file
 * @returns {Promise<object>} parsed order JSON
 */
export async function extractOrderFromFile(file) {
  if (hasAzureDocumentIntelligenceConfig()) {
    return extractOrderFromAzureDocumentIntelligence(file);
  }

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
 * local parser first for PDFs, DOCX files, spreadsheets and plain text, and
 * only calling OCR.space when the file is a PDF/image that needs OCR. Images
 * and scanned PDFs go straight to OCR.space, since there's no text layer to
 * parse locally.
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

  if (isLocalDocumentFile(file)) {
    const local = await tryLocalDocumentParse(file);
    if (local) return { source: "local_pdf_parse", data: local };
  }

  if (hasAzureDocumentIntelligenceConfig()) {
    const data = await extractOrderFromAzureDocumentIntelligence(file);
    return { source: "azure_document_intelligence", data };
  }

  const data = await extractOrderFromOcrSpace(file);
  return { source: "ocr_space", data };
}
