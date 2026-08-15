const DEFAULT_BASE_URL = "http://127.0.0.1:8000";

function getBaseUrl() {
  return (process.env.BUSYNOTIFY_API_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, "");
}

function toCheckItem(row) {
  const quantity = Number(row.quantity);
  if (!row.item_name || !Number.isFinite(quantity) || quantity <= 0) {
    return null;
  }

  return {
    item_name: row.item_name,
    quantity,
  };
}

export function buildInventoryPayload(flatRows) {
  const items = [];
  const skipped = [];

  for (const row of flatRows) {
    const requestItem = toCheckItem(row);
    if (requestItem) {
      items.push({ ...requestItem, source_file: row.source_file ?? null, pack_size: row.pack_size ?? null });
    } else {
      skipped.push({
        source_file: row.source_file ?? null,
        item_name: row.item_name ?? null,
        pack_size: row.pack_size ?? null,
        quantity: row.quantity ?? null,
        reason: "Missing or non-positive quantity; busyNotify check-bulk requires quantity > 0",
      });
    }
  }

  return { items, skipped };
}

export async function checkInventoryBulk(flatRows) {
  const { items, skipped } = buildInventoryPayload(flatRows);

  if (items.length === 0) {
    return {
      checked: 0,
      skipped,
      all_available: false,
      items: [],
      message: "No items with quantity > 0 were available to check against busyNotify.",
    };
  }

  const response = await fetch(`${getBaseUrl()}/api/v1/inventory/check-bulk`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items: items.map(({ item_name, quantity }) => ({ item_name, quantity })) }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`busyNotify check-bulk failed (${response.status}): ${text}`);
  }

  const payload = await response.json();
  const mergedItems = payload.items.map((result, index) => ({
    ...result,
    source_file: items[index]?.source_file ?? null,
    pack_size: items[index]?.pack_size ?? null,
  }));

  return {
    ...payload,
    checked: items.length,
    skipped,
    items: mergedItems,
  };
}