"""
Integration tests for simulation proxy endpoints:
  POST /run                         — JSON body, proxies to engine /simulate
  POST /run/yaml                    — YAML body, proxies to engine /simulate
  POST /scenario/validate           — proxies to engine /scenario/validate
  GET  /simulation/{simulation_id}  — proxy
  GET  /run-config/{simulation_id}  — proxy
  DELETE /simulation/{simulation_id}— proxy
  GET  /analytics/{simulation_id}/{path:path} — wildcard analytics proxy

These tests exercise proxy plumbing and error handling only — they do NOT
trigger a full simulation run (too slow for the unit-test loop).
"""
from __future__ import annotations

import uuid

import pytest
import yaml


# ── Helpers ──────────────────────────────────────────────────────────────────

def _bogus_uuid() -> str:
    """Return a UUID that will never match a real simulation."""
    return str(uuid.uuid4())


def _valid_scenario_yaml(promo_name: str) -> str:
    """
    Canonical promo_forecast YAML, matching the shape the frontend produces
    (top-level scenario_type, no `scenario:` wrapper). The promo_name must
    exist in the live /promos catalog for the engine's resolver to accept it.
    """
    return (
        "scenario_type: promo_forecast\n"
        "promos:\n"
        f"  - promo_name: {promo_name}\n"
        "    performance_adjustment: 0\n"
    )


# A scenario YAML with broken syntax (unclosed bracket)
_BROKEN_YAML = "scenario_type: promo_forecast\npromos: [\n"


@pytest.fixture
def real_promo(account_client) -> dict:
    """Pull a real promo from the live catalog so the resolver accepts it.
    Returns name + date range so callers can craft a simulation window that
    actually overlaps a real promo. Skips if the demo account has none."""
    resp = account_client.get("/promos")
    resp.raise_for_status()
    promos = resp.json()
    if not promos:
        pytest.skip("No promos in demo account — scenario validation needs one")
    return promos[0]


@pytest.fixture
def real_promo_name(real_promo) -> str:
    return real_promo["promo_name"]


# ── POST /scenario/validate — happy path ─────────────────────────────────────

