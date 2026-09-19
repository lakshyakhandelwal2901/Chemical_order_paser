import XLSX from "xlsx";

// ponytail: built directly against 4 real vendor price lists (Borosil's two
// sheets, Whatman/Cytiva, HiMedia), not a guessed template. None of them had
// a Brand column - brand is whichever vendor's file you're uploading, passed
// in separately - and no two of them used the same column names:
//   code:  "Cat. Code" / "Cat No" / "Part Code" / "Cat No." / "Code"
//   name:  "Description" / "Product Description" / "Name"
//   price: "Borosil Price 26-27" / "LP FY26-27" / "2026 INR LP" / "Rate"
// Forcing a fixed template would reject every one of these real files.
const CODE_PATTERN = /\bcode\b|cat\.?\s*no|part\s*no|part\s*code/i;
const NAME_PATTERN = /description|\bname\b/i;
const PRICE_PATTERN = /price|rate|\blp\b|\bmrp\b/i;
// ponytail: best-effort - only Borosil's "Capacity" column among the 4 real
// files tested actually had a clean pack-size column; Whatman/HiMedia don't,
// and that's fine, it just stays null for those rows.
const PACK_SIZE_PATTERN = /pack\s*size|capacity/i;

const HEADER_SEARCH_ROWS = 15;

function cellText(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

// Some vendors title/blank-line their sheets before the real header (HiMedia
// has 3 blank/title rows first) - scan for the first row that plausibly
// looks like a header rather than assuming row 0.
function findHeaderRowIndex(rows) {
  for (let i = 0; i < Math.min(rows.length, HEADER_SEARCH_ROWS); i++) {
    const row = rows[i] ?? [];
    const hasCode = row.some((cell) => CODE_PATTERN.test(cellText(cell)));
    const hasName = row.some((cell) => NAME_PATTERN.test(cellText(cell)));
    const hasPrice = row.some((cell) => PRICE_PATTERN.test(cellText(cell)));
    if ([hasCode, hasName, hasPrice].filter(Boolean).length >= 2) return i;
  }
  return -1;
}

// A sheet can have more than one column matching a pattern (Borosil has both
// "Cat. Code" and the coarser "Cat No"; HiMedia literally has two columns
// both named "Code"). The real per-row identifier is the more granular one,
// which shows up as having more distinct values relative to how many rows
// have something in it at all - so prefer the highest uniqueness ratio.
function pickBestColumn(rows, headerRowIndex, candidateIndexes) {
  if (candidateIndexes.length <= 1) return candidateIndexes[0] ?? -1;

  let best = candidateIndexes[0];
  let bestRatio = -1;
  for (const colIndex of candidateIndexes) {
    const values = rows.slice(headerRowIndex + 1).map((row) => cellText(row?.[colIndex]));
    const nonEmpty = values.filter((v) => v !== "");
    if (nonEmpty.length === 0) continue;
    const ratio = new Set(nonEmpty).size / nonEmpty.length;
    if (ratio > bestRatio) {
      bestRatio = ratio;
      best = colIndex;
    }
  }
  return best;
}

function detectColumns(rows, headerRowIndex) {
  const header = rows[headerRowIndex] ?? [];
  const codeIndexes = [];
  const nameIndexes = [];
  const priceIndexes = [];
  const packSizeIndexes = [];

  header.forEach((cell, i) => {
    const text = cellText(cell);
    if (CODE_PATTERN.test(text)) codeIndexes.push(i);
    if (NAME_PATTERN.test(text)) nameIndexes.push(i);
    if (PRICE_PATTERN.test(text)) priceIndexes.push(i);
    if (PACK_SIZE_PATTERN.test(text)) packSizeIndexes.push(i);
  });

  return {
    code: pickBestColumn(rows, headerRowIndex, codeIndexes),
    name: pickBestColumn(rows, headerRowIndex, nameIndexes),
    price: pickBestColumn(rows, headerRowIndex, priceIndexes),
    packSize: pickBestColumn(rows, headerRowIndex, packSizeIndexes),
  };
}

// Real files have rows like "On Request" or "Refer to page no. 1166"
// instead of a number (seen in HiMedia - ~6% of its 30k rows). Those are
// legitimate "no published price" rows, not parse errors - skip, don't crash
// or coerce to 0.
function parsePrice(raw) {
  if (typeof raw === "number") return raw;
  const num = Number(String(raw ?? "").replace(/[,\s]/g, ""));
  return Number.isFinite(num) ? num : null;
}

// Returns { sheets: [{ sheetName, rows: [{code, name, price}], rowsSeen, rowsSkipped }] }
export function parsePriceListWorkbook(buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheets = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: null });
    const headerRowIndex = findHeaderRowIndex(rows);
    if (headerRowIndex === -1) continue;

    const columns = detectColumns(rows, headerRowIndex);
    if (columns.code === -1 || columns.name === -1) continue; // can't use this sheet without at least identity

    const parsedRows = [];
    let rowsSkipped = 0;
    for (const row of rows.slice(headerRowIndex + 1)) {
      const code = cellText(row?.[columns.code]);
      const name = cellText(row?.[columns.name]);
      if (!code || !name) {
        rowsSkipped++;
        continue;
      }
      const price = columns.price === -1 ? null : parsePrice(row?.[columns.price]);
      const packSize = columns.packSize === -1 ? null : cellText(row?.[columns.packSize]) || null;
      parsedRows.push({ code, name, price, packSize });
    }

    sheets.push({
      sheetName,
      columns,
      rows: parsedRows,
      rowsSeen: rows.length - headerRowIndex - 1,
      rowsSkipped,
    });
  }

  return { sheets };
}
