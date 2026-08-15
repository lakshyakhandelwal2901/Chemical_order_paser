const DEFAULT_BASE_URL = "http://127.0.0.1:8000";

function getBaseUrl() {
  return (process.env.BUSYNOTIFY_API_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, "");
}

function toQuoteItem(row) {
  const quantity = Number(row.quantity);
  if (!row.item_name || !Number.isFinite(quantity) || quantity <= 0) {
    return null;
  }

  return {
    item_name: row.item_name,
    quantity,
  };
}

export function buildQuotationPayload(flatRows, options = {}) {
  const items = [];
  const skipped = [];

  for (const row of flatRows) {
    const requestItem = toQuoteItem(row);
    if (requestItem) {
      items.push({
        ...requestItem,
        source_file: row.source_file ?? null,
        pack_size: row.pack_size ?? null,
        vendor_name: row.vendor_name ?? null,
      });
    } else {
      skipped.push({
        source_file: row.source_file ?? null,
        item_name: row.item_name ?? null,
        pack_size: row.pack_size ?? null,
        quantity: row.quantity ?? null,
        reason: "Missing or non-positive quantity; busyNotify pricing quote requires quantity > 0",
      });
    }
  }

  return {
    customer_id: options.customer_id ?? null,
    customer_name: options.customer_name ?? null,
    quotation_date: options.quotation_date ?? null,
    items,
    skipped,
  };
}

export async function quoteFromParsedRows(flatRows, options = {}) {
  const payload = buildQuotationPayload(flatRows, options);

  if (payload.items.length === 0) {
    return {
      checked: 0,
      skipped: payload.skipped,
      items: [],
      message: "No items with quantity > 0 were available to quote against busyNotify.",
    };
  }

  const response = await fetch(`${getBaseUrl()}/api/v1/pricing/quote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      customer_id: payload.customer_id,
      customer_name: payload.customer_name,
      quotation_date: payload.quotation_date,
      items: payload.items.map(({ item_name, quantity }) => ({ item_name, quantity })),
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`busyNotify pricing quote failed (${response.status}): ${text}`);
  }

  const quote = await response.json();
  const mergedItems = quote.items.map((result, index) => ({
    ...result,
    source_file: payload.items[index]?.source_file ?? null,
    pack_size: payload.items[index]?.pack_size ?? null,
    vendor_name: payload.items[index]?.vendor_name ?? null,
  }));

  return {
    ...quote,
    checked: payload.items.length,
    skipped: payload.skipped,
    items: mergedItems,
  };
}