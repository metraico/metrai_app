# API Migration Plan: Sim-Engine → App-Backend

---

## 1. Executive Summary

- The sim-engine currently hosts auth, account management, and promo CRUD endpoints that duplicate logic already in the app-backend. These must be removed from the sim-engine after the app-backend versions are confirmed as the canonical source.
- The Next.js frontend has hardcoded split routing: several calls that should target the app-backend (`apiClient`, port 8001) instead hit the sim-engine (`engineClient`, port 8000). The most critical is the token-refresh interceptor in `lib/api/client.ts`, which hits ENGINE_URL — this is a live auth bug affecting all users.
- Five promo mutation endpoints (POST/PUT/DELETE promos, POST promo-groups, POST promos/upload) do not yet exist in the app-backend. They must be added before the sim-engine versions are removed.
- All simulation execution, rolling forecast, demand generation, ClickHouse analytics, SSE streams, and ZIP exports stay in the sim-engine permanently.
- The app-backend's existing wildcard analytics proxy (`GET /analytics/{simulation_id}/{path}`) and simulation proxy routes (`POST /run`, `DELETE /simulation/{id}`) are the correct pattern for future sim-engine access from authenticated contexts.

---

## 2. Current State

### Services and Ports

| Service | Port (local) | Language | Primary DB |
|---|---|---|---|
| sim-engine | 8000 | Python/FastAPI | PostgreSQL + ClickHouse |
| app-backend | 8001 | Python/FastAPI | PostgreSQL (shared schema) |
| Next.js frontend | 3000 | Next.js | — |

### Auth Model

Both services independently implement JWT issuance using the same secret. The app-backend uses Argon2id and has rate-limiting. The sim-engine auth endpoints are a lighter duplicate with no rate-limiting. Tokens minted by either service are accepted by both (shared secret), which means the split is currently invisible to users but creates two auth surfaces.

### Database Ownership

Both services connect to the **same PostgreSQL instance**. There is no schema ownership boundary enforced at the DB level. Tables like `users`, `retailer_accounts`, `user_accounts`, `refresh_tokens`, `promos`, `promo_groups` are written by both services today.

### Frontend Client Split

The Next.js frontend has two Axios instances:
- `apiClient` — targets `NEXT_PUBLIC_BACKEND_URL` (default port 8001, app-backend)
- `engineClient` — targets `NEXT_PUBLIC_ENGINE_URL` (default port 8000, sim-engine)

Several files route to the wrong client. The authoritative call-site files are:
- `/Users/niranjan/Metrai/MetraiCo/dev/metrai_app/metrai_nextjs/lib/api/client.ts`
- `/Users/niranjan/Metrai/MetraiCo/dev/metrai_app/metrai_nextjs/lib/api/auth.ts`
- `/Users/niranjan/Metrai/MetraiCo/dev/metrai_app/metrai_nextjs/lib/api/retailers.ts`
- `/Users/niranjan/Metrai/MetraiCo/dev/metrai_app/metrai_nextjs/lib/api/promos.ts`
- `/Users/niranjan/Metrai/MetraiCo/dev/metrai_app/metrai_nextjs/lib/api/simulation.ts`
- `/Users/niranjan/Metrai/MetraiCo/dev/metrai_app/metrai_nextjs/lib/api/analytics.ts`

---

## 3. Target Architecture

```
Browser (Next.js :3000)
        |
        |-- auth, account mgmt, run listing, ref-data CRUD
        |   --> app-backend :8001
        |           |-- proxies POST /run, DELETE /simulation/{id},
        |               GET /run-config/{id}, GET /analytics/{id}/{path}
        |               --> sim-engine :8000
        |
        |-- sim execution, rolling forecast, demand, analytics, SSE, ZIP
            --> sim-engine :8000 (direct, authenticated by same JWT)
```

**App-backend owns:**
- User and account lifecycle (`users`, `retailer_accounts`, `user_accounts`, `refresh_tokens`)
- Reference data CRUD (`promos`, `promo_groups`, `promo_group_items`, `promo_stores`)
- Run listing metadata (reads `simulation_config`)
- Run YAML template generation (reads `distribution_centers`, `suppliers`)
- Proxying simulation trigger (`POST /run`), deletion, run-config read, and all analytics

