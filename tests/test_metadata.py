"""
Integration tests for metadata/catalog endpoints:
  GET  /entities
  GET  /run-yaml-template
  GET  /mappings
  POST /mappings
  GET  /promos
  GET  /runs
"""
from __future__ import annotations

import pytest
import yaml


# ---------------------------------------------------------------------------
# /entities
# ---------------------------------------------------------------------------

@pytest.mark.metadata
@pytest.mark.integration
def test_entities_no_auth_returns_401(client):
    resp = client.get("/entities")
    assert resp.status_code == 401


@pytest.mark.metadata
@pytest.mark.integration
def test_entities_returns_catalog_keys(account_client):
    resp = account_client.get("/entities")
    assert resp.status_code == 200
    body = resp.json()
    assert isinstance(body, dict)
    for key in ("items", "stores", "dcs", "suppliers"):
        assert key in body, f"missing key '{key}' in /entities response"
        assert isinstance(body[key], list)


# ---------------------------------------------------------------------------
# /run-yaml-template
# ---------------------------------------------------------------------------

@pytest.mark.metadata
@pytest.mark.integration
def test_run_yaml_template_no_auth_returns_401(client):
    resp = client.get("/run-yaml-template")
    assert resp.status_code == 401


@pytest.mark.metadata
@pytest.mark.integration
def test_run_yaml_template_default_returns_nonempty_yaml(account_client):
    resp = account_client.get("/run-yaml-template")
    assert resp.status_code == 200
    body = resp.json()
    assert "yaml" in body
    yaml_text = body["yaml"]
    assert isinstance(yaml_text, str) and len(yaml_text) > 0
    parsed = yaml.safe_load(yaml_text)
    assert isinstance(parsed, dict)
    assert "run" in parsed


@pytest.mark.metadata
@pytest.mark.integration
def test_run_yaml_template_tuning_params_reflected(account_client):
    params = {
        "store_target_wos": 3,
        "store_initial_wos": 3,
        "retailer_dc_target_wos": 6,
        "retailer_dc_initial_wos": 5,
        "supplier_dc_initial_wos": 7,
        "retailer_dc_to_store_lead_weeks": 2,
        "supplier_dc_to_retailer_dc_lead_weeks": 3,
        "dc_otd_rate": 0.88,
        "dc_in_full_rate": 0.77,
        "supplier_otd_rate": 0.91,
        "supplier_in_full_rate": 0.85,
    }
    resp = account_client.get("/run-yaml-template", params=params)
    assert resp.status_code == 200
    yaml_text = resp.json()["yaml"]
    parsed = yaml.safe_load(yaml_text)
    run = parsed["run"]
    assert run["store_target_wos"] == params["store_target_wos"]
    assert run["store_initial_wos"] == params["store_initial_wos"]
    assert run["retailer_dc_target_wos"] == params["retailer_dc_target_wos"]
    assert run["retailer_dc_initial_wos"] == params["retailer_dc_initial_wos"]
    assert run["supplier_dc_initial_wos"] == params["supplier_dc_initial_wos"]
    assert run["retailer_dc_to_store_lead_weeks"] == params["retailer_dc_to_store_lead_weeks"]
    assert run["supplier_dc_to_retailer_dc_lead_weeks"] == params["supplier_dc_to_retailer_dc_lead_weeks"]
    assert abs(run["dc_otd_rate"] - params["dc_otd_rate"]) < 1e-6
    assert abs(run["dc_in_full_rate"] - params["dc_in_full_rate"]) < 1e-6
    assert abs(run["supplier_otd_rate"] - params["supplier_otd_rate"]) < 1e-6
    assert abs(run["supplier_in_full_rate"] - params["supplier_in_full_rate"]) < 1e-6


# ---------------------------------------------------------------------------
# GET /mappings
# ---------------------------------------------------------------------------

@pytest.mark.metadata
@pytest.mark.integration
def test_get_mappings_no_auth_returns_401(client):
    resp = client.get("/mappings")
    assert resp.status_code == 401


@pytest.mark.metadata
@pytest.mark.integration
def test_get_mappings_returns_topology_keys(account_client):
    resp = account_client.get("/mappings")
    assert resp.status_code == 200
    body = resp.json()
    assert isinstance(body, dict)
    for key in ("store_items", "dc_items", "supplier_items", "store_mappings", "dc_mappings"):
        assert key in body, f"missing key '{key}' in /mappings response"
        assert isinstance(body[key], list)


# ---------------------------------------------------------------------------
# POST /mappings
# ---------------------------------------------------------------------------

@pytest.mark.metadata
@pytest.mark.integration
def test_post_mappings_no_auth_returns_401(client):
    resp = client.post("/mappings", json={})
    assert resp.status_code == 401


@pytest.mark.metadata
@pytest.mark.integration
def test_post_mappings_empty_body_succeeds(account_client):
    """Posting all-empty lists is a valid no-op that clears existing mappings."""
    payload = {
        "store_items": [],
        "dc_items": [],
        "supplier_items": [],
        "store_mappings": [],
        "dc_mappings": [],
    }
    resp = account_client.post("/mappings", json=payload)
    assert resp.status_code in (200, 201)
    body = resp.json()
    assert body.get("status") == "ok"


@pytest.mark.metadata
@pytest.mark.integration
def test_post_mappings_garbage_body_returns_error(account_client):
    """Sending a non-dict body (raw string) should be rejected."""
    resp = account_client.post(
        "/mappings",
        content=b"this is not json",
        headers={"Content-Type": "application/json"},
    )
    assert resp.status_code == 422


# ---------------------------------------------------------------------------
# /promos
# ---------------------------------------------------------------------------

@pytest.mark.metadata
@pytest.mark.integration
def test_get_promos_no_auth_returns_401(client):
    resp = client.get("/promos")
    assert resp.status_code == 401


@pytest.mark.metadata
@pytest.mark.integration
def test_get_promos_returns_list(account_client):
    resp = account_client.get("/promos")
    assert resp.status_code == 200
    body = resp.json()
    assert isinstance(body, list)
    # If promos exist, each entry should have the expected shape
    for promo in body:
        assert "promo_id" in promo
        assert "promo_name" in promo
        assert "start_date" in promo
        assert "end_date" in promo
        assert "demand_multiplier" in promo


# ---------------------------------------------------------------------------
# /runs
# ---------------------------------------------------------------------------

@pytest.mark.metadata
@pytest.mark.integration
def test_get_runs_no_auth_returns_401(client):
    resp = client.get("/runs")
    assert resp.status_code == 401


@pytest.mark.metadata
@pytest.mark.integration
def test_get_runs_returns_list(account_client):
    resp = account_client.get("/runs")
    assert resp.status_code == 200
    body = resp.json()
    assert isinstance(body, list)
    for run in body:
        assert "simulation_id" in run
        assert "simulation_status" in run
        assert "scenario_type" in run


@pytest.mark.metadata
@pytest.mark.integration
def test_get_runs_scenario_filter_returns_correct_type(account_client):
    resp = account_client.get("/runs", params={"scenario_type": "promo_forecast"})
    assert resp.status_code == 200
    body = resp.json()
    assert isinstance(body, list)
    for run in body:
        assert run["scenario_type"] == "promo_forecast", (
            f"Expected scenario_type='promo_forecast', got {run['scenario_type']!r}"
        )
