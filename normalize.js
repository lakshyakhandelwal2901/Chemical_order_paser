/**
 * Flattens an array of parsed order objects (as returned by extractOrderFromFile)
 * into a single flat array of line-item rows - the "what / quantity / price"
 * view across every order, regardless of which document it came from.
 *
 * @param {Array<{ filename: string, source?: string, data: object }>} parsedOrders
 * @returns {Array<object>} flat rows, one per line item
 */
export function flattenOrders(parsedOrders) {
  const rows = [];

  for (const order of parsedOrders) {
    const { filename, source, data } = order;
    if (!data || !Array.isArray(data.items)) continue;

    for (const item of data.items) {
      rows.push({
        source_file: filename,
        parsed_by: source ?? null, // "local_pdf_parse" or "ai_fallback"
        document_type: data.document_type ?? null,
        issuing_authority: data.issuing_authority ?? null,
        vendor_name: data.vendor_name ?? null,
        order_number: data.order_number ?? null,
        order_date: data.order_date ?? null,
        item_name: item.item_name ?? null,
        specification: item.specification ?? null,
        quantity: item.quantity ?? null,
        quantity_unit: item.quantity_unit ?? null,
        pack_size: item.pack_size ?? item.quantity_unit ?? null,
        unit_rate: item.unit_rate ?? null,
        amount: item.amount ?? null,
        currency: data.currency ?? "INR",
      });
    }
  }

  return rows;
}

const CSV_COLUMNS = [
  "source_file",
  "parsed_by",
  "document_type",
  "issuing_authority",
  "vendor_name",
  "order_number",
  "order_date",
  "item_name",
  "specification",
  "quantity",
  "quantity_unit",
  "pack_size",
  "unit_rate",
  "amount",
  "currency",
];

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Converts flattened rows (from flattenOrders) into a CSV string.
 * @param {Array<object>} rows
 * @returns {string} CSV text, header row included
 */
export function rowsToCsv(rows) {
  const header = CSV_COLUMNS.join(",");
  const lines = rows.map((row) =>
    CSV_COLUMNS.map((col) => csvEscape(row[col])).join(",")
  );
  return [header, ...lines].join("\n");
}