@pytest.mark.simulation
@pytest.mark.integration
def test_scenario_validate_valid_yaml_returns_200(account_client, real_promo):
    """A well-formed promo_forecast scenario YAML should validate successfully.
    Uses the real promo's date range so the engine resolver matches it."""
    resp = account_client.post(
        "/scenario/validate",
        json={
            "scenario_yaml": _valid_scenario_yaml(real_promo["promo_name"]),
            "start_date": real_promo["start_date"],
            "end_date": real_promo["end_date"],
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body.get("valid") is True
    assert "scenario_type" in body
    assert isinstance(body.get("preview"), list)
    assert isinstance(body.get("warnings"), list)


# ── POST /scenario/validate — malformed YAML ─────────────────────────────────

@pytest.mark.simulation
@pytest.mark.integration
def test_scenario_validate_malformed_yaml_returns_4xx(account_client):
    """Sending broken YAML syntax should return a 4xx (422) from the proxy."""
    resp = account_client.post(
        "/scenario/validate",
        json={
            "scenario_yaml": _BROKEN_YAML,
            "start_date": "2025-01-01",
            "end_date": "2025-06-30",
        },
    )
    assert resp.status_code in (400, 422), (
        f"Expected 4xx for malformed YAML, got {resp.status_code}: {resp.text}"
    )


@pytest.mark.simulation
@pytest.mark.integration
def test_scenario_validate_empty_yaml_returns_422(account_client):
    """Omitting scenario_yaml entirely should return 422 from the engine."""
    resp = account_client.post(
        "/scenario/validate",
        json={
            "scenario_yaml": "",
            "start_date": "2025-01-01",
            "end_date": "2025-06-30",
        },
    )
    assert resp.status_code == 422, resp.text


# ── GET /simulation/<bogus-uuid> — 404 proxy ─────────────────────────────────

@pytest.mark.simulation
@pytest.mark.integration
def test_get_simulation_bogus_id_returns_404(account_client):
    """A non-existent simulation_id should proxy a 404 back from the engine."""
    resp = account_client.get(f"/simulation/{_bogus_uuid()}")
    assert resp.status_code == 404, resp.text


# ── GET /run-config/<bogus-uuid> — 404 proxy ─────────────────────────────────

@pytest.mark.simulation
@pytest.mark.integration
def test_get_run_config_bogus_id_returns_404(account_client):
    """A non-existent simulation_id should proxy a 404 back from the engine."""
    resp = account_client.get(f"/run-config/{_bogus_uuid()}")
    assert resp.status_code == 404, resp.text


# ── DELETE /simulation/<bogus-uuid> — 404 proxy ──────────────────────────────

@pytest.mark.simulation
@pytest.mark.integration
def test_delete_simulation_bogus_id_returns_404(account_client):
    """Deleting a non-existent simulation should proxy a 404 from the engine."""
    resp = account_client.delete(f"/simulation/{_bogus_uuid()}")
    assert resp.status_code == 404, resp.text


# ── GET /analytics/<bogus-uuid>/meta ─────────────────────────────────────────

@pytest.mark.simulation
@pytest.mark.integration
def test_analytics_meta_bogus_id_returns_404(account_client):
    """Analytics meta sub-path for a non-existent sim should 404."""
    resp = account_client.get(f"/analytics/{_bogus_uuid()}/meta")
    assert resp.status_code == 404, resp.text


# ── GET /analytics/<bogus-uuid>/summary/store-sales (wildcard path) ───────────

@pytest.mark.simulation
@pytest.mark.integration
def test_analytics_wildcard_path_bogus_id_returns_404(account_client):
    """Deep wildcard sub-path for a non-existent sim should 404 (covers path proxy)."""
    resp = account_client.get(f"/analytics/{_bogus_uuid()}/summary/store-sales")
    assert resp.status_code == 404, resp.text


# ── Auth: all endpoints reject unauthenticated requests ──────────────────────

@pytest.mark.simulation
@pytest.mark.integration
def test_scenario_validate_no_auth_returns_401(client):
    resp = client.post(
        "/scenario/validate",
        json={"scenario_yaml": "scenario_type: promo_forecast\npromos: []\n"},
    )
    assert resp.status_code == 401, resp.text


@pytest.mark.simulation
@pytest.mark.integration
def test_run_no_auth_returns_401(client):
    resp = client.post("/run", json={"simulation_name": "test"})
    assert resp.status_code == 401, resp.text


@pytest.mark.simulation
@pytest.mark.integration
def test_run_yaml_no_auth_returns_401(client):
    resp = client.post("/run/yaml", json={"yaml_content": "run:\n  simulation_name: test\n"})
    assert resp.status_code == 401, resp.text


@pytest.mark.simulation
@pytest.mark.integration
def test_get_simulation_no_auth_returns_401(client):
    resp = client.get(f"/simulation/{_bogus_uuid()}")
    assert resp.status_code == 401, resp.text


@pytest.mark.simulation
@pytest.mark.integration
def test_get_run_config_no_auth_returns_401(client):
    resp = client.get(f"/run-config/{_bogus_uuid()}")
    assert resp.status_code == 401, resp.text


@pytest.mark.simulation
@pytest.mark.integration
def test_delete_simulation_no_auth_returns_401(client):
    resp = client.delete(f"/simulation/{_bogus_uuid()}")
    assert resp.status_code == 401, resp.text


@pytest.mark.simulation
@pytest.mark.integration
def test_analytics_no_auth_returns_401(client):
    resp = client.get(f"/analytics/{_bogus_uuid()}/meta")
    assert resp.status_code == 401, resp.text


# ── Cross-service: validate returns same shape via app-backend and engine ─────

@pytest.mark.simulation
@pytest.mark.integration
def test_scenario_validate_shape_matches_engine_directly(
    account_client, account_engine_client, real_promo
):
    """
    Verify proxy shape parity: POST /scenario/validate via the app backend (:8080)
    returns the same top-level response shape as the engine's own /scenario/validate.

    Caveat: the app backend resolves retailer_account_id via _resolve_data_account
    (with demo-account fallback) before forwarding, while the engine uses whatever
    is passed in the body. To make the direct-engine call comparable, we reuse the
    backend's /promos resolver: real_promo came from /promos, which uses the same
    resolved account id the proxy uses. We extract that account id from /promos
    response if present, otherwise fall back to the raw JWT account id.
    """
    # Pull the resolved data account id from a /promos response — /promos and the
    # proxy both run _resolve_data_account, so they agree on which account to query.
    promos_resp = account_client.get("/promos")
    assert promos_resp.status_code == 200, promos_resp.text
    promos = promos_resp.json()
    assert promos, "demo account should have at least one promo for this test"
    resolved_account_id = promos[0].get("retailer_account_id")

    payload = {
        "scenario_yaml": _valid_scenario_yaml(real_promo["promo_name"]),
        "start_date": real_promo["start_date"],
        "end_date": real_promo["end_date"],
    }

    # Call via app backend (injects retailer_account_id from JWT + fallback)
    backend_resp = account_client.post("/scenario/validate", json=payload)
    assert backend_resp.status_code == 200, f"backend: {backend_resp.text}"
    backend_body = backend_resp.json()

    # Call engine directly with the SAME resolved account id the proxy ends up using.
    # Skip the engine direct comparison if /promos didn't expose retailer_account_id
    # (older payload shapes) — the proxy assertion above is the load-bearing check.
    if not resolved_account_id:
        pytest.skip("/promos payload doesn't expose retailer_account_id — cannot align engine direct call")
    engine_payload = {**payload, "retailer_account_id": resolved_account_id}
    engine_resp = account_engine_client.post("/scenario/validate", json=engine_payload)
    assert engine_resp.status_code == 200, f"engine: {engine_resp.text}"
    engine_body = engine_resp.json()

    # Both responses must share the same top-level keys
    for key in ("valid", "scenario_type", "preview", "warnings"):
        assert key in backend_body, f"backend response missing '{key}'"
        assert key in engine_body, f"engine response missing '{key}'"
        assert type(backend_body[key]) is type(engine_body[key]), (
            f"type mismatch for '{key}': backend={type(backend_body[key]).__name__}, "
            f"engine={type(engine_body[key]).__name__}"
        )
    assert backend_body["valid"] == engine_body["valid"]
    assert backend_body["scenario_type"] == engine_body["scenario_type"]
