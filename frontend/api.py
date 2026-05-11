import os

import httpx


BACKEND_URL = os.getenv("BACKEND_URL", "http://localhost:8080")


def login(username, password):
    r = httpx.post(
        f"{BACKEND_URL}/login",
        json={"username": username, "password": password},
        timeout=10.0,
    )
    r.raise_for_status()
    return r.json()


def fetch_runs(account_id):
    r = httpx.get(
        f"{BACKEND_URL}/runs",
        params={"account_id": account_id},
        timeout=10.0,
    )
    r.raise_for_status()
    return r.json()


def fetch_entities(account_id):
    r = httpx.get(
        f"{BACKEND_URL}/entities",
        params={"account_id": account_id},
        timeout=15.0,
    )
    r.raise_for_status()
    return r.json()


def fetch_mappings(account_id):
    r = httpx.get(
        f"{BACKEND_URL}/mappings",
        params={"account_id": account_id},
        timeout=15.0,
    )
    r.raise_for_status()
    return r.json()


def save_mappings(payload):
    r = httpx.post(
        f"{BACKEND_URL}/mappings",
        json=payload,
        timeout=30.0,
    )
    r.raise_for_status()
    return r.json()


def run_simulation(config):
    r = httpx.post(
        f"{BACKEND_URL}/run",
        json=config,
        timeout=300.0,
    )
    r.raise_for_status()
    return r.json()


def fetch_simulation(simulation_id):
    r = httpx.get(
        f"{BACKEND_URL}/simulation/{simulation_id}",
        timeout=60.0,
    )
    r.raise_for_status()
    return r.json()


def fetch_run_config(simulation_id):
    r = httpx.get(
        f"{BACKEND_URL}/run-config/{simulation_id}",
        timeout=15.0,
    )
    r.raise_for_status()
    return r.json()
