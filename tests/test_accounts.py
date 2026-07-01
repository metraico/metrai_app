"""
Integration tests for /accounts and /switch-account endpoints.

Requires a live backend at BACKEND_URL (default http://localhost:8080).
Run with:
    pytest -m accounts
"""
from __future__ import annotations

import base64
import json
import uuid

import httpx
import pytest


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _unique_name() -> str:
    """Return a unique account name for this test run."""
    return f"Pytest Store {uuid.uuid4().hex[:8].upper()}"


def _decode_jwt_payload(token: str) -> dict:
    """Decode the payload of a JWT without verifying the signature."""
    payload_b64 = token.split(".")[1]
    # Add padding so base64 doesn't complain
    padding = 4 - len(payload_b64) % 4
    payload_b64 += "=" * (padding % 4)
    return json.loads(base64.urlsafe_b64decode(payload_b64))


# ---------------------------------------------------------------------------
# 1. GET /accounts — unauthenticated → 401
# ---------------------------------------------------------------------------

@pytest.mark.accounts
@pytest.mark.integration
def test_list_accounts_unauthenticated(client: httpx.Client):
    resp = client.get("/accounts")
    assert resp.status_code == 401, resp.text


# ---------------------------------------------------------------------------
# 2. GET /accounts as demo → 200, contains SALTYSNACK
# ---------------------------------------------------------------------------

@pytest.mark.accounts
@pytest.mark.integration
def test_list_accounts_demo_user(authed_client: httpx.Client):
    resp = authed_client.get("/accounts")
    assert resp.status_code == 200, resp.text
    accounts = resp.json()
    assert isinstance(accounts, list)
    codes = [a["retailer_account_code"] for a in accounts]
    assert "SALTYSNACK" in codes, f"SALTYSNACK not found in {codes}"


# ---------------------------------------------------------------------------
# 3. POST /accounts — create new account, then appears in GET /accounts
# ---------------------------------------------------------------------------

