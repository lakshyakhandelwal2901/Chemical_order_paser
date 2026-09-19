export type ParsedLineItem = {
  item_name: string;
  specification: string | null;
  quantity: number | null;
  quantity_unit: string | null;
  unit_rate: number | null;
  amount: number | null;
  pack_size: string | null;
};

export type ParsedOrderData = {
  document_type: string;
  issuing_authority: string | null;
  vendor_name: string | null;
  order_number: string | null;
  order_date: string | null;
  reference_number: string | null;
  currency: string;
  items: ParsedLineItem[];
  total_amount: number | null;
  notes: string | null;
};

export type ParseOrderResponse = {
  filename: string;
  success: boolean;
  source: "local_pdf_parse" | "ocr_space";
  data: ParsedOrderData;
};

export type QuoteRequestItem = {
  sku?: string | null;
  item_name?: string | null;
  quantity: number;
};

export type PricingQuoteResponse = {
  customer: {
    customer_id: string;
    canonical_name: string;
    [key: string]: unknown;
  } | null;
  customer_match: {
    found: boolean;
    match_score: number | null;
    match_method: string | null;
  };
  quotation_date: string;
  items: Array<{
    found: boolean;
    sku: string | null;
    item_name: string;
    match_score: number | null;
    requested_quantity: number;
    available_quantity: number;
    available: boolean;
    shortfall: number;
    inventory_review?: {
      status: "available" | "partial" | "not_found";
      needs_order: number;
      available_quantity: number;
    };
    inventory: {
      unit_price: number | null;
      currency: string | null;
      pack_size: string | null;
      unit: string | null;
    };
    pricing: {
      source: "customer_rate_card" | "inventory" | "not_found";
      rate_card_id: string | null;
      rate_card_sku: string | null;
      rate: number | null;
      inventory_price: number | null;
      rate_card_name: string | null;
    };
    price_review: {
      comparison: "lower" | "higher" | "same" | "inventory_only" | "not_found";
      difference: number | null;
      needs_review: boolean;
      message: string;
    };
    quotation: {
      unit_price: number | null;
      amount: number | null;
      currency: string | null;
    };
  }>;
  summary: {
    item_count: number;
    all_available: boolean;
    priced_from_rate_card: number;
    priced_from_inventory: number;
    needs_review: number;
    inventory_short_items: number;
    total_shortfall: number;
  };
};

export type RequestType = "ORDER" | "RATE_CONTRACT" | "QUOTATION";

export type CreateRequestResponse = {
  request_id: number;
  file_number: string;
  party_name: string;
  request_type: RequestType;
  delivery_date: string;
};

const parserBaseUrl = process.env.NEXT_PUBLIC_PARSER_API_BASE_URL ?? "http://127.0.0.1:3001/api";
const busyNotifyBaseUrl = process.env.NEXT_PUBLIC_BUSYNOTIFY_API_BASE_URL ?? "/api/busynotify";

async function parseJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Request failed with status ${response.status}`);
  }

  return (await response.json()) as T;
}

export async function uploadPurchaseOrder(file: File, clientId: string): Promise<ParseOrderResponse> {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("client_id", clientId);

  const response = await fetch(`${parserBaseUrl}/parse-order`, {
    method: "POST",
    body: formData,
  });

  return parseJson<ParseOrderResponse>(response);
}

export async function uploadQuotationDocument(file: File, clientId: string): Promise<ParseOrderResponse> {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("client_id", clientId);

  const response = await fetch(`${parserBaseUrl}/parse-quotation`, {
    method: "POST",
    body: formData,
  });

  return parseJson<ParseOrderResponse>(response);
}

export type RequestStatus = "PROCESSING" | "READY_FOR_REVIEW" | "IN_PROGRESS" | "DELIVERED" | "CANCELLED";

export type RequestSummary = {
  id: number;
  file_number: string;
  file_name: string;
  file_type: RequestType;
  party_name: string;
  party_matched: 0 | 1 | null;
  delivery_date: string;
  status: RequestStatus;
  submission_date: string;
  comment: string | null;
  salesperson_name: string | null;
  salesperson_username: string;
};

export type ProductCandidate = {
  product_id: number;
  brand: string | null;
  code: string | null;
  sku: string | null;
  mrp: number | null;
  score: number;
  stock: number | null;
  purchase_price: number | null;
  gst: number | null;
};

export type RequestItem = {
  id: number;
  product_name_raw: string;
  pack_size: string | null;
  specification: string | null;
  brand: string | null;
  code: string | null;
  sku: string | null;
  quantity_required: number | null;
  file_price: number | null;
  rc_price: number | null;
  mrp: number | null;
  purchase_price: number | null;
  stock: number | null;
  gst: number | null;
  discount: number | null;
  short_by: number | null;
  comment: string | null;
  candidate_products: ProductCandidate[] | null;
};

export type RequestDetail = RequestSummary & { items: RequestItem[] };

export async function listRequests(type?: RequestType): Promise<{ requests: RequestSummary[] }> {
  const query = type ? `?type=${encodeURIComponent(type)}` : "";
  const response = await fetch(`${parserBaseUrl}/requests${query}`, { credentials: "include" });
  return parseJson(response);
}

export async function getRequest(id: number): Promise<RequestDetail> {
  const response = await fetch(`${parserBaseUrl}/requests/${id}`, { credentials: "include" });
  return parseJson<RequestDetail>(response);
}

export async function updateRequest(
  id: number,
  payload: {
    status?: RequestStatus;
    comment?: string | null;
    items?: { id: number; comment?: string | null; discount?: number | null; product_id?: number }[];
  }
): Promise<RequestDetail> {
  const response = await fetch(`${parserBaseUrl}/requests/${id}`, {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return parseJson<RequestDetail>(response);
}

export async function searchRateContractParties(query: string): Promise<string[]> {
  if (!query.trim()) return [];
  const response = await fetch(`${parserBaseUrl}/rate-contracts/parties?q=${encodeURIComponent(query)}`, {
    credentials: "include",
  });
  const result = await parseJson<{ parties: string[] }>(response);
  return result.parties;
}

export async function submitRequest(params: {
  file: File;
  partyName: string;
  requestType: RequestType;
  deliveryDate: string;
  partyMatched?: boolean;
}): Promise<CreateRequestResponse> {
  const formData = new FormData();
  formData.append("file", params.file);
  formData.append("party_name", params.partyName);
  formData.append("request_type", params.requestType);
  formData.append("delivery_date", params.deliveryDate);
  if (params.partyMatched !== undefined) {
    formData.append("party_matched", params.partyMatched ? "true" : "false");
  }

  const response = await fetch(`${parserBaseUrl}/requests`, {
    method: "POST",
    credentials: "include",
    body: formData,
  });

  return parseJson<CreateRequestResponse>(response);
}

export async function requestPricingQuote(
  customerName: string,
  quotationDate: string,
  items: QuoteRequestItem[]
): Promise<PricingQuoteResponse> {
  const response = await fetch(`${busyNotifyBaseUrl}/v1/pricing/quote`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ customer_name: customerName, quotation_date: quotationDate, items }),
  });

  return parseJson<PricingQuoteResponse>(response);
}
