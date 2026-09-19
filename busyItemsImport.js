import XLSX from "xlsx";

// ponytail: built directly against a real Busy ("List of Items") export -
// Name / Alias / Group Name / MRP / Main Unit / Sale Price / Batch By Batch
// columns, with a title row above the real header. Unlike vendor price
// lists, brand (Group Name) is already a per-row column here, not something
// supplied separately per upload - Busy's own export already tracks it per
// item, so it's read straight from the row.
const NAME_PATTERN = /^name$/i;
const ALIAS_PATTERN = /^alias$/i;
const BRAND_PATTERN = /group\s*name|brand/i;
const SALE_PRICE_PATTERN = /sale\s*price/i;

const HEADER_SEARCH_ROWS = 10;

function cellText(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function findHeaderRowIndex(rows) {
  for (let i = 0; i < Math.min(rows.length, HEADER_SEARCH_ROWS); i++) {
    const row = rows[i] ?? [];
    const hasName = row.some((cell) => NAME_PATTERN.test(cellText(cell)));
    const hasBrand = row.some((cell) => BRAND_PATTERN.test(cellText(cell)));
    if (hasName && hasBrand) return i;
  }
  return -1;
}

function detectColumns(rows, headerRowIndex) {
  const header = rows[headerRowIndex] ?? [];
  const columns = { name: -1, alias: -1, brand: -1, purchasePrice: -1 };
  header.forEach((cell, i) => {
    const text = cellText(cell);
    if (columns.name === -1 && NAME_PATTERN.test(text)) columns.name = i;
    if (columns.alias === -1 && ALIAS_PATTERN.test(text)) columns.alias = i;
    if (columns.brand === -1 && BRAND_PATTERN.test(text)) columns.brand = i;
    if (columns.purchasePrice === -1 && SALE_PRICE_PATTERN.test(text)) columns.purchasePrice = i;
  });
  return columns;
}

function parsePrice(raw) {
  if (typeof raw === "number") return raw;
  const num = Number(String(raw ?? "").replace(/[,\s]/g, ""));
  return Number.isFinite(num) ? num : null;
}

// Returns { rows: [{ name, alias, brand, purchasePrice }], rowsSeen, rowsSkipped, columns }
export function parseBusyItemsWorkbook(buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheetName = workbook.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, blankrows: false, defval: null });

  const headerRowIndex = findHeaderRowIndex(rows);
  if (headerRowIndex === -1) return { rows: [], rowsSeen: 0, rowsSkipped: 0, columns: null };

  const columns = detectColumns(rows, headerRowIndex);
  if (columns.name === -1 || columns.brand === -1) {
    return { rows: [], rowsSeen: 0, rowsSkipped: 0, columns };
  }

  const parsedRows = [];
  let rowsSkipped = 0;
  for (const row of rows.slice(headerRowIndex + 1)) {
    const name = cellText(row?.[columns.name]);
    const brand = cellText(row?.[columns.brand]);
    if (!name || !brand) {
      rowsSkipped++;
      continue;
    }
    const aliasText = columns.alias === -1 ? "" : cellText(row?.[columns.alias]);
    // ponytail: a Sale Price of exactly 0 means "not entered" in this real
    // data (verified - roughly half the real 165-row file has it at 0 while
    // MRP is set instead), not a genuine zero cost. Treated as no price.
    const rawPrice = columns.purchasePrice === -1 ? null : parsePrice(row?.[columns.purchasePrice]);
    const purchasePrice = rawPrice === 0 ? null : rawPrice;
    parsedRows.push({ name, alias: aliasText || null, brand, purchasePrice });
  }

  return { rows: parsedRows, rowsSeen: rows.length - headerRowIndex - 1, rowsSkipped, columns };
}
