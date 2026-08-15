# busyNotify Mock Inventory API

## Run

```powershell
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

Swagger:
http://127.0.0.1:8000/docs

## Useful endpoints

GET `/health`

GET `/api/v1/categories`

GET `/api/v1/inventory?q=acetone`

GET `/api/v1/inventory?category=chemicals&available_only=true`

GET `/api/v1/inventory/CHEM001`

GET `/api/v1/customers`

POST `/api/v1/customers/resolve`

```json
{
  "customer_name": "Mahatma Gandhi Medical College and Hospital",
  "quotation_date": "2026-08-15"
}
```

GET `/api/v1/rate-cards`

GET `/api/v1/rate-cards/RC-2026-MGMC`

POST `/api/v1/pricing/quote`

```json
{
  "customer_name": "Mahatma Gandhi Medical College and Hospital",
  "quotation_date": "2026-08-15",
  "items": [
    {"sku": "ALUC01", "item_name": "Aluminium Potassium Sulphate Didecahydrate", "quantity": 1},
    {"sku": "CITR01", "item_name": "Citric Acid Monohydrate", "quantity": 2}
  ]
}
```

POST `/api/v1/inventory/check`

```json
{
  "item_name": "Acetone AR",
  "quantity": 10
}
```

POST `/api/v1/inventory/check-bulk`

```json
{
  "items": [
    {"item_name": "Acetone AR", "quantity": 10},
    {"item_name": "Nutrient Agar", "quantity": 5}
  ]
}
```

POST `/api/v1/inventory/reserve`

```json
{
  "sku": "CHEM001",
  "quantity": 5
}
```

The inventory contains chemicals, microbiology media, reagents and antibiotic-powder entries based primarily on the item names visible in the uploaded purchase-order/rate-contract examples, plus additional common lab inventory entries for testing.
