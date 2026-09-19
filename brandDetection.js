import { db } from "./db.js";

// ponytail: built against the exact real filenames seen so far
// ("Borosil_Price_list_2627-del.xlsx", "HiMedia_Price_List_2026-2027_Sep_2026.xls",
// "whatman_Cytiva_LF_2026_PL.xlsx", "arkray_price_list_26-27.xlsx",
// "Tarsons_Price_List_2026-27.xlsx") rather than a guessed pattern.
const JUNK_WORDS = new Set([
  "price",
  "list",
  "pl",
  "lp",
  "catalog",
  "del",
  "final",
  "update",
  "updated",
  "revised",
  "new",
  "rev",
  "v1",
  "v2",
  "version",
  "master",
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
]);

function isJunkToken(token) {
  const lower = token.toLowerCase();
  if (JUNK_WORDS.has(lower)) return true;
  if (/^\d+$/.test(token)) return true; // years, year fragments (26, 27, 2026...)
  return false;
}

// Pure string heuristic, no DB access - independently testable. Splits on
// common filename delimiters, strips extension and junk tokens, and takes
// the first meaningful token left as the brand guess.
export function guessBrandFromFilename(filename) {
  const base = String(filename ?? "").replace(/\.[^./\\]+$/, "");
  const tokens = base.split(/[_\-\s]+/).filter(Boolean);
  const meaningful = tokens.filter((t) => !isJunkToken(t));
  return meaningful.length > 0 ? meaningful[0] : null;
}

function normalizeForMatch(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

const listKnownBrands = db.prepare("SELECT DISTINCT brand FROM price_list_imports ORDER BY LENGTH(brand) DESC");

// Checks the filename against brands the admin has explicitly named in past
// uploads - longest names checked first, so a longer real brand name always
// wins over a shorter accidental substring match.
function knownBrandFromFilename(filename) {
  const normalizedFilename = normalizeForMatch(filename);
  if (!normalizedFilename) return null;
  for (const { brand } of listKnownBrands.all()) {
    const normalizedBrand = normalizeForMatch(brand);
    if (normalizedBrand && normalizedFilename.includes(normalizedBrand)) return brand;
  }
  return null;
}

// Returns { brand, source: "known" | "guessed" }, or null if nothing usable
// could be extracted at all (e.g. a filename that's just a date).
// "known" = matched a brand name used in a previous upload (confident).
// "guessed" = first non-junk token in the filename (best-effort, unconfirmed).
export function detectBrand(filename) {
  const known = knownBrandFromFilename(filename);
  if (known) return { brand: known, source: "known" };

  const guessed = guessBrandFromFilename(filename);
  if (guessed) return { brand: guessed, source: "guessed" };

  return null;
}
