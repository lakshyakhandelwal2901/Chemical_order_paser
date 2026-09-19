import { Router } from "express";
import { db } from "./db.js";
import { requireAuth } from "./auth.js";

const router = Router();

const searchParties = db.prepare(
  "SELECT DISTINCT party_name FROM rate_contracts WHERE party_name LIKE ? ORDER BY party_name LIMIT 10"
);

// GET /api/rate-contracts/parties?q=<text>
// Live autocomplete for the Sales RC form's Party Name field, same idea as
// a search-engine dropdown - type a few letters, get matching known
// parties. Returns [] (not an error) until rate contracts actually get
// imported, since that table has no rows yet - the frontend treats an
// empty result as "nothing matched, offer Other" rather than a failure.
router.get("/parties", requireAuth, (req, res) => {
  const q = (req.query.q || "").trim();
  if (!q) return res.json({ parties: [] });
  const rows = searchParties.all(`%${q}%`);
  res.json({ parties: rows.map((r) => r.party_name) });
});

export default router;
