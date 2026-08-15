import { GoogleGenAI } from "@google/genai";
import { extractPdfLines, hasTextLayer } from "./pdfTextExtract.js";
import { parseItemTable } from "./tableParser.js";
import { extractHeaderMetadata } from "./headerMetadata.js";

const MODEL = process.env.GEMINI_MODEL || "gemini-3.7-flash";

const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif"];

// The schema every document gets normalized into, regardless of how the
// source table is laid out (English, Hindi, mixed, handwritten, typed).
const EXTRACTION_SYSTEM_PROMPT = `You are a data-extraction engine for Indian hospital / government
procurement documents: purchase orders, supply orders, indents, rate contracts, and requisitions.
These documents vary widely in layout and are frequently a mix of Hindi and English, sometimes
handwritten.

Extract the information into exactly this JSON schema. Do not add commentary, do not wrap the
JSON in markdown code fences, output ONLY the JSON object.

{
  "document_type": string,          // one of: "purchase_order", "supply_order", "rate_contract", "indent", "unknown"
  "issuing_authority": string|null, // hospital / office / department that issued the order
  "vendor_name": string|null,
  "order_number": string|null,      // PO no. / क्रमांक / भण्डार-क्रयादेश no., as printed
  "order_date": string|null,        // ISO YYYY-MM-DD if you can determine it confidently, else the raw text as printed
  "reference_number": string|null,  // tender/NIT/indent/rate-contract reference cited in the doc, if any
  "currency": string,               // default "INR" unless stated otherwise
  "items": [
    {
      "item_name": string,         // English name. If the source is Hindi/handwritten, translate/transliterate to a clear English name
      "specification": string|null,// pack size, grade, make/brand, concentration etc., as printed
      "quantity": number|null,
      "quantity_unit": string|null,// e.g. "Ltr", "GM", "ML", "Nos", "Vial", "Kan" (can) - keep the unit as printed/implied
      "unit_rate": number|null,    // price per unit, plain number, no currency symbol or commas
      "amount": number|null        // line total if given, plain number
    }
  ],
  "total_amount": number|null,
  "notes": string|null             // flag anything ambiguous, illegible, or uncertain for human review
}

Rules:
- Never fabricate a number. If a field can't be determined, use null.
- Strip currency symbols and thousands separators from all numeric fields.
- Some documents (e.g. requisitions/indents) list only item + quantity with no price - that's normal, leave unit_rate/amount null rather than guessing.
- If handwriting is ambiguous, give your best reading and say so in "notes".
- Every row in the source item table becomes one entry in "items", in the same order as printed.
- Ignore signature blocks, letterhead boilerplate, and distribution/copy-to lists - only extract the item table and the header metadata described above.`;

const EXTRACTION_RESPONSE_FORMAT = [
  {
    type: "text",
    mime_type: "application/json",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        document_type: { type: "string" },
        issuing_authority: { anyOf: [{ type: "string" }, { type: "null" }] },
        vendor_name: { anyOf: [{ type: "string" }, { type: "null" }] },
        order_number: { anyOf: [{ type: "string" }, { type: "null" }] },
        order_date: { anyOf: [{ type: "string" }, { type: "null" }] },
        reference_number: { anyOf: [{ type: "string" }, { type: "null" }] },
        currency: { type: "string" },
        items: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              item_name: { type: "string" },
              specification: { anyOf: [{ type: "string" }, { type: "null" }] },
              quantity: { anyOf: [{ type: "number" }, { type: "null" }] },
              quantity_unit: { anyOf: [{ type: "string" }, { type: "null" }] },
              pack_size: { anyOf: [{ type: "string" }, { type: "null" }] },
              unit_rate: { anyOf: [{ type: "number" }, { type: "null" }] },
              amount: { anyOf: [{ type: "number" }, { type: "null" }] },
            },
            required: [
              "item_name",
              "specification",
              "quantity",
              "quantity_unit",
              "pack_size",
              "unit_rate",
              "amount",
            ],
          },
        },
        total_amount: { anyOf: [{ type: "number" }, { type: "null" }] },
        notes: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
      required: [
        "document_type",
        "issuing_authority",
        "vendor_name",
        "order_number",
        "order_date",
        "reference_number",
        "currency",
        "items",
        "total_amount",
        "notes",
      ],
    },
  },
];