**Sim-engine owns:**
- All simulation execution and ClickHouse I/O
- Demand generation jobs
- Rolling forecast session lifecycle
- Analytics read endpoints
- SSE progress stream
- ZIP export stream
- Promo preview and YAML template helpers (tied to internal promo loading logic)
- Scenario validation (tied to `ScenarioResolver`)

**Sim-engine removes:**
- `/auth/register`, `/auth/login`, `/auth/refresh`
- `/retailers` (GET and POST)
- `/promos` (GET, POST, PUT, DELETE, upload) — after app-backend versions added
- `/promo-groups` (GET, POST) — after app-backend versions added
- `/runs` — after frontend migrated to app-backend
- `/run-yaml-template` — after frontend migrated to app-backend

---

## 4. Endpoint-by-endpoint Migration Table

### Auth (remove from sim-engine)

| Method | Path | Current | Target | Effort | Notes |
|---|---|---|---|---|---|
| POST | /auth/register | sim-engine `app/auth.py:55` | remove | Low | Frontend `lib/api/auth.ts` already calls BACKEND_URL — no frontend change needed |
| POST | /auth/login | sim-engine `app/auth.py:97` | remove | Low | Frontend `lib/api/auth.ts` already calls BACKEND_URL — no frontend change needed |
| POST | /auth/refresh | sim-engine `app/auth.py:157` | remove | **Critical** | `lib/api/client.ts:67` interceptor calls ENGINE_URL — must fix first |

### Account / Retailer Management (remove from sim-engine)

| Method | Path | Current | Target | Effort | Notes |
|---|---|---|---|---|---|
| GET | /retailers | sim-engine `app/retailers.py:34` | remove; use app-backend `/accounts` | Low | `lib/api/retailers.ts` uses `engineClient` — migrate to `apiClient` + path `/accounts` |
| POST | /retailers | sim-engine `app/retailers.py:67` | remove; use app-backend `/accounts` | Low | Same file, same fix |

### Promo / Promo-Group CRUD (remove from sim-engine after app-backend additions)

| Method | Path | Current | Target | Effort | Notes |
|---|---|---|---|---|---|
| GET | /promos | sim-engine `app/promos.py:94` | remove; app-backend `/promos` already exists | Low | `lib/api/promos.ts` `getPromos()` uses `engineClient` — migrate to `apiClient`; `entities.ts` already correct |
| GET | /promo-groups | sim-engine `app/promos.py:135` | add to app-backend, then remove from engine | Medium | `lib/api/promos.ts` `getPromoGroups()` uses `engineClient` — migrate after app-backend endpoint added |
| POST | /promo-groups | sim-engine `app/promos.py:179` | add to app-backend, then remove from engine | Medium | No frontend caller confirmed; verify before removal |
| POST | /promos | sim-engine `app/promos.py:238` | add to app-backend, then remove from engine | Medium | No frontend caller confirmed |
| PUT | /promos/{promo_id} | sim-engine `app/promos.py:321` | add to app-backend, then remove from engine | Medium | No frontend caller confirmed |
| DELETE | /promos/{promo_id} | sim-engine `app/promos.py:425` | add to app-backend, then remove from engine | Medium | No frontend caller confirmed |
| POST | /promos/upload | sim-engine `app/promos.py:465` | add to app-backend, then remove from engine | Medium | No frontend caller confirmed |

### Run Listing / Metadata (remove from sim-engine)

| Method | Path | Current | Target | Effort | Notes |
|---|---|---|---|---|---|
| GET | /runs | sim-engine `app/main.py:2189` | remove; app-backend `/runs` already exists | Low | `lib/api/simulation.ts` `getRuns()` uses `engineClient` — migrate to `apiClient` |
| GET | /run-yaml-template | sim-engine `app/main.py:5447` | remove; app-backend already has it | Low | `lib/api/simulation.ts` `getRunYamlTemplate()` uses `engineClient` — migrate to `apiClient` |
| GET | /run-config/{simulation_id} | sim-engine `app/main.py:4483` | keep in engine; frontend should use app-backend proxy | Low | `lib/api/simulation.ts` `getRunConfig()` uses `engineClient` — migrate to `apiClient`; app-backend proxy at `GET /run-config/{id}` already exists `backend/main.py:873` |

