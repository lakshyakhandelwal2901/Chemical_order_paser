import requests

BASE = "http://127.0.0.1:8000"

print(requests.get(f"{BASE}/health").json())

print(requests.get(f"{BASE}/api/v1/customers").json())
print(requests.get(f"{BASE}/api/v1/rate-cards").json())

order_items = [
    {"item_name": "Aluminium Potassium Sulphate Didecahydrate", "quantity": 2},
    {"item_name": "Citric Acid Monohydrate", "quantity": 5},
    {"item_name": "Acetone AR", "quantity": 10},
]

r = requests.post(
    f"{BASE}/api/v1/inventory/check-bulk",
    json={"items": order_items}
)

print(r.json())

quote = requests.post(
    f"{BASE}/api/v1/pricing/quote",
    json={
        "customer_name": "Mahatma Gandhi Medical College and Hospital",
        "quotation_date": "2026-08-15",
        "items": [
            {"sku": "ALUC01", "item_name": "Aluminium Potassium Sulphate Didecahydrate", "quantity": 1},
            {"sku": "CITR01", "item_name": "Citric Acid Monohydrate", "quantity": 2},
            {"sku": "CHEM001", "item_name": "Acetone AR", "quantity": 3},
        ],
    },
)

print(quote.json())
