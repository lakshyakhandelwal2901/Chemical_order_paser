import type { ParsedLineItem } from "./procurement-api";

export type DemoCustomer = {
  id: string;
  name: string;
  aliases: string[];
  rateCardId: string | null;
  validFrom: string | null;
  validTo: string | null;
  rates: Record<string, number>;
};

export type PricingRow = {
  lineItemId: string;
  itemName: string;
  inventoryPrice: number;
  rateCardPrice: number | null;
  finalPrice: number;
  source: "customer_rate_card" | "inventory";
};

const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export const demoCustomers: DemoCustomer[] = [
  {
    id: "CUST001",
    name: "Mahatma Gandhi Medical College and Hospital",
    aliases: [
      "Mahatma Gandhi Medical College & Hospital",
      "MGMC Hospital",
      "Mahatma Gandhi Medical College and Hospital, Jaipur",
    ],
    rateCardId: "RC-2026-MGMC",
    validFrom: "01-Apr-2026",
    validTo: "31-Mar-2027",
    rates: {
      [normalize("Aluminium Potassium Sulphate Didecahydrate")]: 385,
      [normalize("Citric Acid Monohydrate")]: 710,
      [normalize("Eosin Yellowish")]: 460,
      [normalize("Acetone AR")]: 385,
      [normalize("Hydrochloride Acid N/10 LR")]: 63,
      [normalize("Nutrient Agar")]: 3220,
      [normalize("Staining Mix Chemical Sisco")]: 3320,
      [normalize("Xylene Sulpher Free LR")]: 3880,
    },
  },
  {
    id: "CUST002",
    name: "ABC Hospital",
    aliases: ["A.B.C. Hospital", "ABC HOSPITAL", "ABC Hospital Jaipur"],
    rateCardId: "RC-2026-ABC",
    validFrom: "01-Apr-2026",
    validTo: "31-Mar-2027",
    rates: {
      [normalize("Aluminium Potassium Sulphate Didecahydrate")]: 385,
      [normalize("Citric Acid Monohydrate")]: 710,
      [normalize("Eosin Yellowish")]: 460,
      [normalize("Acetone AR")]: 385,
      [normalize("Nutrient Agar")]: 3418,
    },
  },
  {
    id: "CUST003",
    name: "XYZ Diagnostics",
    aliases: ["XYZ Diagnostic Center", "XYZ Diagnostics Jaipur"],
    rateCardId: null,
    validFrom: null,
    validTo: null,
    rates: {},
  },
];

export const demoChemicals = [
  "Aluminium Potassium Sulphate Didecahydrate",
  "Citric Acid Monohydrate",
  "Eosin Yellowish",
  "Haematoxylin Powder",
  "Hydrochloride Acid N/10 LR",
  "Isopropyl Alcohol LR",
  "Sodium Iodate HI-LR",
  "Staining Mix Chemical Sisco",
  "Xylene Sulpher Free LR",
  "Acetone AR",
  "Nutrient Agar",
  "MacConkey Agar",
  "Methylene Blue",
  "Phenol Red",
];

export function formatCurrency(value: number | null | undefined) {
  const amount = Number(value ?? 0);
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(Number.isFinite(amount) ? amount : 0);
}

export function matchCustomer(query: string) {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) {
    return null;
  }

  let bestMatch: { customer: DemoCustomer; score: number; source: "exact" | "alias" | "fuzzy" } | null = null;

  for (const customer of demoCustomers) {
    for (const candidate of [customer.name, ...customer.aliases]) {
      const normalizedCandidate = normalize(candidate);
      let score = 0;
      if (normalizedQuery === normalizedCandidate) {
        score = 1;
      } else if (normalizedCandidate.includes(normalizedQuery) || normalizedQuery.includes(normalizedCandidate)) {
        score = 0.86;
      } else {
        const queryTokens = new Set(normalizedQuery.split(/\s+/));
        const candidateTokens = new Set(normalizedCandidate.split(/\s+/));
        const overlap = [...queryTokens].filter((token) => candidateTokens.has(token)).length;
        score = overlap / Math.max(queryTokens.size, 1);
      }

      if (!bestMatch || score > bestMatch.score) {
        bestMatch = {
          customer,
          score,
          source: normalizedCandidate === normalize(customer.name) ? "exact" : normalizedCandidate === normalize(candidate) ? "alias" : "fuzzy",
        };
      }
    }
  }

  return bestMatch && bestMatch.score >= 0.45 ? bestMatch : null;
}

export function buildPricingRows(
  items: ParsedLineItem[],
  customerQuery: string,
  overrides: Record<string, string>
): { customer: DemoCustomer | null; rows: PricingRow[] } {
  const customerMatch = matchCustomer(customerQuery);
  const customer = customerMatch?.customer ?? null;

  const rows = items.map((item) => {
    const itemName = item.item_name;
    const normalizedName = normalize(itemName);
    const inventoryPrice = Number(item.unit_rate ?? 0);
    const rateCardPrice = customer?.rates[normalizedName] ?? null;
    const override = overrides[itemName];
    const finalPrice = override !== undefined && override !== "" ? Number(override) : rateCardPrice ?? inventoryPrice;

    return {
      lineItemId: item.item_name,
      itemName,
      inventoryPrice,
      rateCardPrice,
      finalPrice: Number.isFinite(finalPrice) ? finalPrice : inventoryPrice,
      source: rateCardPrice !== null ? "customer_rate_card" : "inventory",
    } satisfies PricingRow;
  });

  return { customer, rows };
}