### Simulation Execution (stays in sim-engine)

| Method | Path | Current | Target | Effort | Notes |
|---|---|---|---|---|---|
| POST | /simulate | sim-engine `app/main.py:2416` | keep in engine | Medium | Frontend `runSimulation()` calls `engineClient` directly — should route through app-backend `POST /run` for auth enforcement; engine endpoint itself stays |
| GET | /simulate-progress/{id} | sim-engine `app/main.py:2702` | keep in engine | None | SSE — cannot proxy without relay |
| POST | /simulate/validate | sim-engine `app/main.py:5311` | keep in engine | None | — |
| GET | /simulate/preview | sim-engine `app/main.py:5343` | keep in engine | None | Frontend already uses `engineClient` correctly |
| GET | /promo-yaml-template | sim-engine `app/main.py:5403` | keep in engine | None | Frontend already uses `engineClient` correctly |
| POST | /scenario/validate | sim-engine `app/main.py:5541` | keep in engine | None | App-backend already proxies; engine retains implementation |

### Simulation Lifecycle (stays in sim-engine)

| Method | Path | Current | Target | Effort | Notes |
|---|---|---|---|---|---|
| GET | /simulation/{id} | sim-engine `app/main.py:4145` | keep in engine | Low | Frontend `getSimulation()` calls `engineClient` directly — should use app-backend proxy `backend/main.py:860` for auth; engine retains |
| GET | /simulation/{id}/export | sim-engine `app/main.py:4223` | keep in engine | None | ZIP stream — cannot proxy; frontend uses bare URL with no auth header |
| DELETE | /simulation/{id} | sim-engine `app/main.py:4438` | keep in engine | None | App-backend proxy exists at `backend/main.py:886` |
| GET | /simulation/{id}/ending-inventory | sim-engine `app/main.py:2997` | keep in engine | None | — |
| GET | /simulation/{id}/extensions | sim-engine `app/main.py:3060` | keep in engine | None | — |
| POST | /simulation/{id}/extend | sim-engine `app/main.py:3609` | keep in engine | None | — |
| POST | /simulation/{id}/extension-promos | sim-engine `app/main.py:1787` | keep in engine | None | — |
| GET | /simulation/{id}/promo-groups | sim-engine `app/main.py:781` | keep in engine | None | — |
| POST | /simulation/{id}/rolling-session | sim-engine `app/main.py:849` | keep in engine | None | — |
| GET | /simulation/{id}/rolling-session | sim-engine `app/main.py:1081` | keep in engine | None | — |

### Rolling Forecast (stays in sim-engine)

| Method | Path | Current | Target | Effort | Notes |
|---|---|---|---|---|---|
| DELETE | /rolling-session/{id} | sim-engine `app/main.py:1099` | keep in engine | None | — |
| GET | /rolling-session/{id}/promo-schedules | sim-engine `app/main.py:1155` | keep in engine | None | — |
| GET | /rolling-session/{id}/pos-summary | sim-engine `app/main.py:1217` | keep in engine | None | — |
| POST | /rolling-session/{id}/run-chunk | sim-engine `app/main.py:3750` | keep in engine | None | — |
| POST | /rolling-session/{id}/recalculate-demand | sim-engine `app/main.py:3964` | keep in engine | None | — |

### Demand Generation (stays in sim-engine)

| Method | Path | Current | Target | Effort | Notes |
|---|---|---|---|---|---|
| POST | /demand/generate | sim-engine `app/main.py:1403` | keep in engine | None | — |
| GET | /demand/status/{job_id} | sim-engine `app/main.py:1753` | keep in engine | None | — |
| POST | /demand/generate/extend | sim-engine `app/main.py:1902` | keep in engine | None | — |
| GET | /demand/weekly-totals | sim-engine `app/main.py:1931` | keep in engine | None | — |

