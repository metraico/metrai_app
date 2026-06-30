# Backend API Test Suite

Integration tests for `metrai_app/backend`. Each test makes a real HTTP request to a
live docker-compose stack and asserts on the response.

- **Backend** at `BACKEND_URL` (default `http://localhost:8080`)
- **Sim engine** at `ENGINE_URL` (default `http://localhost:8000`)
- **Demo user** (seeded by backend on startup): `demo` / `12345678`

```bash
cd /Users/niranjan/Metrai/MetraiCo/dev/metrai_app
.venv-tests/bin/python -m pytest tests/ -v
```

**Current state:** 54 passed, 1 skipped, 0 failed.

---

## Fixtures (`tests/conftest.py`)

| Fixture | Scope | What it provides |
|---|---|---|
| `backend_url`, `engine_url` | session | Configurable base URLs from env vars |
| `client` | function | Unauthenticated httpx client on the app backend |
| `engine_client` | function | Unauthenticated httpx client on the sim engine |
| `demo_token` | session | Access token from a single `/auth/login` as `demo` (NOT account-scoped — `retailer_account_id` is `""`) |
| `authed_client` | function | Backend client with `Authorization: Bearer <demo_token>` |
| `authed_engine_client` | function | Engine client with the demo token (cross-service tests) |
| `account_scoped_token` | session | Token *after* `/switch-account` — has a real `retailer_account_id` in the JWT. Needed for any endpoint that reads the account from the token. |
| `account_client` | function | Backend client with the account-scoped token |
| `account_engine_client` | function | Engine client with the account-scoped token |
| `random_username` | function | Unique username (`pytest_<hex>`) for register-flow tests |

**`real_promo` and `real_promo_name`** (local to `test_simulation_proxy.py`) — fetch a real
promo + its date range from `/promos` so scenario validation tests don't hard-code data
that might drift.

---

## Markers (`pytest.ini`)

| Marker | Run with |
|---|---|
| `auth` | `pytest -m auth` |
| `accounts` | `pytest -m accounts` |
| `metadata` | `pytest -m metadata` |
| `simulation` | `pytest -m simulation` |
| `integration` | `pytest -m integration` (every test in this suite — they all hit live HTTP) |

---

## `test_auth.py` — 15 tests

Authentication flow: login, register, refresh, logout, alias routes, and the cross-service JWT validation.

| # | Test | What it verifies |
|---|---|---|
| 1 | `test_login_demo_success` | `POST /auth/login` with demo creds → 200; response carries `access_token`, `refresh_token`, and a `user` payload |
| 2 | `test_login_wrong_password` | Wrong password → 401 |
| 3 | `test_login_unknown_user` | Username that doesn't exist → 401 |
| 4 | `test_login_missing_password` | Missing `password` field → 422 |
| 5 | `test_login_missing_username` | Missing `username` field → 422 |
| 6 | `test_register_new_user_and_login` | `POST /auth/register` with a unique random username succeeds, then `/auth/login` with those creds returns tokens |
| 7 | `test_register_duplicate_username` | Re-registering the same username → 409 |
| 8 | `test_refresh_valid_token` | `POST /auth/refresh` with a fresh refresh_token returns a new access_token (and rotates the refresh_token — single-use) |
| 9 | `test_refresh_invalid_token` | Garbage refresh_token → 401 |
| 10 | `test_logout_revokes_refresh_token` | After `/auth/logout`, the same refresh_token cannot be used to refresh — second `/auth/refresh` returns 401 |
| 11 | `test_login_alias` | The unprefixed `/login` alias behaves identically to `/auth/login` |
| 12 | `test_register_alias` | The unprefixed `/register` alias behaves identically to `/auth/register` |
| 13 | `test_protected_route_no_token` | `GET /accounts` without `Authorization` header → 401 |
| 14 | `test_protected_route_with_token` | `GET /accounts` with the demo token → 200 |
| 15 | `test_engine_accepts_app_backend_jwt` | Cross-service: the engine accepts a JWT issued by the app backend (verifies shared `JWT_SECRET`). Asserts the engine doesn't return 401 — 422 for missing query params is OK, that's not an auth failure |

---

## `test_accounts.py` — 9 tests

Account ownership and the `/switch-account` flow that issues an account-scoped JWT.

| # | Test | What it verifies |
|---|---|---|
| 1 | `test_list_accounts_unauthenticated` | `GET /accounts` without auth → 401 |
| 2 | `test_list_accounts_demo_user` | `GET /accounts` as demo → 200, includes the seeded `SALTYSNACK` account |
| 3 | `test_create_account_success` | `POST /accounts` with `account_name` creates a new retailer account; subsequent `GET /accounts` includes it |
| 4 | `test_create_account_duplicate_name_gets_suffix` | Backend auto-generates the account code from the name, appending a numeric suffix when the name collides |
| 5 | `test_create_account_missing_name` | Body without `account_name` → 422 |
| 6 | `test_switch_account_valid` | `POST /switch-account` with a real `retailer_account_id` returns a new access_token whose payload embeds that `retailer_account_id` (decoded with no-verify base64) |
| 7 | `test_switch_account_bogus_uuid` | Switch to a malformed account id → 4xx |
| 8 | `test_switch_account_not_authorized` | Switching to a valid-shape UUID that the user is not linked to → 403 |
| 9 | `test_get_accounts_with_switched_token` | After switching, the new token still authenticates against `GET /accounts` (sanity check on token validity) |

---

## `test_metadata.py` — 15 tests

Reference data and catalog endpoints — all require an account-scoped token (post `/switch-account`).

