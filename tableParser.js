// Heuristic table parser: given a digital PDF's text lines (from pdfTextExtract),
// finds the item table by locating its header row, works out column boundaries
// from the header's x-positions, then reads each row - including item names
// that wrap onto a second line, which is extremely common in these documents.

const CATEGORY_PATTERNS = {
  // checked in this priority order per header cell - first match wins
  amount: [/amount/i, /\bvalue\b/i, /^total$/i],
  rate: [/rate/i, /price/i, /per\s*unit/i, /दर/],
  quantity: [/qty/i, /quantity/i, /मात्रा/, /मांग/],
  quantity_unit: [/uom/i, /\bunit\b/i],
  item_name: [/item/i, /particular/i, /specification/i, /description/i, /name/i, /सामग्री/, /वस्तु/],
  specification: [/pack/i, /\bspec/i, /grade/i, /make/i],
};

const IGNORED_HEADER_PATTERNS = [
  /^s\.?\s*no\.?$/i,
  /^sr\.?\s*no\.?$/i,
  /^code$/i,
  /disc/i,
  /gst/i,
  /\btax\b/i,
  /क्र\.?\s*स/,
  /क्रम/,
];

const FOOTER_MARKERS =
  /taxable amount|total amount|discount amount|gst amount|remarks\s*:|terms\s*&?\s*condition|prepared by|inr\s*:|total value|grand total/i;

function classifyHeaderCell(text) {
  const t = text.trim();
  if (IGNORED_HEADER_PATTERNS.some((r) => r.test(t))) return null;
  for (const [category, patterns] of Object.entries(CATEGORY_PATTERNS)) {
    if (patterns.some((r) => r.test(t))) return category;
  }
  return null;
}

function parseNumber(text) {
  if (!text) return { number: null, rest: (text || "").trim() };
  const cleaned = text.replace(/,/g, "");
  const match = cleaned.match(/-?\d+(\.\d+)?/);
  if (!match) return { number: null, rest: text.trim() };
  const number = parseFloat(match[0]);
  const rest = (cleaned.slice(0, match.index) + cleaned.slice(match.index + match[0].length)).trim();
  return { number, rest };
}

/** Finds the line most likely to be the item table's header row. */
function findHeaderLine(lines) {
  let best = null;
  let bestScore = -1;

  for (const line of lines) {
    const categories = new Set(line.items.map((i) => classifyHeaderCell(i.text)).filter(Boolean));
    if (!categories.has("item_name")) continue;
    const hasNumericColumn = ["quantity", "rate", "amount"].some((c) => categories.has(c));
    if (!hasNumericColumn) continue;

    const score = categories.size;
    if (score > bestScore) {
      bestScore = score;
      best = line;
    }
  }
  return best;
}

/**
 * Builds column boundaries from the header line. Includes ignored/unmapped
 * header cells too (with field: null) so their x-range still "claims" that
 * space - otherwise data under an ignored column (e.g. Disc%, GST%) would
 * leak into the nearest mapped neighbor instead of being discarded.
 */
function buildColumnMap(headerLine) {
  const all = headerLine.items
    .map((i) => ({ x: i.x, field: classifyHeaderCell(i.text) }))
    .sort((a, b) => a.x - b.x);

  return all.map((col, idx) => {
    const prev = all[idx - 1];
    const next = all[idx + 1];
    return {
      ...col,
      left: prev ? (prev.x + col.x) / 2 : -Infinity,
      right: next ? (col.x + next.x) / 2 : Infinity,
    };
  });
}

function assignColumn(x, cols) {
  const hit = cols.find((c) => x >= c.left && x < c.right);
  return hit && hit.field ? hit : null;
}

function applyToRow(row, field, text) {
  switch (field) {
    case "item_name":
    case "specification":
      row[field] = (row[field] + " " + text).trim();
      break;
    case "quantity": {
      const { number } = parseNumber(text);
      if (number !== null) row.quantity = number;
      break;
    }
    case "quantity_unit":
      row.quantity_unit = text;
      break;
    case "rate": {
      const { number, rest } = parseNumber(text);
      if (number !== null) row.unit_rate = number;
      if (rest) row.specification = (row.specification + " " + rest).trim();
      break;
    }
    case "amount": {
      const { number } = parseNumber(text);
      if (number !== null) row.amount = number;
      break;
    }
  }
}

function emptyRow() {
  return { item_name: "", specification: "", quantity: null, quantity_unit: null, unit_rate: null, amount: null };
}

/**
 * Parses table rows starting after the header line, stopping at the first
 * footer marker (totals/remarks/terms/signature block). Handles item names
 * that wrap onto a following line (no leading serial number) by merging
 * them into the current row instead of starting a new one.
 */
function parseRows(lines, headerLine, cols) {
  const headerIdx = lines.indexOf(headerLine);
  const rows = [];
  let expectedSerial = 1;
  let currentRow = null;

  for (let idx = headerIdx + 1; idx < lines.length; idx++) {
    const line = lines[idx];
    const lineText = line.items.map((i) => i.text).join(" ");
    if (FOOTER_MARKERS.test(lineText)) break;

    const firstText = (line.items[0]?.text ?? "").trim();
    const isRowStart = new RegExp(`^${expectedSerial}\\.?$`).test(firstText);

    if (isRowStart) {
      if (currentRow) rows.push(currentRow);
      currentRow = emptyRow();
      expectedSerial += 1;
      for (const item of line.items) {
        const col = assignColumn(item.x, cols);
        if (col) applyToRow(currentRow, col.field, item.text);
      }
    } else if (currentRow) {
      // wrapped continuation of the previous row - only text fields extend
      for (const item of line.items) {
        const col = assignColumn(item.x, cols);
        if (col && (col.field === "item_name" || col.field === "specification")) {
          currentRow[col.field] = (currentRow[col.field] + " " + item.text).trim();
        }
      }
    }
    // if no row has started yet and this line isn't a row start, skip it
  }
  if (currentRow) rows.push(currentRow);
  return rows;
}

/** Rates the reliability of a local parse so callers know whether to trust it or fall back to AI. */
function scoreConfidence(rows) {
  if (rows.length === 0) return "none";
  const withName = rows.filter((r) => r.item_name && r.item_name.length > 1).length;
  const withNumeric = rows.filter((r) => r.quantity !== null || r.unit_rate !== null || r.amount !== null).length;
  const nameRatio = withName / rows.length;
  const numericRatio = withNumeric / rows.length;

  if (rows.length >= 1 && nameRatio >= 0.8 && numericRatio >= 0.6) return "high";
  if (rows.length >= 1 && nameRatio >= 0.5) return "medium";
  return "low";
}

/**
 * Full local table parse of a digital PDF's extracted lines.
 * @param {Array} lines - output of extractPdfLines()
 * @returns {{ items: object[], confidence: "high"|"medium"|"low"|"none" }}
 */
export function parseItemTable(lines) {
  const headerLine = findHeaderLine(lines);
  if (!headerLine) return { items: [], confidence: "none", headerLine: null };

  const cols = buildColumnMap(headerLine);
  const rows = parseRows(lines, headerLine, cols);
  const confidence = scoreConfidence(rows);

  return { items: rows, confidence, headerLine };
}
