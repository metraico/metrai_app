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


# Minimal valid scenario YAML for promo_forecast
_VALID_SCENARIO_YAML = """\
scenario:
  type: promo_forecast
  promos:
    - promo_group: Coke 2L
      factor: 2.0
      start_date: "2025-01-06"
      end_date: "2025-01-19"
"""

# A scenario YAML with broken syntax (unclosed bracket)
_BROKEN_YAML = "scenario:\n  type: promo_forecast\n  promos: [\n"


# ── POST /scenario/validate — happy path ─────────────────────────────────────

@pytest.mark.simulation
@pytest.mark.integration
def test_scenario_validate_valid_yaml_returns_200(account_client):
    """A well-formed promo_forecast scenario YAML should validate successfully."""
    resp = account_client.post(
        "/scenario/validate",
        json={
            "scenario_yaml": _VALID_SCENARIO_YAML,
            "start_date": "2025-01-01",
            "end_date": "2025-06-30",
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
        json={"scenario_yaml": _VALID_SCENARIO_YAML},
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
    account_client, account_engine_client
):
    """
    POST /scenario/validate called via the app backend (:8080) and directly on
    the engine (:8000) must return the same top-level response shape.
    (The app backend injects retailer_account_id from the JWT; supply it
    explicitly for the direct engine call to make them comparable.)
    """
    # First, obtain retailer_account_id from the backend's /entities response
    # (a lightweight call that returns the authed account context).
    entities_resp = account_client.get("/entities")
    assert entities_resp.status_code == 200, entities_resp.text
    # The demo account id is embedded in the JWT; retrieve it from /me or infer
    # from any account-scoped endpoint.  We use the /accounts list instead.
    accounts_resp = account_client.get("/accounts")
    assert accounts_resp.status_code == 200, accounts_resp.text
    accounts_body = accounts_resp.json()
    # accounts endpoint returns a list; pick the first active account id
    retailer_account_id = None
    if isinstance(accounts_body, list) and accounts_body:
        retailer_account_id = accounts_body[0].get("retailer_account_id")
    elif isinstance(accounts_body, dict):
        retailer_account_id = (
            accounts_body.get("retailer_account_id")
            or (accounts_body.get("accounts") or [{}])[0].get("retailer_account_id")
        )
    assert retailer_account_id, f"Could not determine retailer_account_id: {accounts_body}"

    payload = {
        "scenario_yaml": _VALID_SCENARIO_YAML,
        "start_date": "2025-01-01",
        "end_date": "2025-06-30",
    }

    # Call via app backend (injects retailer_account_id automatically)
    backend_resp = account_client.post("/scenario/validate", json=payload)
    assert backend_resp.status_code == 200, f"backend: {backend_resp.text}"
    backend_body = backend_resp.json()

    # Call engine directly (must supply retailer_account_id explicitly)
    engine_payload = {**payload, "retailer_account_id": retailer_account_id}
    engine_resp = account_engine_client.post("/scenario/validate", json=engine_payload)
    assert engine_resp.status_code == 200, f"engine: {engine_resp.text}"
    engine_body = engine_resp.json()

    # Assert both responses share the same top-level keys and core field types
    for key in ("valid", "scenario_type", "preview", "warnings"):
        assert key in backend_body, f"backend response missing '{key}'"
        assert key in engine_body, f"engine response missing '{key}'"
        assert type(backend_body[key]) is type(engine_body[key]), (
            f"type mismatch for '{key}': backend={type(backend_body[key]).__name__}, "
            f"engine={type(engine_body[key]).__name__}"
        )
    assert backend_body["valid"] == engine_body["valid"]
    assert backend_body["scenario_type"] == engine_body["scenario_type"]
