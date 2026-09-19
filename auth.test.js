// Run with: npm test  (or: node auth.test.js)
//
// ponytail: this is a plain assert-based smoke test, not a full suite - it
// exists to catch a broken login/session/logout path, not to cover every
// case. Uses a throwaway SQLite file so it never touches data/app.db.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testDbPath = path.join(__dirname, "data", "auth.test.db");

function cleanup() {
  for (const suffix of ["", "-wal", "-shm"]) {
    if (fs.existsSync(testDbPath + suffix)) fs.rmSync(testDbPath + suffix);
  }
}

cleanup();
process.env.SQLITE_DB_PATH = testDbPath;

const { db } = await import("./db.js");
const { hashPassword, verifyPassword, createSession, getSessionUser, destroySession } = await import("./auth.js");

try {
  const passwordHash = hashPassword("test-pass-123");
  const { lastInsertRowid: userId } = db
    .prepare("INSERT INTO users (username, password_hash, role, display_name) VALUES (?, ?, ?, ?)")
    .run("test-user", passwordHash, "SALESPERSON", "Test User");

  assert.equal(verifyPassword("test-pass-123", passwordHash), true, "correct password should verify");
  assert.equal(verifyPassword("wrong-pass", passwordHash), false, "wrong password should not verify");

  const session = createSession(userId);
  const sessionUser = getSessionUser(session.id);
  assert.ok(sessionUser, "a freshly created session should resolve to a user");
  assert.equal(sessionUser.username, "test-user");
  assert.equal(sessionUser.role, "SALESPERSON");

  destroySession(session.id);
  assert.equal(getSessionUser(session.id), null, "a destroyed session should no longer resolve");

  const expired = createSession(userId);
  db.prepare("UPDATE sessions SET expires_at = ? WHERE id = ?").run(
    new Date(Date.now() - 1000).toISOString(),
    expired.id
  );
  assert.equal(getSessionUser(expired.id), null, "an expired session should not resolve");

  console.log("auth.test.js: all checks passed.");
} finally {
  db.close();
  cleanup();
}
