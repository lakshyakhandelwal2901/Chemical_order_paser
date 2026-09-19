import { db } from "./db.js";

// Ports the matching approach already used in
// busyNotify_mock_api/main.py (match_score / item_alias_score / resolve_*)
// so both halves of the system resolve free-text names the same way. Pure
// normalize + token-overlap scoring - no fuzzy-matching dependency needed.
const MATCH_THRESHOLD = 0.45;

export function normalize(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Fraction of the query's tokens found in the candidate, plus a bonus if the
// whole query is a substring of the candidate. Ported as-is from main.py's
// match_score() - a query that's a strict subset of the candidate's tokens
// scores 1.0, same as a literal string match, by design.
function matchScore(normalizedQuery, normalizedCandidate) {
  if (!normalizedQuery) return 0;
  if (normalizedQuery === normalizedCandidate) return 1;
  const queryTokens = normalizedQuery.split(" ").filter(Boolean);
  const candidateTokens = new Set(normalizedCandidate.split(" ").filter(Boolean));
  const overlap = queryTokens.filter((t) => candidateTokens.has(t)).length;
  let score = overlap / Math.max(queryTokens.length, 1);
  if (normalizedCandidate.includes(normalizedQuery)) score += 0.35;
  return Math.min(score, 1);
}

const listActiveProducts = db.prepare("SELECT * FROM products WHERE active = 1");
const listAllAliases = db.prepare("SELECT product_id, alias_text FROM product_aliases");
const findByCode = db.prepare("SELECT * FROM products WHERE active = 1 AND (LOWER(sku) = ? OR LOWER(product_code) = ?)");

const TIE_EPSILON = 0.001;

// ponytail: was previously one query per product for its aliases - fine
// against 66 seed products, but a real price-list import (tested against
// ~24k real HiMedia rows) turned that into 24k+ queries and ~140ms per
// matchProduct() call. Loading every alias once and grouping in memory
// brought a single call down to low single-digit ms at that same scale.
function loadAliasesByProduct() {
  const map = new Map();
  for (const { product_id, alias_text } of listAllAliases.all()) {
    if (!map.has(product_id)) map.set(product_id, []);
    map.get(product_id).push(alias_text);
  }
  return map;
}

function bestScoreForProduct(query, product, aliasesByProduct) {
  let score = matchScore(query, normalize(product.product_name));
  let source = "name";
  for (const aliasText of aliasesByProduct.get(product.id) ?? []) {
    const aliasScore = matchScore(query, normalize(aliasText));
    if (aliasScore > score) {
      score = aliasScore;
      source = "alias";
    }
  }
  return { product, score, source };
}

function toMatch({ product, score, source }) {
  return { product, score: Math.round(score * 10000) / 10000, method: score === 1 ? `exact_${source}` : `fuzzy_${source}` };
}

// Given raw OCR/extracted item text, returns the best-matching product plus
// a 0-1 confidence and how it was found, or null if nothing clears
// MATCH_THRESHOLD. Only identifies WHICH product this is - price, stock, and
// rate-contract lookups for the matched product are handled elsewhere.
//
// brandHint (e.g. a Make/Brand column already present in the source
// document) picks the winner when several brand-variants tie on score.
// Independent of that: whenever the winning product's exact name exists
// under more than one brand in the product master, `candidates` is always
// populated with all of them (best-scored first) - this is a property of
// the product master ("does this product exist under other brands"), not
// of whether this particular query happened to score them equally, so it
// fires even when brandHint confidently picked a winner.
export function matchProduct(rawItemName, { brandHint } = {}) {
  const query = normalize(rawItemName);
  if (!query) return null;

  const exact = findByCode.get(query, query);
  if (exact) return { product: exact, score: 1, method: "exact_code", candidates: null };

  const aliasesByProduct = loadAliasesByProduct();
  const scored = listActiveProducts
    .all()
    .map((product) => bestScoreForProduct(query, product, aliasesByProduct))
    .filter((s) => s.score >= MATCH_THRESHOLD)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return null;

  const topScore = scored[0].score;
  const tied = scored.filter((s) => Math.abs(s.score - topScore) < TIE_EPSILON);

  let winner = tied[0];
  if (tied.length > 1 && brandHint) {
    const normalizedHint = normalize(brandHint);
    const brandMatch = tied.find((s) => normalize(s.product.brand || "") === normalizedHint);
    if (brandMatch) winner = brandMatch;
  }

  const winnerName = normalize(winner.product.product_name);
  const sameName = scored.filter((s) => normalize(s.product.product_name) === winnerName);
  const distinctBrands = new Set(sameName.map((s) => s.product.brand || null));
  const candidates =
    sameName.length > 1 && distinctBrands.size > 1
      ? sameName.sort((a, b) => b.score - a.score).map((s) => ({ product: s.product, score: Math.round(s.score * 10000) / 10000 }))
      : null;

  return { ...toMatch(winner), candidates };
}
