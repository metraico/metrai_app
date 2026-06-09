# Frontend Migration Plan: Streamlit → Next.js

> **Purpose:** Track the migration from `frontend/` (Python/Streamlit) to `metrai_nextjs/` (Next.js)
> **Last updated:** 2026-06-08
> **Status:** In progress

---

## API Audit (from live Swagger)

> Backend: http://localhost:8001/docs | Simulation Engine: http://localhost:8000/docs
> Frontend talks **only to port 8001** (backend proxies analytics to engine)

### Bugs found & fixed

| Bug | File | Fix Applied |
|-----|------|-------------|
| Port was `8000`, backend is on `8001` | `.env.local` | ✅ Fixed |
| `GET /retailers` doesn't exist — should be `/accounts` | `lib/api/retailers.ts` | ✅ Fixed |
| `GET /runs` on backend takes **no query params** (uses auth token) | `lib/api/simulation.ts` + runs page | ✅ Fixed |
| Summary analytics endpoints missing (server-side aggregation) | `lib/api/analytics.ts` | ✅ Added |

### Full backend endpoint map (port 8001)

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| POST | `/register` | No | Returns `{user_id, username, email, full_name, role}` — no tokens |
| POST | `/login` | No | Returns `{access_token, refresh_token, token_type, user_id, retailer_account_id, full_name}` |
| POST | `/refresh` | No | Returns `{access_token, refresh_token, token_type}` |
| POST | `/logout` | Yes | Body: `{refresh_token}` |
| GET | `/accounts` | Yes | Returns array of retailer accounts |
| POST | `/accounts` | Yes | Create new account |
| POST | `/switch-account` | Yes | Body: `{retailer_account_id}` → returns new tokens |
| GET | `/runs` | Yes | No params — account from token |
| GET | `/entities` | Yes | Items, stores, DCs, suppliers |
| GET | `/mappings` | Yes | Store/DC/supplier mappings |
| POST | `/mappings` | Yes | Save mappings |
| GET | `/promos` | Yes | All promos for account |
| GET | `/run-yaml-template` | Yes | Pre-filled YAML with entities |
| POST | `/run/yaml` | Yes | Body: `{yaml_content}` → proxies to engine `/simulate` |
| POST | `/scenario/validate` | Yes | Body: `{scenario_yaml, start_date?, end_date?}` |
| GET | `/simulation/{id}` | Yes | Full simulation result |
| DELETE | `/simulation/{id}` | Yes | — |
| GET | `/run-config/{id}` | Yes | Config + status |
| GET | `/analytics/{id}/{path}` | Yes | Proxy to engine — supports all paths below |

### Analytics paths (via proxy, engine port 8000)

| Path suffix | Query params | Notes |
|-------------|-------------|-------|
| `meta` | — | Items/stores/DCs metadata |
| `store-sales` | `item_id?`, `store_id?` | Raw POS + store inventory |
| `store-inventory` | `item_id?`, `store_id?` | Store inventory only |
| `supply-chain-sales` | `item_id?`, `supplier_dc_id?`, `retailer_dc_id?` | Shipments |
| `upstream-inventory` | `item_id?`, `dc_id?`, `supplier_dc_id?` | DC + supplier DC inventory |
| `summary/store-sales` | — | **Pre-aggregated** — use for charts |
| `summary/store-inventory` | — | **Pre-aggregated** |
| `summary/supply-chain-sales` | — | **Pre-aggregated** |
| `summary/upstream-inventory` | — | **Pre-aggregated** |

---

## Phase 1 — Feature Parity Audit

### Already in Next.js ✅

- Login / Register / Logout (JWT, token refresh)
- Retailers list + account switch
- Runs list + delete with confirmation
- New Simulation wizard (3 steps: Run Config → Scenario → Review)
- Simulation run monitor (real-time polling, elapsed timer, auto-redirect)
- Analytics results page (4 charts, KPI summary cards)

### Missing from Next.js ❌

| # | Feature | Old file | Notes |
|---|---------|----------|-------|
| 1 | Store/item filter dropdowns on charts | `pages/simulation.py` | Re-fetch analytics with `?store_id=&item_id=` params |
| 2 | Scenario setup page (promo + hidden_lost_sales) | `pages/scenario_setup.py` (850 lines) | Full YAML builder + validate + preview |
| 3 | Export tab (14 CSVs + ZIP download) | `utils/export.py` (522 lines) | Client-side ZIP using jszip |
| 4 | Data quality report (8 validation checks) | `utils/export.py` | Inline UI panel in Export tab |
| 5 | Run manifest JSON download | `utils/export.py` | Single JSON with run metadata |
| 6 | Debug tab (14 raw data tables) | `pages/simulation.py` | Paginated raw table views |
| 7 | Promo/anomaly week highlighting on charts | `pages/simulation.py` | Recharts `ReferenceArea` shading |
| 8 | Hidden lost sales scenario type | `pages/scenario_setup.py` | Second scenario type in step 2 |
| 9 | Run details page (metadata view) | `pages/run_details.py` | Config/period/seed/notes |