| # | Test | What it verifies |
|---|---|---|
| 1 | `test_entities_no_auth_returns_401` | `GET /entities` without auth → 401 |
| 2 | `test_entities_returns_catalog_keys` | `GET /entities` → 200, body is a dict with `items`, `stores`, `dcs`, `suppliers` keys (demo-account fallback runs when the calling account has no items seeded) |
| 3 | `test_run_yaml_template_no_auth_returns_401` | `GET /run-yaml-template` without auth → 401 |
| 4 | `test_run_yaml_template_default_returns_nonempty_yaml` | No query params → 200, body wraps a non-empty YAML string under `yaml`, which parses to a dict containing the `run` key |
| 5 | `test_run_yaml_template_tuning_params_reflected` | All 11 tuning params (`store_target_wos`, `dc_otd_rate`, lead times, etc.) appear correctly in the returned YAML when supplied via query string |
| 6 | `test_get_mappings_no_auth_returns_401` | `GET /mappings` without auth → 401 |
| 7 | `test_get_mappings_returns_topology_keys` | `GET /mappings` → 200, returns a dict with `store_items`, `dc_items`, `supplier_items`, `store_mappings`, `dc_mappings` |
| 8 | `test_post_mappings_no_auth_returns_401` | `POST /mappings` without auth → 401 |
| 9 | `test_post_mappings_empty_body_succeeds` | `POST /mappings` with all-empty lists is valid → 200/201, returns `{"status": "ok"}` |
| 10 | `test_post_mappings_garbage_body_returns_error` | `POST /mappings` with non-JSON / wrong-shape body → 422 |
| 11 | `test_get_promos_no_auth_returns_401` | `GET /promos` without auth → 401 |
| 12 | `test_get_promos_returns_list` | `GET /promos` → 200, returns a list (verifies expected promo fields when non-empty) |
| 13 | `test_get_runs_no_auth_returns_401` | `GET /runs` without auth → 401 |
| 14 | `test_get_runs_returns_list` | `GET /runs` → 200, returns a list of run summaries with `simulation_id`, `simulation_status`, `scenario_type` |
| 15 | `test_get_runs_scenario_filter_returns_correct_type` | `GET /runs?scenario_type=promo_forecast` → 200, every returned run has `scenario_type == promo_forecast` (or list is empty) |

---

## `test_simulation_proxy.py` — 16 tests

The app backend's proxy layer for simulation lifecycle endpoints. Focuses on proxy plumbing and error handling — does **not** trigger a full simulation run.

| # | Test | What it verifies |
|---|---|---|
| 1 | `test_scenario_validate_valid_yaml_returns_200` | Happy-path validate: real promo name pulled from `/promos`, real date range → 200; body has `valid: true`, `scenario_type`, `preview` list, `warnings` list |
| 2 | `test_scenario_validate_malformed_yaml_returns_4xx` | Broken YAML syntax (`promos: [\n`) → 4xx |
| 3 | `test_scenario_validate_empty_yaml_returns_422` | Empty `scenario_yaml` field → 422 |
| 4 | `test_get_simulation_bogus_id_returns_404` | `GET /simulation/<random-uuid>` → 404 (proxied from engine) |
| 5 | `test_get_run_config_bogus_id_returns_404` | `GET /run-config/<random-uuid>` → 404 (DB-backed, not a proxy) |
| 6 | `test_delete_simulation_bogus_id_returns_404` | `DELETE /simulation/<random-uuid>` → 404 |
| 7 | `test_analytics_meta_bogus_id_returns_404` | `GET /analytics/<random-uuid>/meta` → 404 |
| 8 | `test_analytics_wildcard_path_bogus_id_returns_404` | `GET /analytics/<random-uuid>/summary/store-sales` → 404 (covers the `{path:path}` wildcard proxy) |
| 9 | `test_scenario_validate_no_auth_returns_401` | Proxy rejects unauthenticated requests at the auth layer before forwarding |
| 10 | `test_run_no_auth_returns_401` | `POST /run` without auth → 401 |
| 11 | `test_run_yaml_no_auth_returns_401` | `POST /run/yaml` without auth → 401 |
| 12 | `test_get_simulation_no_auth_returns_401` | `GET /simulation/{id}` without auth → 401 |
| 13 | `test_get_run_config_no_auth_returns_401` | `GET /run-config/{id}` without auth → 401 |
| 14 | `test_delete_simulation_no_auth_returns_401` | `DELETE /simulation/{id}` without auth → 401 |
| 15 | `test_analytics_no_auth_returns_401` | `GET /analytics/{id}/{path}` without auth → 401 |
| 16 | `test_scenario_validate_shape_matches_engine_directly` | Cross-service shape parity: `/scenario/validate` via the proxy and directly on the engine return the same top-level keys (`valid`, `scenario_type`, `preview`, `warnings`). Auto-skips when `/promos` doesn't expose `retailer_account_id` to align the engine-direct call. |

---

## Running subsets

```bash
# All tests
.venv-tests/bin/python -m pytest tests/ -v

# By domain
.venv-tests/bin/python -m pytest tests/ -m auth -v
.venv-tests/bin/python -m pytest tests/ -m "accounts or metadata" -v

# One file
.venv-tests/bin/python -m pytest tests/test_auth.py -v

# One test
.venv-tests/bin/python -m pytest tests/test_auth.py::test_login_demo_success -v

# With coverage
.venv-tests/bin/python -m pytest tests/ --cov=backend --cov-report=term-missing
```

## CI

These tests run automatically on every PR to `dev`, `main`, or `pre-dev` and on every
push to `pre-dev` or `nir/ci-cd`. The workflow lives at `.github/workflows/test.yml`
and is named **Tests — metrai_app (backend API + frontend build)** on the Actions tab.

The backend job needs the `METRAI_REPO_TOKEN` secret (fine-grained PAT with read access
to `metraico/metrai_simulation_engine`) so it can check out the sim engine alongside
the app backend and bring up both services for the integration tests.
