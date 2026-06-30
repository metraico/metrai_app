"""
Shared fixtures for metrai_app integration tests.

Tests are designed to run against a live docker-compose stack:
    docker compose up -d

Backend at BACKEND_URL (default http://localhost:8080)
Engine  at ENGINE_URL  (default http://localhost:8000)

Demo user creds (seeded by backend on startup):
    username = demo
    password = 12345678
"""
from __future__ import annotations

import os
import uuid
from typing import Iterator

import httpx
import pytest


BACKEND_URL = os.getenv("BACKEND_URL", "http://localhost:8080")
ENGINE_URL = os.getenv("ENGINE_URL", "http://localhost:8000")

DEMO_USERNAME = "demo"
DEMO_PASSWORD = "12345678"


@pytest.fixture(scope="session")
def backend_url() -> str:
    return BACKEND_URL


@pytest.fixture(scope="session")
def engine_url() -> str:
    return ENGINE_URL


@pytest.fixture
def client(backend_url: str) -> Iterator[httpx.Client]:
    """Unauthenticated HTTP client pointed at the app backend."""
    with httpx.Client(base_url=backend_url, timeout=10.0) as c:
        yield c


@pytest.fixture
def engine_client(engine_url: str) -> Iterator[httpx.Client]:
    """Unauthenticated HTTP client pointed at the sim engine."""
    with httpx.Client(base_url=engine_url, timeout=10.0) as c:
        yield c


@pytest.fixture(scope="session")
def demo_token(backend_url: str) -> str:
    """Log in as the seeded demo user and return the access_token."""
    resp = httpx.post(
        f"{backend_url}/auth/login",
        json={"username": DEMO_USERNAME, "password": DEMO_PASSWORD},
        timeout=10.0,
    )
    resp.raise_for_status()
    body = resp.json()
    token = body.get("access_token")
    assert token, f"login returned no access_token: {body}"
    return token


@pytest.fixture
def authed_client(backend_url: str, demo_token: str) -> Iterator[httpx.Client]:
    """HTTP client with demo user's bearer token on every request (app backend)."""
    with httpx.Client(
        base_url=backend_url,
        timeout=10.0,
        headers={"Authorization": f"Bearer {demo_token}"},
    ) as c:
        yield c


@pytest.fixture
def authed_engine_client(engine_url: str, demo_token: str) -> Iterator[httpx.Client]:
    """HTTP client with demo user's bearer token on every request (sim engine)."""
    with httpx.Client(
        base_url=engine_url,
        timeout=10.0,
        headers={"Authorization": f"Bearer {demo_token}"},
    ) as c:
        yield c


@pytest.fixture(scope="session")
def account_scoped_token(backend_url: str, demo_token: str) -> str:
    """
    Account-scoped token: logs in as demo, fetches the first account, calls
    /switch-account. Required for any endpoint that reads retailer_account_id
    from the JWT (entities, mappings, promos, simulation, etc.).
    """
    accts = httpx.get(
        f"{backend_url}/accounts",
        headers={"Authorization": f"Bearer {demo_token}"},
        timeout=10.0,
    )
    accts.raise_for_status()
    account_id = accts.json()[0]["retailer_account_id"]
    sw = httpx.post(
        f"{backend_url}/switch-account",
        json={"retailer_account_id": account_id},
        headers={"Authorization": f"Bearer {demo_token}"},
        timeout=10.0,
    )
    sw.raise_for_status()
    return sw.json()["access_token"]


@pytest.fixture
def account_client(backend_url: str, account_scoped_token: str) -> Iterator[httpx.Client]:
    """HTTP client with account-scoped token (post /switch-account)."""
    with httpx.Client(
        base_url=backend_url,
        timeout=10.0,
        headers={"Authorization": f"Bearer {account_scoped_token}"},
    ) as c:
        yield c


@pytest.fixture
def account_engine_client(engine_url: str, account_scoped_token: str) -> Iterator[httpx.Client]:
    """Engine client with account-scoped token (for cross-service tests)."""
    with httpx.Client(
        base_url=engine_url,
        timeout=10.0,
        headers={"Authorization": f"Bearer {account_scoped_token}"},
    ) as c:
        yield c


@pytest.fixture
def random_username() -> str:
    """Unique username for register-flow tests (avoids collisions across runs)."""
    return f"pytest_{uuid.uuid4().hex[:12]}"
