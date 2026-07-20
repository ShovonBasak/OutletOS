# CP Five Star — Shop Management System

Full-stack outlet management for a CP Five Star fried-chicken franchise in Dhaka.
Built to the finalized design in [`CLAUDE.md`](./CLAUDE.md) (data model, business rules,
and UI conventions are the source of truth).

- **Backend** — Django + Django REST Framework, JWT auth, PostgreSQL (SQLite fallback for dev)
- **Frontend** — Next.js (App Router, TypeScript, Tailwind CSS)
- **Roles** — `STAFF` (mobile day-to-day ops) and `OWNER` (mobile + desktop review/reports)

---

## Quick start — Docker (one command)

Requires Docker with Compose v2.

```bash
docker compose up --build
```

That starts three services and wires them together:

| Service    | URL / port                    | Notes                                              |
|------------|-------------------------------|----------------------------------------------------|
| `db`       | localhost:5432                | PostgreSQL 16 (named volume `cpfs_pgdata`)          |
| `backend`  | http://localhost:8000         | Django/gunicorn — auto-migrates, seeds, serves admin |
| `frontend` | http://localhost:3000         | Next.js production server                           |

On first boot the backend waits for Postgres, runs migrations, `collectstatic`
(admin CSS served via WhiteNoise), and the idempotent `seed` command. Open
http://localhost:3000 and sign in with the demo logins below. Django admin is at
http://localhost:8000/admin.

```bash
docker compose down       # stop (keeps the DB volume)
docker compose down -v    # stop and wipe the DB volume for a clean re-seed
```

---

## Manual setup (without Docker)

### 1. Backend (`backend/`)

```bash
cd backend
python3.12 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env                 # optional; SQLite is used if DATABASE_URL is unset
python manage.py migrate
python manage.py seed                # demo outlet, users, products, channels, costs
python manage.py runserver           # http://localhost:8000
```

Seeded logins:

| Role  | Phone        | Password |
|-------|--------------|----------|
| Owner | 01700000000  | owner123 |
| Staff | 01800000000  | staff123 |

The owner is also a Django superuser — full catalog/pricing/settings CRUD is at
`http://localhost:8000/admin`.

To use PostgreSQL (per spec), set `DATABASE_URL` in `.env`:
```
DATABASE_URL=postgres://cp:cp@localhost:5432/cp_five_star
```

### 2. Frontend (`frontend/`)

```bash
cd frontend
npm install
cp .env.local.example .env.local     # NEXT_PUBLIC_API_BASE=http://localhost:8000/api
npm run dev                          # http://localhost:3000
```

Open http://localhost:3000, sign in, and you'll be routed to the staff mobile app
or owner dashboard based on role.

---

## What's implemented

### Data model (`backend/*/models.py`)
Every entity in `CLAUDE.md`: Outlet, User (phone login, roles), Product
(SINGLE/COMBO, prepared/direct-stock), ComboComponent, PackDefinition
(price-versioned), StockInRecord/Item, RawStock, PreparationLog (PACK/PIECE),
DisplayStock, SalesChannel (settlement/integration/commission config),
ChannelIntegration (schema-only, empty in v1), ChannelPrice, ChannelPromotion,
OrderLevelOffer, DailyClosing + StockCount/SalesLine/ChannelDiscount/PaymentEntry,
ChannelSettlement, CostCategory, Expense.

### Business logic (verified end-to-end)
- **Stock-in workflow** `DRAFT → PENDING → APPROVED/REJECTED`; RawStock only
  increments on owner approval. Staff can't approve (403).
- **Slip auto-count (OCR)** — staff attach a delivery-slip photo, and Tesseract
  reads the lines into `SLIP_EXTRACTED` items (`extracted_packs` kept for audit,
  `confirmed_packs` pre-filled). Staff correct any count and/or add `MANUAL`
  no-slip lines before submitting (`backend/stock/extraction.py`). Extraction is
  best-effort: the parser matches product names and pairs quantities even when
  the OCR splits names and counts into separate columns; it degrades to a clear
  "enter manually" message (HTTP 503) if Tesseract is unavailable — it never
  fabricates counts.
- **Preparation** decrements RawStock (PACK entries), increments DisplayStock;
  real-time, no approval.
- **Price resolution** — most-specific-wins: `ChannelPrice` → `ChannelPromotion`
  (product+channel → channel → product) → `Product.selling_price`
  (`backend/sales/pricing.py`).
- **Daily closing** — walk-in sales are *system-derived*
  (`available − wastage − remains − app_channel_sold`), priced at the resolved
  walk-in price; negative derived quantity raises a `flag`. Cash is computed
  (`offline sales − bKash − card`), never typed. Auto-locks unless flagged.
- **P&L** (accrual) and **settlement variance** reports (`backend/reports/`).

### Frontend
- **Staff mobile app** — bottom tabs Home / Stock In / Prep log / Closing.
  Closing is a checklist hub (Count → Online sell → Walk-in view-only → Payments),
  each its own screen; Count and Online-sell use the search + category-chip +
  full-list-with-inline-inputs pattern that marks rows green when filled.
- **Owner app** — responsive: desktop left sidebar + mobile bottom tabs. Home
  dashboard (P&L ledger + review counts), Approvals (approve/reject stock-in,
  accept flagged closings), Reports (P&L range + settlements), catalog overview.
- **Visual language** — ticket/receipt cards with torn-edge notches, rotated
  ink-stamp status badges, monospace figures, brand colors sampled from the logo.

## API surface

REST under `/api/` (see `backend/config/urls.py`). Auth: `POST /api/auth/login/`
returns `{access, refresh, user}`. Key custom actions:
`/api/stock-in/{id}/{submit,approve,reject}/`,
`/api/daily-closings/{id}/{stock-count,online-sell,channel-discounts,payments,submit,lock}/`,
`/api/price-resolve/`, `/api/reports/{pnl,settlements,dashboard}/`.

## Deferred (per spec — not built)
API sync for Foodpanda/Foodi, physical-cash reconciliation, per-order threshold
discounts. Schema hooks (`ChannelIntegration`, `integration_type`) exist but are
unused in v1.
