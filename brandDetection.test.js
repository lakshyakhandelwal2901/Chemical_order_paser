// Run with: npm run test:brands  (or: node brandDetection.test.js)
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { guessBrandFromFilename } from "./brandDetection.js";

// Pure heuristic - tested against the actual real filenames seen so far, not
// invented ones.
assert.equal(guessBrandFromFilename("Borosil_Price_list_2627-del.xlsx"), "Borosil");
assert.equal(guessBrandFromFilename("HiMedia_Price_List_2026-2027_Sep_2026.xls"), "HiMedia");
assert.equal(guessBrandFromFilename("whatman_Cytiva_LF_2026_PL.xlsx"), "whatman");
assert.equal(guessBrandFromFilename("arkray_price_list_26-27.xlsx"), "arkray");
assert.equal(guessBrandFromFilename("Tarsons_Price_List_2026-27.xlsx"), "Tarsons");
assert.equal(guessBrandFromFilename("2026-27.xlsx"), null, "a filename with nothing but junk should return null");

// detectBrand()'s "known brand" tier needs the DB (price_list_imports
// history), so it gets its own throwaway-DB check, same pattern as the other
// test files.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testDbPath = path.join(__dirname, "data", "brand-detection.test.db");

function cleanup() {
  for (const suffix of ["", "-wal", "-shm"]) {
    if (fs.existsSync(testDbPath + suffix)) fs.rmSync(testDbPath + suffix);
  }
}

cleanup();
process.env.SQLITE_DB_PATH = testDbPath;

const { db } = await import("./db.js");
const { detectBrand } = await import("./brandDetection.js");

try {
  // No history yet - falls through to the guess tier.
  let result = detectBrand("Borosil_Price_list_2627-del.xlsx");
  assert.deepEqual(result, { brand: "Borosil", source: "guessed" });

  // Record a real prior upload where the admin typed the brand explicitly...
  db.prepare(
    "INSERT INTO price_list_imports (brand, file_name, rows_seen, rows_inserted, rows_updated, rows_skipped) VALUES (?, ?, 0, 0, 0, 0)"
  ).run("HiMedia", "HiMedia_Price_List_2026-2027_Sep_2026.xls");

  // ...next quarter's file for the same vendor should now resolve via the
  // "known" tier, not the guess tier - this is the actual point of the
  // feature: it gets more confident the more it's used.
  result = detectBrand("HiMedia_Price_List_2027-28_Dec_2026.xls");
  assert.deepEqual(result, { brand: "HiMedia", source: "known" });

  // A filename with no usable tokens at all.
  assert.equal(detectBrand("2026-27.xlsx"), null);

  console.log("brandDetection.test.js: all checks passed.");
} finally {
  db.close();
  cleanup();
}
