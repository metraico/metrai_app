import os

import httpx
import streamlit as st

BACKEND_URL = os.getenv("BACKEND_URL", "http://localhost:8080")
SIMULATION_ENGINE_URL = os.getenv("SIMULATION_ENGINE_URL", "http://localhost:8000")


def _auth_headers() -> dict:
    token = st.session_state.get("access_token", "")
    return {"Authorization": f"Bearer {token}"} if token else {}


# ── Auth ──────────────────────────────────────────────────────────────────────

def login(username, password):
    r = httpx.post(
        f"{BACKEND_URL}/login",
        json={"username": username, "password": password},
        timeout=10.0,
    )
    r.raise_for_status()
    return r.json()


def refresh_access_token(refresh_token: str) -> dict:
    r = httpx.post(
        f"{BACKEND_URL}/refresh",
        json={"refresh_token": refresh_token},
        timeout=10.0,
    )
    r.raise_for_status()
    return r.json()


def register(body: dict):
    r = httpx.post(f"{BACKEND_URL}/register", json=body, timeout=15.0)
    r.raise_for_status()
    return r.json()


def fetch_accounts():
    r = httpx.get(f"{BACKEND_URL}/accounts", headers=_auth_headers(), timeout=10.0)
    r.raise_for_status()
    return r.json()


def create_account(body: dict):
    r = httpx.post(f"{BACKEND_URL}/accounts", json=body, headers=_auth_headers(), timeout=10.0)
    r.raise_for_status()
    return r.json()


def switch_account(retailer_account_id: str):
    r = httpx.post(
        f"{BACKEND_URL}/switch-account",
        json={"retailer_account_id": retailer_account_id},
        headers=_auth_headers(),
        timeout=10.0,
    )
    r.raise_for_status()
    return r.json()


def logout_session(refresh_token: str):
    try:
        httpx.post(
            f"{BACKEND_URL}/logout",
            json={"refresh_token": refresh_token},
            headers=_auth_headers(),
            timeout=5.0,
        )
    except Exception:
        pass  # best-effort — clear local state regardless


# ── Data endpoints ────────────────────────────────────────────────────────────

def fetch_runs():
    r = httpx.get(f"{BACKEND_URL}/runs", headers=_auth_headers(), timeout=10.0)
    r.raise_for_status()
    return r.json()


def fetch_entities():
    r = httpx.get(f"{BACKEND_URL}/entities", headers=_auth_headers(), timeout=15.0)
    r.raise_for_status()
    return r.json()


def fetch_run_yaml_template() -> str:
    r = httpx.get(f"{BACKEND_URL}/run-yaml-template", headers=_auth_headers(), timeout=15.0)
    r.raise_for_status()
    return r.json()["yaml"]


def fetch_mappings():
    r = httpx.get(f"{BACKEND_URL}/mappings", headers=_auth_headers(), timeout=15.0)
    r.raise_for_status()
    return r.json()


def save_mappings(payload):
    r = httpx.post(
        f"{BACKEND_URL}/mappings",
        json=payload,
        headers=_auth_headers(),
        timeout=30.0,
    )
    r.raise_for_status()
    return r.json()


def fetch_promos():
    r = httpx.get(f"{BACKEND_URL}/promos", headers=_auth_headers(), timeout=15.0)
    r.raise_for_status()
    return r.json()


def validate_scenario(start_date: str, end_date: str, scenario_yaml: str):
    r = httpx.post(
        f"{BACKEND_URL}/scenario/validate",
        json={"start_date": start_date, "end_date": end_date, "scenario_yaml": scenario_yaml},
        headers=_auth_headers(),
        timeout=30.0,
    )
    r.raise_for_status()
    return r.json()


def run_simulation(config):
    r = httpx.post(
        f"{BACKEND_URL}/run",
        json=config,
        headers=_auth_headers(),
        timeout=300.0,
    )
    r.raise_for_status()
    return r.json()


