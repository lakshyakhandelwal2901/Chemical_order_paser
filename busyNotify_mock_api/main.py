from __future__ import annotations

from datetime import date, datetime
from pathlib import Path
import json
import re
from typing import Optional

from fastapi import FastAPI, HTTPException, Query
from pydantic import BaseModel, Field

BASE = Path(__file__).resolve().parent
INVENTORY_FILE = BASE / "inventory.json"
CUSTOMERS_FILE = BASE / "rate_cards" / "customers.json"
RATE_CARDS_FILE = BASE / "rate_cards" / "rate_cards.json"

app = FastAPI(
    title="busyNotify Mock Inventory API",
    version="2.0.0",
    description="Mock inventory, customer and rate-card service for the PDF order-extraction pipeline.",
)


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def load_inventory():
    return load_json(INVENTORY_FILE)


def load_customers():
    return load_json(CUSTOMERS_FILE)


def load_rate_cards():
    return load_json(RATE_CARDS_FILE)


def normalize(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()


def parse_date(value: Optional[str]) -> Optional[date]:
    if not value:
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        return None


def today_or(value: Optional[str]) -> date:
    return parse_date(value) or date.today()


def match_score(query: str, item: dict, key: str = "normalized_name") -> float:
    q = normalize(query)
    n = item.get(key, "")
    if not q:
        return 0.0
    if q == n:
        return 1.0
    qt, nt = set(q.split()), set(n.split())
    overlap = len(qt & nt) / max(len(qt), 1)
    if q in n:
        overlap += 0.35
    return min(overlap, 1.0)


def item_alias_score(query: str, item: dict) -> float:
    best = match_score(query, item)
    for alias in item.get("aliases", []):
        alias_score = match_score(query, {"normalized_name": normalize(alias)})
        best = max(best, alias_score)
    return best


def resolve_inventory_candidate(sku: Optional[str] = None, item_name: Optional[str] = None):
    items = load_inventory()
    candidate = None
    score = None

    if sku:
        candidate = next((x for x in items if x["sku"].lower() == sku.lower()), None)
        if candidate:
            score = 1.0
    elif item_name:
        ranked = sorted(
            ((match_score(item_name, x), x) for x in items),
            key=lambda z: z[0],
            reverse=True,
        )
        if ranked and ranked[0][0] >= 0.45:
            score, candidate = ranked[0]

    return candidate, score


def check_one(request):
    candidate, score = resolve_inventory_candidate(request.sku, request.item_name)

    if not candidate:
        return {
            "found": False,
            "available": False,
            "requested_quantity": request.quantity,
            "message": "Item not found in mock inventory",
        }

    available = candidate["stock_quantity"]
    return {
        "found": True,
        "sku": candidate["sku"],
        "item_name": candidate["name"],
        "match_score": score,
        "requested_quantity": request.quantity,
        "available_quantity": available,
        "available": available >= request.quantity,
        "shortfall": max(0, request.quantity - available),
        "unit_price": candidate["unit_price"],
        "currency": candidate["currency"],
        "pack_size": candidate.get("pack_size"),
        "unit": candidate.get("unit"),
    }


def is_active_rate_card(card: dict, quotation_date: date) -> bool:
    if card.get("status") and card["status"] != "active":
        return False

    valid_from = parse_date(card.get("valid_from"))
    valid_to = parse_date(card.get("valid_to"))

    if valid_from and quotation_date < valid_from:
        return False
    if valid_to and quotation_date > valid_to:
        return False
    return True


def resolve_customer(customer_id: Optional[str] = None, customer_name: Optional[str] = None):
    customers = load_customers()

    if customer_id:
        customer = next((c for c in customers if c["customer_id"].lower() == customer_id.lower()), None)
        if customer:
            return customer, 1.0, "customer_id"

    if not customer_name:
        return None, None, None

    query = normalize(customer_name)
    best_customer = None
    best_score = 0.0
    best_method = None

    for customer in customers:
        candidates = [customer.get("canonical_name", ""), *customer.get("aliases", [])]
        for candidate_name in candidates:
            candidate = {"normalized_name": normalize(candidate_name)}
            score = item_alias_score(query, candidate)
            if score > best_score:
                best_score = score
                best_customer = customer
                best_method = "alias" if normalize(candidate_name) != normalize(customer.get("canonical_name", "")) else "exact"

    if best_customer and best_score >= 0.45:
        return best_customer, round(best_score, 4), best_method or "fuzzy"

    return None, None, None


def resolve_rate_card(customer: Optional[dict], quotation_date: date):
    cards = load_rate_cards()

    candidates = []
    if customer:
        if customer.get("rate_card_id"):
            direct = next((c for c in cards if c["rate_card_id"].lower() == customer["rate_card_id"].lower()), None)
            if direct and is_active_rate_card(direct, quotation_date):
                return direct, "customer_linked_rate_card"
        candidates = [c for c in cards if c.get("customer_id", "").lower() == customer["customer_id"].lower()]
    else:
        candidates = cards

    active = [card for card in candidates if is_active_rate_card(card, quotation_date)]
    if not active:
        return None, None

    active.sort(key=lambda c: parse_date(c.get("valid_from")) or date.min, reverse=True)
    return active[0], "date_active_rate_card"


def get_card_rate(card: dict, sku: Optional[str] = None, item_name: Optional[str] = None):
    if not card:
        return None, None

    sku_lookup = sku.lower() if sku else None
    items = card.get("items", [])

    if sku_lookup:
        match = next((x for x in items if x.get("sku", "").lower() == sku_lookup), None)
        if match:
            return match.get("rate"), match.get("sku")

    if item_name:
        query = normalize(item_name)
        ranked = []
        for item in items:
            candidate_name = item.get("sku", "")
            score = item_alias_score(query, {"normalized_name": normalize(candidate_name)})
            ranked.append((score, item))
        ranked.sort(key=lambda z: z[0], reverse=True)
        if ranked and ranked[0][0] >= 0.45:
            return ranked[0][1].get("rate"), ranked[0][1].get("sku")

    return None, None


def quote_line_item(customer: Optional[dict], quotation_date: date, item: dict):
    inventory_candidate, inventory_score = resolve_inventory_candidate(item.get("sku"), item.get("item_name"))
    quantity = float(item["quantity"])

    if not inventory_candidate:
        return {
            "found": False,
            "available": False,
            "requested_quantity": quantity,
            "quantity": quantity,
            "item_name": item.get("item_name"),
            "sku": item.get("sku"),
            "message": "Item not found in mock inventory",
            "pricing": {
                "source": "not_found",
                "rate_card_id": None,
                "rate": None,
                "inventory_price": None,
            },
            "quotation": {
                "unit_price": None,
                "amount": None,
            },
        }

    available = inventory_candidate["stock_quantity"]
    inventory_price = inventory_candidate["unit_price"]
    card, card_source = resolve_rate_card(customer, quotation_date)
    card_rate, card_sku = get_card_rate(card, inventory_candidate["sku"], item.get("item_name"))

    if card and card_rate is not None:
        source = "customer_rate_card"
        final_unit_price = card_rate
        rate_card_id = card["rate_card_id"]
    else:
        source = "inventory"
        final_unit_price = inventory_price
        rate_card_id = None

    amount = round(final_unit_price * quantity, 2) if final_unit_price is not None else None

    return {
        "found": True,
        "sku": inventory_candidate["sku"],
        "item_name": inventory_candidate["name"],
        "match_score": inventory_score,
        "requested_quantity": quantity,
        "available_quantity": available,
        "available": available >= quantity,
        "shortfall": max(0, quantity - available),
        "inventory": {
            "unit_price": inventory_price,
            "currency": inventory_candidate["currency"],
            "pack_size": inventory_candidate.get("pack_size"),
            "unit": inventory_candidate.get("unit"),
        },
        "pricing": {
            "source": source,
            "rate_card_id": rate_card_id,
            "rate_card_sku": card_sku,
            "rate": final_unit_price,
            "inventory_price": inventory_price,
            "rate_card_name": card.get("name") if source == "customer_rate_card" and card else None,
        },
        "quotation": {
            "unit_price": final_unit_price,
            "amount": amount,
            "currency": inventory_candidate["currency"],
        },
    }


class InventoryCheck(BaseModel):
    sku: Optional[str] = None
    item_name: Optional[str] = None
    quantity: float = Field(gt=0)


class BulkCheck(BaseModel):
    items: list[InventoryCheck]


class ReserveRequest(BaseModel):
    sku: str
    quantity: float = Field(gt=0)


class CustomerLookupRequest(BaseModel):
    customer_id: Optional[str] = None
    customer_name: Optional[str] = None
    quotation_date: Optional[str] = None


class QuoteItem(BaseModel):
    sku: Optional[str] = None
    item_name: Optional[str] = None
    quantity: float = Field(gt=0)


class QuoteRequest(BaseModel):
    customer_id: Optional[str] = None
    customer_name: Optional[str] = None
    quotation_date: Optional[str] = None
    items: list[QuoteItem]


@app.get("/health")
def health():
    return {
        "status": "ok",
        "service": "busyNotify",
        "inventory_items": len(load_inventory()),
        "customers": len(load_customers()),
        "rate_cards": len(load_rate_cards()),
    }


@app.get("/api/v1/categories")
def categories():
    counts = {}
    for item in load_inventory():
        counts[item["category"]] = counts.get(item["category"], 0) + 1
    return counts


@app.get("/api/v1/customers")
def get_customers():
    return {"count": len(load_customers()), "items": load_customers()}


@app.post("/api/v1/customers/resolve")
def resolve_customer_endpoint(request: CustomerLookupRequest):
    customer, score, method = resolve_customer(request.customer_id, request.customer_name)
    quotation_date = today_or(request.quotation_date)

    if not customer:
        return {
            "found": False,
            "match_score": None,
            "match_method": None,
            "quotation_date": quotation_date.isoformat(),
        }

    active_card, card_source = resolve_rate_card(customer, quotation_date)
    return {
        "found": True,
        "match_score": score,
        "match_method": method,
        "quotation_date": quotation_date.isoformat(),
        "customer": customer,
        "active_rate_card": active_card,
        "rate_card_source": card_source,
    }


@app.get("/api/v1/rate-cards")
def get_rate_cards():
    return {"count": len(load_rate_cards()), "items": load_rate_cards()}


@app.get("/api/v1/rate-cards/{rate_card_id}")
def get_rate_card(rate_card_id: str):
    for card in load_rate_cards():
        if card["rate_card_id"].lower() == rate_card_id.lower():
            return card
    raise HTTPException(status_code=404, detail="Rate card not found")


@app.get("/api/v1/inventory")
def search_inventory(
    q: Optional[str] = Query(None),
    category: Optional[str] = Query(None),
    available_only: bool = Query(False),
    limit: int = Query(20, ge=1, le=100),
):
    items = load_inventory()
    if category:
        items = [x for x in items if x["category"].lower() == category.lower()]
    if available_only:
        items = [x for x in items if x["available"]]

    if q:
        ranked = sorted(
            ((match_score(q, x), x) for x in items),
            key=lambda z: z[0],
            reverse=True,
        )
        items = [{**item, "match_score": round(score, 4)} for score, item in ranked if score > 0]

    return {"count": min(len(items), limit), "items": items[:limit]}


@app.get("/api/v1/inventory/{sku}")
def get_item(sku: str):
    for item in load_inventory():
        if item["sku"].lower() == sku.lower():
            return item
    raise HTTPException(status_code=404, detail="SKU not found")


@app.post("/api/v1/inventory/check")
def check_inventory(request: InventoryCheck):
    return check_one(request)


@app.post("/api/v1/inventory/check-bulk")
def check_bulk(request: BulkCheck):
    results = [check_one(item) for item in request.items]
    return {
        "count": len(results),
        "all_available": all(x.get("available", False) for x in results),
        "items": results,
    }


@app.post("/api/v1/inventory/reserve")
def reserve(request: ReserveRequest):
    items = load_inventory()
    for item in items:
        if item["sku"].lower() == request.sku.lower():
            if item["stock_quantity"] < request.quantity:
                raise HTTPException(
                    status_code=409,
                    detail={
                        "message": "Insufficient stock",
                        "available_quantity": item["stock_quantity"],
                        "requested_quantity": request.quantity,
                    },
                )
            item["stock_quantity"] -= request.quantity
            item["available"] = item["stock_quantity"] > 0
            INVENTORY_FILE.write_text(json.dumps(items, indent=2), encoding="utf-8")
            return {
                "reserved": True,
                "sku": item["sku"],
                "item_name": item["name"],
                "reserved_quantity": request.quantity,
                "remaining_quantity": item["stock_quantity"],
            }
    raise HTTPException(status_code=404, detail="SKU not found")


@app.post("/api/v1/pricing/quote")
def pricing_quote(request: QuoteRequest):
    customer, score, method = resolve_customer(request.customer_id, request.customer_name)
    quotation_date = today_or(request.quotation_date)

    quoted_items = [quote_line_item(customer, quotation_date, item.model_dump()) for item in request.items]
    return {
        "customer": customer,
        "customer_match": {
            "found": customer is not None,
            "match_score": score,
            "match_method": method,
        },
        "quotation_date": quotation_date.isoformat(),
        "items": quoted_items,
        "summary": {
            "item_count": len(quoted_items),
            "all_available": all(x.get("available", False) for x in quoted_items if x.get("found")),
            "priced_from_rate_card": sum(1 for x in quoted_items if x.get("pricing", {}).get("source") == "customer_rate_card"),
            "priced_from_inventory": sum(1 for x in quoted_items if x.get("pricing", {}).get("source") == "inventory"),
        },
    }


@app.post("/api/v1/quotation/build")
def build_quotation(request: QuoteRequest):
    return pricing_quote(request)


@app.get("/")
def root():
    return {
        "status": "ok",
        "message": "busyNotify mock API. Use /api/v1/inventory, /api/v1/customers, /api/v1/rate-cards, /api/v1/pricing/quote.",
    }
