# metrai_app

Application layer for Metrai. A FastAPI backend that orchestrates the simulation engine, and a Streamlit dashboard that provides a UI for configuring and running simulations and visualising results.

---

## Architecture

```
Browser
  └── Streamlit UI  (frontend/app.py)
        │  POST /run  {simulation config}
        ▼
  FastAPI Backend  (backend/main.py  :8000)
        │  POST /simulate  {simulation config}
        ▼
  metrai_simulation_engine  (:8001)
        │  runs demand generation + inventory simulation
        ▼
  FastAPI Backend
        │  returns JSON results
        ▼
  Streamlit UI  renders charts, KPIs, tables
```

The Streamlit UI never calls the simulation engine directly — all requests go through the backend.

---

## Project structure

```
metrai_app/
├── backend/
│   └── main.py          FastAPI backend — proxies requests to the simulation engine
├── frontend/
│   └── app.py           Streamlit dashboard — config sidebar, charts, KPIs, raw tables
├── .env
├── .env.example
├── requirements.txt
└── README.md
```

---

## Prerequisites

The simulation engine must be running before you start this app.

See [metrai_simulation_engine](../metrai_simulation_engine/README.md) for setup instructions. It runs on port `8001` by default.

---

## Local setup

```bash
cd metrai_app

# Create and activate virtual environment
python3 -m venv .venv
source .venv/bin/activate

# Install dependencies
pip install -r requirements.txt
```

**Terminal 1 — Backend:**
```bash
source .venv/bin/activate
uvicorn backend.main:app --port 8000 --reload
```

**Terminal 2 — Streamlit:**
```bash
source .venv/bin/activate
streamlit run frontend/app.py
```

Streamlit opens automatically at `http://localhost:8501`.

---

## Environment variables

Copy `.env.example` to `.env` and adjust if needed.

| Variable | Default | Description |
|---|---|---|
| `SIM_ENGINE_URL` | `http://localhost:8001` | URL of the simulation engine service |
| `BACKEND_URL` | `http://localhost:8000` | URL of this backend (read by the Streamlit frontend) |
| `PORT` | `8000` | Port the backend listens on (used for reference — set via uvicorn flag) |

---

## API endpoints

### `GET /health`

Health check.

**Response**
```json
{ "status": "ok" }
```

---

### `POST /run`

Accepts a simulation configuration, forwards it to the simulation engine, and returns the results.

**Request body** — same fields as `POST /simulate` on the simulation engine. All fields are optional.

| Field | Type | Default | Description |
|---|---|---|---|
| `dataset` | string | `saltysnack_beverages_small` | Dataset to simulate |
| `start_date` | date | `2024-01-01` | Simulation start date (ISO 8601) |
| `end_date` | date | `2024-03-31` | Simulation end date (ISO 8601) |
| `replenishment_policy` | string | `trailing_avg_28d` | One of: `trailing_avg_28d`, `promo_aware_7d`, `baseline_only` |
| `smoothing_days` | int | `28` | Demand smoothing window in days |
| `store_reorder_weeks` | int | `2` | Store reorder trigger in weeks of cover |
| `store_target_weeks` | int | `3` | Store target stock in weeks of cover |
| `store_start_days` | int | `14` | Store starting stock in days of cover |
| `store_order_dow` | string | `MONDAY` | Day stores place orders |
| `dc_reorder_weeks` | int | `2` | DC reorder point in weeks of cover |
| `dc_target_weeks` | int | `5` | DC target stock in weeks of cover |
| `dc_start_days` | int | `30` | DC starting stock in days of cover |
| `dc_review_dow` | string | `MONDAY` | Day DCs raise supplier POs |
| `sup_lead_min` | int | `3` | Min supplier lead time (days) |
| `sup_lead_max` | int | `7` | Max supplier lead time (days) |
| `sup_on_time` | float | `0.90` | Supplier on-time rate (0.0–1.0) |
| `sup_partial` | float | `0.10` | Supplier partial delivery rate (0.0–1.0) |
| `dc_on_time` | float | `0.95` | DC → Store on-time rate (0.0–1.0) |
| `dc_partial` | float | `0.05` | DC → Store partial delivery rate (0.0–1.0) |
| `seed` | int | `42` | Random seed for reproducibility |

**Response** — proxied directly from the simulation engine. See the simulation engine README for full response field descriptions.

**Error responses**

| Status | Meaning |
|---|---|
| `503` | Simulation engine is not reachable |
| `504` | Simulation exceeded the 300-second timeout |

**Example request**
```bash
curl -X POST http://localhost:8000/run \
  -H "Content-Type: application/json" \
  -d '{
    "dataset": "saltysnack_beverages_small",
    "start_date": "2024-01-01",
    "end_date": "2024-03-31",
    "seed": 42
  }'
```

---

## Streamlit dashboard

The dashboard mirrors the simulation configuration and results in a browser UI.

**Sidebar** — configure all simulation parameters: dataset, date range, replenishment policy, store/DC/supplier settings, random seed.

**Run Simulation** — click the button to send the configuration to the backend. A spinner shows while the simulation runs.

**Results panels** (shown after a successful run):
- Summary metrics: item count, store count, DC count
- KPIs for the selected store/item: total demand, sales, lost sales, fill rate, stockout days, revenue
- Daily chart: demand vs sales vs on-hand inventory
- Weekly chart: aggregated demand, sales, and average inventory
- Inventory status heatmap: all stores over time for the selected item
- Raw data expanders: demand matrix, daily sales, inventory, receipts, and orders
