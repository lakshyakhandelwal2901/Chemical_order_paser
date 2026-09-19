import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ponytail: reads busyNotify_mock_api's inventory.json directly to seed
// realistic product names instead of inventing fake ones. This is a one-time
// local copy for testing product matching against real-looking data - NOT
// the live busyNotify integration (that's Phase 4).
//
// busyNotify_mock_api ships nested inside this project in this zip, but the
// README's own setup instructions treat it as a sibling repo - so check both
// rather than assuming one layout.
const candidatePaths = [
  path.join(__dirname, "busyNotify_mock_api", "inventory.json"),
  path.join(__dirname, "..", "busyNotify_mock_api", "inventory.json"),
];
const inventoryPath = candidatePaths.find((candidate) => fs.existsSync(candidate));

if (!inventoryPath) {
  console.error(
    `Could not find inventory.json in either of:\n  ${candidatePaths.join("\n  ")}\nIs busyNotify_mock_api checked out somewhere else? Point this script at it directly if so.`
  );
  process.exit(1);
}

const inventory = JSON.parse(fs.readFileSync(inventoryPath, "utf8"));

const insertProduct = db.prepare(
  `INSERT INTO products (sku, product_name, unit, purchase_price, active)
   VALUES (?, ?, ?, ?, 1)
   ON CONFLICT(sku) DO NOTHING`
);
const findProductBySku = db.prepare("SELECT id FROM products WHERE sku = ?");
const aliasExists = db.prepare("SELECT id FROM product_aliases WHERE product_id = ? AND alias_text = ?");
const insertAlias = db.prepare("INSERT INTO product_aliases (product_id, alias_text) VALUES (?, ?)");

let created = 0;
for (const item of inventory) {
  const result = insertProduct.run(item.sku, item.name, item.unit ?? null, item.unit_price ?? null);
  if (result.changes > 0) created++;
}
console.log(`Seeded ${created} product(s) from busyNotify_mock_api/inventory.json (${inventory.length - created} already existed).`);

// A few hand-picked, illustrative aliases (not from busyNotify) demonstrating
// the exact case the plan describes: free text that OCR/a salesperson might
// actually write, resolved via the alias table rather than name similarity.
const ILLUSTRATIVE_ALIASES = [
  { sku: "CHEM014", alias: "IPA" }, // common lab abbreviation for isopropanol
  { sku: "CHEM001", alias: "Acetone Analytical Reagent Grade" },
  { sku: "CHEM009", alias: "Absolute Ethanol" },
  { sku: "MED010", alias: "Nutrient Agar Powder" },
];

let aliasesAdded = 0;
for (const { sku, alias } of ILLUSTRATIVE_ALIASES) {
  const product = findProductBySku.get(sku);
  if (!product) continue;
  if (aliasExists.get(product.id, alias)) continue;
  insertAlias.run(product.id, alias);
  aliasesAdded++;
}
console.log(`Added ${aliasesAdded} illustrative alias(es).`);
