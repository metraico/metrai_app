"""
Integration tests for auth endpoints exposed by backend/main.py.

Endpoints covered:
  POST /auth/register  (alias: /register)
  POST /auth/login     (alias: /login)
  POST /auth/refresh   (alias: /refresh)
  POST /auth/logout    (alias: /logout)
  GET  /accounts       (protected — used to verify JWT acceptance)

Run with:
    pytest tests/test_auth.py -m "auth and integration" -v
"""
from __future__ import annotations

import httpx
import pytest


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

DEMO_USERNAME = "demo"
DEMO_PASSWORD = "12345678"
MIN_PASSWORD = "testpass1"  # 8+ chars


def _login(client: httpx.Client, username: str, password: str) -> httpx.Response:
    return client.post("/auth/login", json={"username": username, "password": password})


def _fresh_tokens(client: httpx.Client, username: str = DEMO_USERNAME, password: str = DEMO_PASSWORD):
    """Return (access_token, refresh_token) for a fresh login."""
    resp = _login(client, username, password)
    assert resp.status_code == 200, f"login failed: {resp.text}"
    body = resp.json()
    return body["access_token"], body["refresh_token"]


# ---------------------------------------------------------------------------
# 1. Login — happy path
# ---------------------------------------------------------------------------

@pytest.mark.auth
@pytest.mark.integration
def test_login_demo_success(client: httpx.Client):
    resp = _login(client, DEMO_USERNAME, DEMO_PASSWORD)
    assert resp.status_code == 200, f"Expected 200, got {resp.status_code}: {resp.text}"
    body = resp.json()
    assert "access_token" in body, "Response missing access_token"
    assert "refresh_token" in body, "Response missing refresh_token"
    assert body.get("token_type", "").lower() == "bearer", "token_type should be bearer"
    assert "user_id" in body, "Response missing user_id"


# ---------------------------------------------------------------------------
# 2. Login — wrong password → 401
# ---------------------------------------------------------------------------

@pytest.mark.auth
@pytest.mark.integration
def test_login_wrong_password(client: httpx.Client):
    resp = _login(client, DEMO_USERNAME, "wrongpassword!")
    assert resp.status_code == 401, f"Expected 401, got {resp.status_code}: {resp.text}"


# ---------------------------------------------------------------------------
# 3. Login — unknown user → 401
# ---------------------------------------------------------------------------

@pytest.mark.auth
@pytest.mark.integration
def test_login_unknown_user(client: httpx.Client):
    resp = _login(client, "no_such_user_xyz", DEMO_PASSWORD)
    assert resp.status_code == 401, f"Expected 401, got {resp.status_code}: {resp.text}"


# ---------------------------------------------------------------------------
# 4. Login — missing fields → 422
# ---------------------------------------------------------------------------

@pytest.mark.auth
@pytest.mark.integration
def test_login_missing_password(client: httpx.Client):
    resp = client.post("/auth/login", json={"username": DEMO_USERNAME})
    # password resolves to "" → fails auth (could be 401 or 422 depending on impl path)
    assert resp.status_code in (401, 422), f"Expected 401 or 422, got {resp.status_code}: {resp.text}"


@pytest.mark.auth
@pytest.mark.integration
def test_login_missing_username(client: httpx.Client):
    resp = client.post("/auth/login", json={"password": DEMO_PASSWORD})
    assert resp.status_code in (401, 422), f"Expected 401 or 422, got {resp.status_code}: {resp.text}"


# ---------------------------------------------------------------------------
# 5. Register — new random user, then log in
# ---------------------------------------------------------------------------

@pytest.mark.auth
@pytest.mark.integration
def test_register_new_user_and_login(client: httpx.Client, random_username: str):
    # Register
    reg_resp = client.post(
        "/auth/register",
        json={"username": random_username, "password": MIN_PASSWORD, "full_name": "Test User"},
    )
    assert reg_resp.status_code in (200, 201), f"Register failed: {reg_resp.text}"
    reg_body = reg_resp.json()
    assert "access_token" in reg_body, "Register response missing access_token"
    assert "refresh_token" in reg_body, "Register response missing refresh_token"

    # Can log in with the new credentials
    login_resp = _login(client, random_username, MIN_PASSWORD)
    assert login_resp.status_code == 200, f"Login after register failed: {login_resp.text}"
    assert "access_token" in login_resp.json(), "Login after register missing access_token"


# ---------------------------------------------------------------------------
# 6. Register — collision (same username twice) → 4xx
# ---------------------------------------------------------------------------

@pytest.mark.auth
@pytest.mark.integration
def test_register_duplicate_username(client: httpx.Client, random_username: str):
    payload = {"username": random_username, "password": MIN_PASSWORD}
    first = client.post("/auth/register", json=payload)
    assert first.status_code in (200, 201), f"First register failed unexpectedly: {first.text}"

    second = client.post("/auth/register", json=payload)
    assert 400 <= second.status_code < 500, (
        f"Expected 4xx on duplicate register, got {second.status_code}: {second.text}"
    )