### Analytics (stays in sim-engine; proxied by app-backend wildcard)

All `GET /analytics/{simulation_id}/*` and `/analytics-status/{id}` stay in sim-engine. App-backend wildcard proxy at `backend/main.py:899` covers authenticated access. Frontend `analytics.ts` calls `engineClient` directly — this is acceptable for high-volume reads but consider routing through the app-backend proxy for consistency.

### Admin

| Method | Path | Current | Target | Effort | Notes |
|---|---|---|---|---|---|
| GET | /health | both services | keep both | None | Each service needs its own liveness probe |

---

## 5. Phased Migration Plan

### Phase 1 — Fix Auth and Routing Bugs (no backend changes required)

**Goal:** Eliminate the live auth bug and fix misrouted frontend calls that have existing correct targets.

**Steps:**

1. **Fix token-refresh interceptor** — `lib/api/client.ts:67`
   - Change the `/auth/refresh` call from `ENGINE_URL` to `BACKEND_URL`
   - The app-backend endpoint is `POST /refresh` at `backend/main.py:445`
   - The path in the interceptor currently sends to `/auth/refresh`; the app-backend path is `/refresh` (no `/auth` prefix) — update the path as well
   - This is the sole blocker for removing the three sim-engine auth endpoints

2. **Migrate `lib/api/retailers.ts`** — both `getRetailers()` and `createRetailer()`
   - Switch from `engineClient` to `apiClient`
   - Change path from `/retailers` to `/accounts` for both GET and POST

3. **Migrate `lib/api/simulation.ts`** — three functions
   - `getRuns()`: switch from `engineClient` to `apiClient`; path `/runs` is the same
   - `getRunYamlTemplate()`: switch from `engineClient` to `apiClient`; path `/run-yaml-template` is the same
   - `getRunConfig()`: switch from `engineClient` to `apiClient`; path `/run-config/{id}` is the same (proxy exists in app-backend at `backend/main.py:873`)

4. **Migrate `lib/api/promos.ts` `getPromos()`**
   - Switch from `engineClient` to `apiClient`; path `/promos` is the same
   - `entities.ts` already calls `apiClient` for the same endpoint — consolidate to a single caller

5. **Remove the three sim-engine auth endpoints** (`/auth/register`, `/auth/login`, `/auth/refresh`) from `app/auth.py`
   - Confirm no non-frontend callers (scripts, curl, tests) still target them before deletion

6. **Remove sim-engine `/retailers` GET and POST** from `app/retailers.py`

**Frontend files changed in Phase 1:**
- `metrai_nextjs/lib/api/client.ts` (interceptor fix)
- `metrai_nextjs/lib/api/retailers.ts` (client + path)
- `metrai_nextjs/lib/api/simulation.ts` (3 functions)
- `metrai_nextjs/lib/api/promos.ts` (1 function)

**Risks:**
- The interceptor fix changes the path (`/auth/refresh` → `/refresh`). Verify the app-backend `POST /refresh` body schema matches what the interceptor sends (should be `{ refresh_token: "..." }`).
- After removing sim-engine auth, any test fixtures or integration scripts that call sim-engine directly for auth will break. Audit `tests/` in both repos before cutting.

---

### Phase 2 — Add Missing Promo Mutation Endpoints to App-Backend

**Goal:** Add the 5 promo mutation endpoints that currently exist only in the sim-engine, then remove them from the sim-engine.

**Steps:**

1. **Add `GET /promo-groups`** to `app-backend/main.py`
   - Copy logic from `sim-engine/app/promos.py:135`
   - Enforce `retailer_account_id` from JWT (same pattern as existing `GET /promos` in app-backend)
   - Response shape must match what `lib/api/promos.ts` `getPromoGroups()` expects (used in `rolling-forecast-modal.tsx` and `run-chunk-modal.tsx`)

2. **Add `POST /promo-groups`** to app-backend
   - Copy from `sim-engine/app/promos.py:179`
   - Enforce auth

3. **Add `POST /promos`** to app-backend
   - Copy from `sim-engine/app/promos.py:238`

