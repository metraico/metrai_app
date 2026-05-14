import os

import httpx
import streamlit as st

BACKEND_URL = os.getenv("BACKEND_URL", "http://localhost:8080")


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


def switch_account(account_id: str):
    r = httpx.post(
        f"{BACKEND_URL}/switch-account",
        json={"account_id": account_id},
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

def fetch_runs(account_id=None):
    r = httpx.get(f"{BACKEND_URL}/runs", headers=_auth_headers(), timeout=10.0)
    r.raise_for_status()
    return r.json()


def fetch_entities(account_id=None):
    r = httpx.get(f"{BACKEND_URL}/entities", headers=_auth_headers(), timeout=15.0)
    r.raise_for_status()
    return r.json()


def fetch_mappings(account_id=None):
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


def fetch_promos(account_id=None):
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


def fetch_simulation(simulation_id):
    r = httpx.get(
        f"{BACKEND_URL}/simulation/{simulation_id}",
        headers=_auth_headers(),
        timeout=60.0,
    )
    r.raise_for_status()
    return r.json()


def fetch_run_config(simulation_id):
    r = httpx.get(
        f"{BACKEND_URL}/run-config/{simulation_id}",
        headers=_auth_headers(),
        timeout=15.0,
    )
    r.raise_for_status()
    return r.json()
