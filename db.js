import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ponytail: SQLITE_DB_PATH override exists only so auth.test.js can point at
// a throwaway file instead of the real database - not meant to be set in
// normal operation.
const dbPath = process.env.SQLITE_DB_PATH || path.join(__dirname, "data", "app.db");

fs.mkdirSync(path.dirname(dbPath), { recursive: true });

export const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000"); // ponytail: without this, two concurrent writes throw SQLITE_BUSY instead of one just waiting briefly

const schemaPath = path.join(__dirname, "schema.sql");
db.exec(fs.readFileSync(schemaPath, "utf8"));

// ponytail: CREATE TABLE IF NOT EXISTS only creates a table the first time -
// it never adds a column to a table that already exists on someone's
// machine. Every column added to an EXISTING table since this schema first
// shipped needs an entry here, or anyone who already has a data/app.db from
// before that change hits "table X has no column named Y" on next start.
// New tables and new indexes don't need this - CREATE TABLE/INDEX IF NOT
// EXISTS already handles those correctly regardless of when they were added.
const COLUMN_MIGRATIONS = [
  ["rate_contract_items", "rate_unit", "TEXT"],
  ["products", "pack_size", "TEXT"],
  ["request_products", "candidate_products", "TEXT"],
  ["request_products", "pack_size", "TEXT"],
  ["request_products", "specification", "TEXT"],
  ["request_products", "gst", "REAL"],
  ["request_products", "discount", "REAL"],
  ["requests", "party_matched", "INTEGER"],
  ["requests", "comment", "TEXT"],
];

for (const [table, column, sqlType] of COLUMN_MIGRATIONS) {
  const hasColumn = db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((c) => c.name === column);
  if (!hasColumn) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${sqlType}`);
  }
}