4. **Add `PUT /promos/{promo_id}`** to app-backend
   - Copy from `sim-engine/app/promos.py:321`

5. **Add `DELETE /promos/{promo_id}`** to app-backend
   - Copy from `sim-engine/app/promos.py:425`

6. **Add `POST /promos/upload`** to app-backend
   - Copy from `sim-engine/app/promos.py:465`
   - This is a multipart file upload — verify app-backend has `python-multipart` installed

7. **Migrate `lib/api/promos.ts` `getPromoGroups()`** from `engineClient` to `apiClient` after step 1 above is deployed

8. **Remove all 7 promo/promo-group endpoints** from `sim-engine/app/promos.py` after verifying no direct callers remain

**Frontend files changed in Phase 2:**
- `metrai_nextjs/lib/api/promos.ts` (`getPromoGroups()` client switch)

**Risks:**
- The sim-engine promo endpoints have access to the same PG tables (`promos`, `promo_groups`, `promo_group_items`, `promo_stores`). Since both services share the DB, data written by one is immediately visible to the other — no data migration needed.
- The sim-engine still reads promos internally at simulation time (via `load_static` / `promos.py` query helpers). Removing the HTTP endpoints does not remove the DB query layer. Confirm that the engine's internal promo loading is not routed through its own HTTP layer.
- `POST /promos/upload` bulk-upserts promo groups. Confirm the app-backend version runs inside a transaction with rollback on partial failure (match sim-engine behavior).

---

### Phase 3 — Sim-Engine Stays; Verify Proxy Coverage

**Goal:** Confirm that app-backend proxy routes cover all authenticated access patterns for sim execution endpoints. No endpoint moves in this phase.

**Steps:**

1. **Audit `runSimulation()`** in `lib/api/simulation.ts:47`
   - Currently calls `engineClient` directly (`POST /simulate`)
   - App-backend `POST /run` (`backend/main.py:776`) and `POST /run/yaml` (`backend/main.py:802`) are the correct proxies
   - Decide whether to migrate `runSimulation()` to call `apiClient POST /run` or leave as direct engine call
   - **Recommendation:** migrate — the proxy injects `retailer_account_id` and `user_id` from the JWT, which the engine needs but cannot extract on its own if called directly without auth

2. **Audit `getSimulation()`** in `lib/api/simulation.ts:97`
   - Currently calls `engineClient` directly
   - App-backend proxy exists at `backend/main.py:860`
   - Migrate to `apiClient` if consistent auth enforcement is required

3. **Verify the analytics wildcard proxy** at `backend/main.py:899` correctly forwards all query params
   - The proxy uses `{path}` — confirm path matching covers sub-paths like `summary/store-sales`
   - Frontend `analytics.ts` calls `engineClient` directly; this is acceptable for performance but inconsistent with auth model

4. **Verify SSE and ZIP export remain direct**
   - `GET /simulate-progress/{id}` — confirm frontend SSE connection targets `ENGINE_URL` directly
   - `GET /simulation/{id}/export` — confirm frontend uses a bare URL constructed from `NEXT_PUBLIC_ENGINE_URL`; the `getSimulationExportUrl()` function in `lib/api/simulation.ts:109` returns a URL string with no auth header — this is by design for ZIP download via `<a href>` but means the export endpoint cannot require auth

**No sim-engine code changes in this phase.**

---

## 6. Cross-Cutting Concerns

### Shared PostgreSQL Database

Both services share the same PG instance and schema. There is no migration needed to move data — only the HTTP endpoints and application-layer logic move. However:

- Once promo mutation endpoints are removed from sim-engine, **only app-backend writes** to `promos`, `promo_groups`, `promo_group_items`, `promo_stores`. The sim-engine retains read-only access for simulation execution.
- Once auth endpoints are removed from sim-engine, **only app-backend writes** to `users`, `refresh_tokens`, `user_accounts`. The sim-engine retains read-only access for JWT validation.
- Enforce this ownership convention in code reviews going forward. Consider adding a read-only PG role for the sim-engine once writes are fully consolidated in app-backend.