# ---------------------------------------------------------------------------
# 7. Refresh — valid refresh_token issues new access_token
# ---------------------------------------------------------------------------

@pytest.mark.auth
@pytest.mark.integration
def test_refresh_valid_token(client: httpx.Client):
    _, refresh_token = _fresh_tokens(client)

    resp = client.post("/auth/refresh", json={"refresh_token": refresh_token})
    assert resp.status_code == 200, f"Expected 200, got {resp.status_code}: {resp.text}"
    body = resp.json()
    assert "access_token" in body, "Refresh response missing access_token"
    assert "refresh_token" in body, "Refresh response missing refresh_token (rotation expected)"


# ---------------------------------------------------------------------------
# 8. Refresh — invalid token → 401
# ---------------------------------------------------------------------------

@pytest.mark.auth
@pytest.mark.integration
def test_refresh_invalid_token(client: httpx.Client):
    resp = client.post("/auth/refresh", json={"refresh_token": "totally.invalid.token"})
    assert resp.status_code == 401, f"Expected 401, got {resp.status_code}: {resp.text}"


# ---------------------------------------------------------------------------
# 9. Logout revokes refresh_token → subsequent refresh → 401
# ---------------------------------------------------------------------------

@pytest.mark.auth
@pytest.mark.integration
def test_logout_revokes_refresh_token(client: httpx.Client):
    access_token, refresh_token = _fresh_tokens(client)

    # Logout (requires Bearer token in header)
    logout_resp = client.post(
        "/auth/logout",
        json={"refresh_token": refresh_token},
        headers={"Authorization": f"Bearer {access_token}"},
    )
    assert logout_resp.status_code == 200, f"Logout failed: {logout_resp.text}"
    assert logout_resp.json().get("status") == "ok", "Logout should return {status: ok}"

    # Trying to refresh with the now-revoked token should fail
    refresh_resp = client.post("/auth/refresh", json={"refresh_token": refresh_token})
    assert refresh_resp.status_code == 401, (
        f"Expected 401 after logout, got {refresh_resp.status_code}: {refresh_resp.text}"
    )


# ---------------------------------------------------------------------------
# 10. Aliases: /register and /login work identically to /auth/register and /auth/login
# ---------------------------------------------------------------------------

@pytest.mark.auth
@pytest.mark.integration
def test_login_alias(client: httpx.Client):
    resp = client.post("/login", json={"username": DEMO_USERNAME, "password": DEMO_PASSWORD})
    assert resp.status_code == 200, f"Alias /login failed: {resp.status_code}: {resp.text}"
    assert "access_token" in resp.json(), "Alias /login missing access_token"


@pytest.mark.auth
@pytest.mark.integration
def test_register_alias(client: httpx.Client, random_username: str):
    resp = client.post(
        "/register",
        json={"username": random_username, "password": MIN_PASSWORD},
    )
    assert resp.status_code in (200, 201), f"Alias /register failed: {resp.status_code}: {resp.text}"
    assert "access_token" in resp.json(), "Alias /register missing access_token"


# ---------------------------------------------------------------------------
# 11. Protected route — GET /accounts: no token → 401, with token → 200
# ---------------------------------------------------------------------------

@pytest.mark.auth
@pytest.mark.integration
def test_protected_route_no_token(client: httpx.Client):
    resp = client.get("/accounts")
    assert resp.status_code == 401, f"Expected 401 without token, got {resp.status_code}: {resp.text}"


@pytest.mark.auth
@pytest.mark.integration
def test_protected_route_with_token(client: httpx.Client):
    access_token, _ = _fresh_tokens(client)
    resp = client.get("/accounts", headers={"Authorization": f"Bearer {access_token}"})
    assert resp.status_code == 200, f"Expected 200 with valid token, got {resp.status_code}: {resp.text}"


# ---------------------------------------------------------------------------
# 12. JWT shared secret — engine accepts app-backend access_token
# ---------------------------------------------------------------------------

@pytest.mark.auth
@pytest.mark.integration
def test_engine_accepts_app_backend_jwt(authed_engine_client: httpx.Client):
    """
    The sim engine shares the same JWT_SECRET as the app backend.
    Using the demo user's access_token (from authed_engine_client), hitting the
    engine's /promos endpoint should NOT return 401.  A 422 (missing required params)
    or 200/404 is acceptable — any of those prove the JWT was accepted.
    """
    resp = authed_engine_client.get("/promos")
    assert resp.status_code != 401, (
        f"Engine rejected the app-backend JWT (got 401). "
        f"JWT_SECRET may not be shared. Response: {resp.text}"
    )