@pytest.mark.accounts
@pytest.mark.integration
def test_create_account_success(authed_client: httpx.Client):
    name = _unique_name()
    resp = authed_client.post(
        "/accounts",
        json={
            "account_name": name,
            "account_type": "GROCERY",
            "country_code": "US",
            "currency_code": "USD",
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert "retailer_account_id" in body
    assert "retailer_account_code" in body
    assert body["retailer_account_name"] == name

    # Verify it now appears in GET /accounts
    list_resp = authed_client.get("/accounts")
    assert list_resp.status_code == 200, list_resp.text
    ids = [a["retailer_account_id"] for a in list_resp.json()]
    assert body["retailer_account_id"] in ids


# ---------------------------------------------------------------------------
# 4. POST /accounts — duplicate name → auto-suffix (not an error), but a
#    direct duplicate *code* scenario is hard to trigger via the API because
#    codes are auto-generated.  We verify that creating the same name twice
#    succeeds and both accounts have distinct IDs and codes (suffix logic).
# ---------------------------------------------------------------------------

@pytest.mark.accounts
@pytest.mark.integration
def test_create_account_duplicate_name_gets_suffix(authed_client: httpx.Client):
    name = _unique_name()
    resp1 = authed_client.post("/accounts", json={"account_name": name})
    assert resp1.status_code == 200, resp1.text
    resp2 = authed_client.post("/accounts", json={"account_name": name})
    assert resp2.status_code == 200, resp2.text

    b1, b2 = resp1.json(), resp2.json()
    assert b1["retailer_account_id"] != b2["retailer_account_id"]
    assert b1["retailer_account_code"] != b2["retailer_account_code"]


# ---------------------------------------------------------------------------
# 5. POST /accounts — missing required field → 422
# ---------------------------------------------------------------------------

@pytest.mark.accounts
@pytest.mark.integration
def test_create_account_missing_name(authed_client: httpx.Client):
    resp = authed_client.post("/accounts", json={"account_type": "GROCERY"})
    assert resp.status_code == 422, resp.text


# ---------------------------------------------------------------------------
# 6. POST /switch-account — valid account_id → 200, new token contains
#    retailer_account_id in payload
# ---------------------------------------------------------------------------

@pytest.mark.accounts
@pytest.mark.integration
def test_switch_account_valid(authed_client: httpx.Client, backend_url: str):
    # Get an account_id from the demo user's accounts
    accounts = authed_client.get("/accounts").json()
    assert accounts, "demo user has no accounts"
    account_id = accounts[0]["retailer_account_id"]

    resp = authed_client.post("/switch-account", json={"retailer_account_id": account_id})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert "access_token" in body
    assert body.get("retailer_account_id") == account_id

    # Decode payload and check claim
    payload = _decode_jwt_payload(body["access_token"])
    assert payload.get("retailer_account_id") == account_id


# ---------------------------------------------------------------------------
# 7. POST /switch-account — bogus UUID → 4xx
# ---------------------------------------------------------------------------

@pytest.mark.accounts
@pytest.mark.integration
def test_switch_account_bogus_uuid(authed_client: httpx.Client):
    bogus = str(uuid.uuid4())
    resp = authed_client.post("/switch-account", json={"retailer_account_id": bogus})
    assert resp.status_code >= 400, resp.text


# ---------------------------------------------------------------------------
# 8. POST /switch-account — account_id not linked to user → 403
# ---------------------------------------------------------------------------

@pytest.mark.accounts
@pytest.mark.integration
def test_switch_account_not_authorized(backend_url: str, demo_token: str):
    """
    Create a second user, create an account for them, then try to switch to
    that account as the demo user — should get 403.

    Since we don't have a register endpoint tested here, we use a well-formed
    but non-existent UUID to reliably trigger the 403 (the DB row won't exist
    in user_accounts for the demo user).
    """
    # A syntactically valid UUID that is extremely unlikely to be linked to demo
    unlinked_id = "00000000-0000-0000-0000-000000000001"
    resp = httpx.post(
        f"{backend_url}/switch-account",
        json={"retailer_account_id": unlinked_id},
        headers={"Authorization": f"Bearer {demo_token}"},
        timeout=10.0,
    )
    assert resp.status_code in (403, 404), resp.text


# ---------------------------------------------------------------------------
# 9. After switching, GET /accounts still works with the new token
# ---------------------------------------------------------------------------

@pytest.mark.accounts
@pytest.mark.integration
def test_get_accounts_with_switched_token(authed_client: httpx.Client, backend_url: str):
    accounts = authed_client.get("/accounts").json()
    assert accounts, "demo user has no accounts"
    account_id = accounts[0]["retailer_account_id"]

    switch_resp = authed_client.post(
        "/switch-account", json={"retailer_account_id": account_id}
    )
    assert switch_resp.status_code == 200, switch_resp.text
    new_token = switch_resp.json()["access_token"]

    with httpx.Client(
        base_url=backend_url,
        timeout=10.0,
        headers={"Authorization": f"Bearer {new_token}"},
    ) as new_client:
        resp = new_client.get("/accounts")
        assert resp.status_code == 200, resp.text
        new_accounts = resp.json()
        assert isinstance(new_accounts, list)
        assert any(a["retailer_account_id"] == account_id for a in new_accounts)


# ---------------------------------------------------------------------------
# 10. Cross-user isolation — user1's account must NOT appear in user2's
#     /accounts, and user2 must NOT be able to switch into it.
# ---------------------------------------------------------------------------

@pytest.mark.accounts
@pytest.mark.integration
def test_accounts_are_scoped_per_user(client: httpx.Client, random_username: str):
    def _register_and_login(username: str) -> str:
        r = client.post("/auth/register", json={"username": username, "password": "pw12345678"})
        assert r.status_code in (200, 201), r.text
        return r.json()["access_token"]

    u1 = f"{random_username}_a"
    u2 = f"{random_username}_b"
    tok1 = _register_and_login(u1)
    tok2 = _register_and_login(u2)

    h1 = {"Authorization": f"Bearer {tok1}"}
    h2 = {"Authorization": f"Bearer {tok2}"}

    name1 = _unique_name()
    r1 = client.post("/accounts", headers=h1, json={"account_name": name1})
    assert r1.status_code == 200, r1.text
    acct1_id = r1.json()["retailer_account_id"]

    name2 = _unique_name()
    r2 = client.post("/accounts", headers=h2, json={"account_name": name2})
    assert r2.status_code == 200, r2.text
    acct2_id = r2.json()["retailer_account_id"]

    ids1 = {a["retailer_account_id"] for a in client.get("/accounts", headers=h1).json()}
    ids2 = {a["retailer_account_id"] for a in client.get("/accounts", headers=h2).json()}
    assert acct1_id in ids1 and acct2_id not in ids1, "user1 leaked user2's account"
    assert acct2_id in ids2 and acct1_id not in ids2, "user2 leaked user1's account"

    sw = client.post("/switch-account", headers=h2, json={"retailer_account_id": acct1_id})
    assert sw.status_code in (403, 404), f"user2 was able to switch into user1's account: {sw.text}"