### JWT Shared Secret

Both services validate JWTs using the same secret (implicit from the current working state). This is intentional and must remain — the sim-engine must accept tokens minted by the app-backend. Ensure `JWT_SECRET` (or equivalent env var name) is set identically in both services' environment configs and Docker Compose files.

### Service-to-Service Authentication

The app-backend proxies calls to the sim-engine (e.g., `POST /run` → `POST /simulate`). Currently the proxy passes the user's Bearer token through to the sim-engine. This means the sim-engine continues to validate JWTs on proxied requests. This pattern is correct and should be preserved. Do not introduce a separate service-to-service credential at this stage.

### Duplicate API Functions in Frontend

`lib/api/simulation.ts` defines `generateDemand()` and `getDemandStatus()` but these are also defined in `lib/api/demand.ts`. Consolidate to a single file (prefer `demand.ts`) and remove the duplicates from `simulation.ts` as a cleanup step during Phase 1 or 2.

### Rolling-Forecast YAML Calls Bypass Interceptor

`createRollingSessionYaml()` (`simulation.ts:181`) and `runRollingChunkYaml()` (`simulation.ts:204`) use raw `fetch()` with a manual `localStorage.getItem('access_token')` lookup. These bypass the Axios interceptor and its automatic token refresh. If the access token expires mid-session, these calls will 401 without retry. Fix by converting to `engineClient` Axios calls (which handle YAML via `Content-Type: application/yaml` header) or by wrapping the raw fetch in explicit token-refresh logic.

### Shared Models / Schemas

Both services define Pydantic models for entities like `Promo`, `PromoGroup`, etc. When adding promo mutation endpoints to the app-backend, copy the Pydantic request/response models from `sim-engine/app/promos.py` exactly — do not create divergent schemas, as the frontend expects a single shape.

---

## 7. Open Questions / Decisions Required

1. **`/auth/refresh` path discrepancy**: The frontend interceptor calls `/auth/refresh`, but the app-backend endpoint is `POST /refresh` (no `/auth` prefix). Confirm the app-backend path before the interceptor fix — or add a `/auth/refresh` alias to the app-backend to reduce the diff.

2. **Sim-engine `/run-yaml-template` vs app-backend `/run-yaml-template`**: Both exist. Confirm the two implementations produce identical output given the same `retailer_account_id`. If they differ, decide which version is canonical before removing the engine version.

3. **`GET /simulation/{id}/export` auth**: This endpoint is called via a bare URL with no Bearer header. If you add auth to this endpoint, the `<a href>` download pattern breaks. Decide: keep unauthenticated (acceptable for a time-limited signed URL model) or switch to a server-side download proxy with auth header injection.

4. **Analytics direct vs proxied**: Frontend `analytics.ts` calls `engineClient` directly for all analytics. App-backend has a wildcard proxy. Decide: should analytics calls go through the proxy for consistent auth enforcement, or stay direct for performance? If direct, the sim-engine analytics endpoints must remain unauthenticated (or accept the same JWT).

5. **`hidden_lost_sales` scenario type**: The existing MIGRATION_PLAN.md flags this as an open question. Confirm whether this scenario type is implemented and active in the current sim-engine before building the scenario UI page.

6. **Promo mutation frontend callers**: No frontend callers were found for `POST /promos`, `PUT /promos/{id}`, `DELETE /promos/{id}`, `POST /promo-groups`, or `POST /promos/upload`. Confirm these are used only from the Streamlit frontend (being deprecated) and not from any currently active Next.js page. If so, they can be added to the app-backend as part of Phase 2 without immediate frontend wiring.

7. **Transaction behavior on `POST /promos/upload`**: The sim-engine version bulk-upserts. Confirm whether partial-failure rollback is required when porting to app-backend, especially if promo groups and promos are inserted in the same request.

8. **Read-only PG role for sim-engine**: Once Phase 2 is complete, sim-engine should no longer write to `promos`, `promo_groups`, `users`, `refresh_tokens`. Consider creating a restricted DB role to enforce this. Decide whether to do this as part of Phase 2 or as a post-Phase-2 hardening step.