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
  {
    id: "CUST004",
    name: "Omega Test House Pvt. Ltd.",
    aliases: ["Omega Test House", "Omega Test House Pvt Ltd", "Omega Test House Pvt. Ltd., Jaipur"],
    rateCardId: null,
    validFrom: null,
    validTo: null,
    rates: {},
  },
  {
    id: "CUST005",
    name: "Nims University Rajasthan",
    aliases: ["NIMS University", "Nims University Rajasthan, Jaipur"],
    rateCardId: "RC-2026-NIMS",
    validFrom: "24-Jul-2026",
    validTo: "23-Jul-2027",
    rates: {
      [normalize("Gold Chloride")]: 0,
      [normalize("Mayer’s Mucicarmine Stain")]: 4405,
      [normalize("Reticulocyte Staining Solution")]: 2355,
      [normalize("Mercuric Oxide")]: 75050,
    },
  },
  {
    id: "CUST006",
    name: "Indian Medical Trust",
    aliases: ["BST Hospital", "BST Hospital Jaipur", "Indian Medical Trust, Jaipur"],
    rateCardId: "RC-2026-IMT",
    validFrom: "19-May-2026",
    validTo: "18-May-2027",
    rates: {
      [normalize("Beaker 100ML")]: 78,
      [normalize("Beaker 250ML")]: 84.5,
      [normalize("Beaker 500ML")]: 130,
      [normalize("Beaker 1000ML")]: 260,
      [normalize("Volumetric Flask 500ML")]: 263.25,
      [normalize("Volumetric Pipette 1ML")]: 152.75,
    },
  },
  {
    id: "CUST007",
    name: "Multitech Automation",
    aliases: ["MULTITECH AUTOMATION", "Multitech_Sales"],
    rateCardId: null,
    validFrom: null,
    validTo: null,
    rates: {},
  },
  {
    id: "CUST008",
    name: "CHC Khachriyawas",
    aliases: ["CHC Khachriyawas RC", "CHC Khachriyawas Jaipur"],
    rateCardId: null,
    validFrom: null,
    validTo: null,
    rates: {},
  },
  {
    id: "CUST009",
    name: "CMHO I Jaipur",
    aliases: ["CMHO I Jaipur RC", "CMHO Jaipur"],
    rateCardId: null,
    validFrom: null,
    validTo: null,
    rates: {},
  },
  {
    id: "CUST010",
    name: "GMC Sawaimadhopur",
    aliases: ["GMC Sawaimadhopur RC", "GMC Sawai Madhopur"],
    rateCardId: null,
    validFrom: null,
    validTo: null,
    rates: {},
  },
  {
    id: "CUST011",
    name: "Satellite Sethi Colony",
    aliases: ["Satellite sethi colony", "Satellite Sethi Colony RC"],
    rateCardId: null,
    validFrom: null,
    validTo: null,
    rates: {},
  },
  {
    id: "CUST012",
    name: "SMS Hospital",
    aliases: ["SMS HOSPITAL BIOCHEMISTRY", "SMS Hospital Disposable", "SMS HLA Lab"],
    rateCardId: null,
    validFrom: null,
    validTo: null,
    rates: {},
  },
  {
    id: "CUST013",
    name: "Jaipur Dairy",
    aliases: ["JAIPUR DAIRY RC", "Jaipur Dairy"],
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
  "Gold Chloride",
  "Mayer’s Mucicarmine Stain",
  "Reticulocyte Staining Solution",
  "Mercuric Oxide",
  "Beaker 100ML",
  "Volumetric Flask 500ML",
  "Test Tube Graduated (17 x 160)",
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
