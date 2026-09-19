// Run with: npm run test:matching  (or: node productMatching.test.js)
//
// ponytail: assert-based smoke test, not a full suite. Seeds a throwaway DB
// with a handful of real product names (not fabricated) plus one alias, and
// checks exact-code, exact-name, fuzzy/partial-name, alias-only, and
// no-match cases.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testDbPath = path.join(__dirname, "data", "product-matching.test.db");

function cleanup() {
  for (const suffix of ["", "-wal", "-shm"]) {
    if (fs.existsSync(testDbPath + suffix)) fs.rmSync(testDbPath + suffix);
  }
}

cleanup();
process.env.SQLITE_DB_PATH = testDbPath;

const { db } = await import("./db.js");
const { matchProduct } = await import("./productMatching.js");

try {
  const insertProduct = db.prepare(
    "INSERT INTO products (sku, product_name, unit, purchase_price, active) VALUES (?, ?, ?, ?, 1)"
  );
  const { lastInsertRowid: citricId } = insertProduct.run("CITR01", "Citric Acid Monohydrate", "GRM", 759.0);
  const { lastInsertRowid: isoId } = insertProduct.run("CHEM014", "Isopropanol Alcohol Molecular Grade", "LTR", 310.0);

  // "IPA" shares zero tokens with "Isopropanol Alcohol Molecular Grade" - it
  // can only resolve through the alias table, which is the actual point of
  // having one (the plan's own "Acetonitrile HPLC -> ACN-HPLC-001" example).
  db.prepare("INSERT INTO product_aliases (product_id, alias_text) VALUES (?, ?)").run(isoId, "IPA");

  let result = matchProduct("CITR01");
  assert.ok(result, "exact SKU should match");
  assert.equal(result.product.id, citricId);
  assert.equal(result.method, "exact_code");
  assert.equal(result.score, 1);

  result = matchProduct("Citric Acid Monohydrate");
  assert.ok(result, "exact name should match");
  assert.equal(result.product.id, citricId);

  result = matchProduct("Citric Acid Powder");
  assert.ok(result, "a close partial name should still clear the threshold");
  assert.equal(result.product.id, citricId, "should resolve to the same product despite the extra word");
  assert.ok(result.score < 1, "an inexact query should not score a perfect 1.0");

  result = matchProduct("IPA");
  assert.ok(result, "alias should resolve even with zero name overlap");
  assert.equal(result.product.id, isoId);
  assert.equal(result.method, "exact_alias");

  result = matchProduct("Unobtainium Crystal Dust");
  assert.equal(result, null, "a nonsense query should not match anything");

  // Two different brands selling the same-named product: without a brand
  // hint, this should come back with both listed as candidates.
  const { lastInsertRowid: accurexId } = insertProduct.run("ACX-CAL", "Calcium Reagent", "ML", 100.0);
  db.prepare("UPDATE products SET brand = ? WHERE id = ?").run("Accurex", accurexId);
  const { lastInsertRowid: rchemId } = insertProduct.run("RCH-CAL", "Calcium Reagent", "ML", 90.0);
  db.prepare("UPDATE products SET brand = ? WHERE id = ?").run("RCHEM", rchemId);

  result = matchProduct("Calcium Reagent");
  assert.ok(result, "should still return a provisional pick");
  assert.ok(Array.isArray(result.candidates), "same-name cross-brand products should be listed as candidates");
  assert.equal(result.candidates.length, 2, "both brand variants should be listed as candidates");

  // A brand hint resolves WHICH one is the confident winner, but the
  // alternatives still exist in the product master, so they should still be
  // offered - "always show the option to pick a brand" doesn't stop just
  // because this particular match was confident.
  result = matchProduct("Calcium Reagent", { brandHint: "RCHEM" });
  assert.ok(result, "brand hint should resolve the winner");
  assert.equal(result.product.id, rchemId);
  assert.ok(Array.isArray(result.candidates), "alternatives should still be offered even once a brand hint resolves the winner");
  assert.equal(result.candidates.length, 2);

  // Same name, same brand-alternatives setup, but this time one candidate
  // has an alias that scores strictly higher - not a tie at all. The
  // alternatives should still be offered, because "does this product exist
  // under another brand" doesn't depend on whether this query happened to
  // score them equally.
  db.prepare("INSERT INTO product_aliases (product_id, alias_text) VALUES (?, ?)").run(accurexId, "Calcium Reagent");
  result = matchProduct("Calcium Reagent");
  assert.equal(result.product.id, accurexId, "the alias-boosted exact match should win outright, not tie");
  assert.equal(result.score, 1);
  assert.ok(Array.isArray(result.candidates), "alternatives should still be offered despite the score not tying");
  assert.equal(result.candidates.length, 2);

  console.log("productMatching.test.js: all checks passed.");
} finally {
  db.close();
  cleanup();
}
