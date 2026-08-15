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
  source: "local_pdf_parse" | "ai_fallback";
  data: ParsedOrderData;
};

const parserBaseUrl = process.env.NEXT_PUBLIC_PARSER_API_BASE_URL ?? "/api/parser";

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