---

## Phase 2 — Implementation Order

> Priority order — change as needed

### Step 1: Scenario Setup Page
- **Route:** `/retailers/[retailerAccountId]/scenario`
- **File to create:** `app/retailers/[retailerAccountId]/scenario/page.tsx`
- Scenario type selector: `promo_forecast` vs `hidden_lost_sales`
- YAML editor + `POST /scenario/validate` call
- Preview panel: show promo windows, warnings from API response
- Wire into sidebar (already has "Scenario Setup" link)

**Comments / edits:**
<!-- Add your notes here -->

---

### Step 2: Store/Item Filters on Results Page
- **File to edit:** `app/retailers/[retailerAccountId]/simulation/[runId]/page.tsx`
- Add store and item dropdown selectors above charts
- On change, re-fetch `getStoreSales`, `getStoreInventory`, `getSupplyChainSales`, `getUpstreamInventory` with filter params
- Use `getEntities()` to populate dropdown options

**Comments / edits:**
<!-- Add your notes here -->

---

### Step 3: Promo/Anomaly Chart Highlighting
- **File to edit:** `app/retailers/[retailerAccountId]/simulation/[runId]/page.tsx`
- Parse `is_promo_demand` flag from POS records
- Add `<ReferenceArea>` components in Recharts for promo weeks (amber shading)
- Add legend entry for "Promo Week"

**Comments / edits:**
<!-- Add your notes here -->

---

### Step 4: Run Details Page
- **Route:** `/retailers/[retailerAccountId]/runs/[runId]`
- **File to create:** `app/retailers/[retailerAccountId]/runs/[runId]/page.tsx`
- Fetch `GET /run-config/{id}` and display: simulation name, period, seed, granularity, status, created_at
- Link from runs list page

**Comments / edits:**
<!-- Add your notes here -->

---

### Step 5: Export Tab on Results Page
- **File to edit:** `app/retailers/[retailerAccountId]/simulation/[runId]/page.tsx`
- Add "Export" tab alongside existing charts
- 14 CSV download buttons (one per feed: SiteInformation, ItemInformation, WeeklyPOS, WeeklyShipments, etc.)
- "Download All (ZIP)" button using `jszip` (already in dependencies? check package.json)
- Data quality panel: 8 validation checks displayed inline

**Comments / edits:**
<!-- Add your notes here -->

---

### Step 6: Debug Tab on Results Page
- **File to edit:** `app/retailers/[retailerAccountId]/simulation/[runId]/page.tsx`
- Add "Debug" tab
- 14 raw data tables, paginated (25 rows per page, simple slice + useState)
- Column headers from TypeScript interfaces in `lib/api/types.ts`

**Comments / edits:**
<!-- Add your notes here -->

---

## Phase 3 — Docker & Deployment

### Files to update

**`docker-compose.yml`**
```yaml
# BEFORE (Streamlit)
frontend:
  build:
    context: .
    dockerfile: Dockerfile.frontend
  ports:
    - "8503:8501"
  environment:
    - BACKEND_URL=http://backend:8000

# AFTER (Next.js)
frontend:
  build:
    context: ./metrai_nextjs
    dockerfile: Dockerfile
  ports:
    - "3000:3000"
  environment:
    - NEXT_PUBLIC_BACKEND_URL=http://backend:8000
```

**`Dockerfile.frontend` → replace or create `metrai_nextjs/Dockerfile`**
```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
EXPOSE 3000
CMD ["node", "server.js"]
```

> Note: requires `output: 'standalone'` in `next.config.js`

**Comments / edits:**
<!-- Add your notes here -->

---

## Phase 4 — Cutover

1. Run both frontends side-by-side on different ports for final comparison
2. `git mv frontend frontend_archived` (keeps history, nothing deleted yet)
3. Update any CI/CD scripts or README references to the old `frontend/` path
4. Remove `frontend_archived/` once verified

**Comments / edits:**
<!-- Add your notes here -->

---

## Phase 5 — Post-Cutover Cleanup

- Remove `Dockerfile.frontend` (replaced by `metrai_nextjs/Dockerfile`)
- Remove `frontend/requirements.txt` references from any CI
- Update `README.md` with new dev setup instructions (`npm run dev` instead of `streamlit run`)
- Archive or delete `frontend_archived/`

**Comments / edits:**
<!-- Add your notes here -->

---

## Open Questions

> Add blockers, decisions pending, or things to confirm

- [ ] Is `jszip` already installed in `metrai_nextjs/`? If not, `npm install jszip`
- [ ] Does `next.config.js` need `output: 'standalone'` for Docker build?
- [ ] Which 14 export feeds exactly? Cross-check with `utils/export.py`
- [ ] Is the `hidden_lost_sales` scenario type active / supported by the current backend?
- [ ] Should the Scenario Setup page be separate from the simulation wizard or merged into Step 2?

---

## Notes

<!-- General notes, decisions made, anything else -->