def run_simulation_yaml(yaml_content: str):
    r = httpx.post(
        f"{BACKEND_URL}/run/yaml",
        json={"yaml_content": yaml_content},
        headers=_auth_headers(),
        timeout=30.0,
    )
    r.raise_for_status()
    return r.json()


def fetch_simulation(simulation_id):
    r = httpx.get(
        f"{BACKEND_URL}/simulation/{simulation_id}",
        headers=_auth_headers(),
        timeout=120.0,
    )
    r.raise_for_status()
    return r.json()


def delete_simulation(simulation_id: str):
    r = httpx.delete(
        f"{BACKEND_URL}/simulation/{simulation_id}",
        headers=_auth_headers(),
        timeout=30.0,
    )
    r.raise_for_status()


def fetch_run_config(simulation_id):
    r = httpx.get(
        f"{BACKEND_URL}/run-config/{simulation_id}",
        headers=_auth_headers(),
        timeout=15.0,
    )
    r.raise_for_status()
    return r.json()


def fetch_simulation_status(simulation_id: str) -> dict:
    """Poll simulation completion status via run-config."""
    r = httpx.get(
        f"{BACKEND_URL}/run-config/{simulation_id}",
        headers=_auth_headers(),
        timeout=15.0,
    )
    r.raise_for_status()
    return r.json()


# ── Analytics endpoints — routed through BACKEND_URL proxy ───────────────────

def fetch_sim_meta(simulation_id: str) -> dict:
    r = httpx.get(
        f"{BACKEND_URL}/analytics/{simulation_id}/meta",
        headers=_auth_headers(),
        timeout=15.0,
    )
    r.raise_for_status()
    return r.json()


def fetch_store_sales(simulation_id: str, item_id: str = None, store_id: str = None) -> dict:
    params = {}
    if item_id:
        params["item_id"] = item_id
    if store_id:
        params["store_id"] = store_id
    r = httpx.get(
        f"{BACKEND_URL}/analytics/{simulation_id}/store-sales",
        params=params,
        headers=_auth_headers(),
        timeout=30.0,
    )
    r.raise_for_status()
    return r.json()


def fetch_supply_chain_sales(
    simulation_id: str,
    item_id: str = None,
    supplier_dc_id: str = None,
    retailer_dc_id: str = None,
) -> dict:
    params = {}
    if item_id:
        params["item_id"] = item_id
    if supplier_dc_id:
        params["supplier_dc_id"] = supplier_dc_id
    if retailer_dc_id:
        params["retailer_dc_id"] = retailer_dc_id
    r = httpx.get(
        f"{BACKEND_URL}/analytics/{simulation_id}/supply-chain-sales",
        params=params,
        headers=_auth_headers(),
        timeout=30.0,
    )
    r.raise_for_status()
    return r.json()


def fetch_store_inventory(simulation_id: str, item_id: str = None, store_id: str = None) -> dict:
    params = {}
    if item_id:
        params["item_id"] = item_id
    if store_id:
        params["store_id"] = store_id
    r = httpx.get(
        f"{BACKEND_URL}/analytics/{simulation_id}/store-inventory",
        params=params,
        headers=_auth_headers(),
        timeout=30.0,
    )
    r.raise_for_status()
    return r.json()


def fetch_upstream_inventory(
    simulation_id: str,
    item_id: str = None,
    dc_id: str = None,
    supplier_dc_id: str = None,
) -> dict:
    params = {}
    if item_id:
        params["item_id"] = item_id
    if dc_id:
        params["dc_id"] = dc_id
    if supplier_dc_id:
        params["supplier_dc_id"] = supplier_dc_id
    r = httpx.get(
        f"{BACKEND_URL}/analytics/{simulation_id}/upstream-inventory",
        params=params,
        headers=_auth_headers(),
        timeout=30.0,
    )
    r.raise_for_status()
    return r.json()