/**
 * Builds a Gemini document/image input part.
 * Gemini accepts PDF and image bytes directly, so we keep the
 * local parser path separate and only use this for AI fallback.
 * @param {{ buffer: Buffer, mimetype: string, originalname: string }} file
 */
function buildContentBlock(file) {
  const base64 = file.buffer.toString("base64");

  if (file.mimetype === "application/pdf") {
    return { type: "document", data: base64, mime_type: "application/pdf" };
  }

  if (ALLOWED_IMAGE_TYPES.includes(file.mimetype)) {
    return { type: "image", data: base64, mime_type: file.mimetype };
  }

  throw new Error(
    `Unsupported file type "${file.mimetype}" for ${file.originalname}. Only PDF and image files (jpg/png/webp/gif) are supported.`
  );
}

function stripCodeFences(text) {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

async function withRetry(fn, { retries = 3, baseDelayMs = 1000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = err?.status;
      const retryable = status === 429 || status === 500 || status === 529;
      if (!retryable || attempt === retries) throw err;
      const delay = baseDelayMs * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastErr;
}

/**
 * Extracts structured order data from a single uploaded file (PDF or image).
 * @param {{ buffer: Buffer, mimetype: string, originalname: string }} file
 * @returns {Promise<object>} parsed order JSON per EXTRACTION_SYSTEM_PROMPT schema
 */
export async function extractOrderFromFile(file) {
  const contentBlock = buildContentBlock(file);

  const userPrompt = "Extract this document's order details as JSON per your schema. Output ONLY the JSON object.";

  // Instantiate the Gemini client lazily so this module can be imported
  // without an API key when only local parsing is used.
  if (!process.env.GOOGLE_API_KEY) {
    throw new Error("GOOGLE_API_KEY is required for AI fallback. Set it in your .env or environment.");
  }
  const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });

  const interaction = await withRetry(() =>
    ai.interactions.create({
      model: MODEL,
      system_instruction: EXTRACTION_SYSTEM_PROMPT,
      input: [contentBlock, { type: "text", text: userPrompt }],
      response_format: EXTRACTION_RESPONSE_FORMAT,
    })
  );

  const text = interaction?.output_text || null;
  if (!text) throw new Error("Model returned no text content.");

  const cleaned = stripCodeFences(text);

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(
      `Model output was not valid JSON (${err.message}). Raw output: ${cleaned.slice(0, 500)}`
    );
  }

  // Defensive defaults so downstream code never has to null-check every field.
  parsed.items = Array.isArray(parsed.items) ? parsed.items : [];
  parsed.currency = parsed.currency || "INR";
  parsed.items = parsed.items.map((item) => ({
    ...item,
    pack_size: item.pack_size ?? item.quantity_unit ?? null,
  }));

  return parsed;
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
 * local PDF table parser first and only calling Gemini when that isn't
 * possible or isn't confident enough. Images always go straight to AI, since
 * there's no text layer to parse locally (and these forms are often
 * handwritten Hindi, where OCR alone wouldn't be reliable either).
 *
 * @param {{ buffer: Buffer, mimetype: string, originalname: string }} file
 * @returns {Promise<{ source: "local_pdf_parse"|"ai_fallback", data: object }>}
 */
export async function parseOrder(file) {
  if (file.mimetype === "application/pdf") {
    try {
      const local = await tryLocalPdfParse(file.buffer);
      if (local) return { source: "local_pdf_parse", data: local };
    } catch (err) {
      // local parsing is best-effort - any failure just falls through to AI
      console.warn(`Local PDF parse failed for ${file.originalname}, falling back to AI:`, err.message);
    }
  }

  const data = await extractOrderFromFile(file);
  return { source: "ai_fallback", data };
}
