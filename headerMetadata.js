// Best-effort extraction of the header fields that sit above the item table
// (vendor name, order number, order date, issuing authority). This is a much
// softer heuristic than the table parser - layouts for this vary more than
// the tables do - so treat anything it returns as "nice to have", and never
// let its failure alone block using a locally-parsed item table.

const LABEL_PATTERNS = {
  order_number: /(?:PO\s*#|PO\s*No\.?|Order\s*No\.?|Indent\s*No\.?|क्रमांक)\s*[:\-]?\s*/i,
  order_date: /(?:PO\s*Date|Order\s*Date|Dated?|दिनांक)\s*[:\-]?\s*/i,
  vendor_name: /(?:Vendor\s*Name|M\/s\.?|मैसर्स)\s*[:\-]?\s*/i,
};

const DATE_VALUE_RE = /\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}|\d{1,2}[\-\/][A-Za-z]{3,9}[\-\/]\d{2,4}/;
const VALUE_STOP_WORDS =
  /\b(PO\s*#|PO\s*No|PO\s*Date|Vendor\s*Name|Vendor#|Address|Ware\s*House|Department|Delivery|State|Phone|Email|Mobile|Kind\s*Attn|Del\.?\s*Days|Pay\.?\s*days|Status)\b/i;

function extractLabeledValue(fullText, labelPattern, isDate = false) {
  const match = fullText.match(labelPattern);
  if (!match) return null;
  // never cross a line break - the value lives on the same source line as its label
  const after = fullText.slice(match.index + match[0].length, match.index + match[0].length + 80).split("\n")[0];

  if (isDate) {
    const dateMatch = after.match(DATE_VALUE_RE);
    return dateMatch ? dateMatch[0] : null;
  }

  const stopMatch = after.search(VALUE_STOP_WORDS);
  const value = (stopMatch >= 0 ? after.slice(0, stopMatch) : after.split(/\s{2,}/)[0]).trim();
  return value.length > 1 ? value : null;
}

/** Guesses the issuing authority from the first couple of lines (letterhead). */
function guessIssuingAuthority(lines) {
  const AUTHORITY_HINTS = /hospital|college|chikitsalaya|चिकित्सालय|कार्यालय|office|medical|society|सोसायटी/i;
  for (const line of lines.slice(0, 8)) {
    const text = line.items.map((i) => i.text).join(" ").trim();
    if (text.length > 5 && AUTHORITY_HINTS.test(text)) return text;
  }
  return null;
}

/**
 * @param {Array} lines - full output of extractPdfLines()
 * @param {object|null} headerLine - the item-table header line, if found (metadata search stops here)
 */
export function extractHeaderMetadata(lines, headerLine) {
  const cutoff = headerLine ? lines.indexOf(headerLine) : lines.length;
  const preTableLines = lines.slice(0, cutoff === -1 ? lines.length : cutoff);
  const fullText = preTableLines.map((l) => l.items.map((i) => i.text).join(" ")).join("\n");

  return {
    vendor_name: extractLabeledValue(fullText, LABEL_PATTERNS.vendor_name),
    order_number: extractLabeledValue(fullText, LABEL_PATTERNS.order_number),
    order_date: extractLabeledValue(fullText, LABEL_PATTERNS.order_date, true),
    issuing_authority: guessIssuingAuthority(preTableLines),
  };
}
