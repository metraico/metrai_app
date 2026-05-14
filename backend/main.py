import hashlib
import json
import os
import secrets
import time
from collections import defaultdict
from datetime import datetime, timedelta, timezone

import httpx
import jwt
import psycopg2
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

load_dotenv()

SIM_ENGINE_URL = os.getenv("SIM_ENGINE_URL", "http://localhost:8000")
POSTGRES_DSN   = os.getenv("POSTGRES_DSN")
JWT_SECRET     = os.getenv("JWT_SECRET", "dev-secret-change-in-production")

JWT_ALGORITHM    = "HS256"
_ACCESS_MINUTES  = 15
_REFRESH_DAYS    = 7
_RATE_WINDOW     = 900   # seconds (15 min)
_RATE_MAX        = 5     # failed attempts before lockout

app = FastAPI(title="Metrai App Backend", version="0.2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

DUMMY_ACCOUNT_ID = "b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"
DUMMY_USER_ID    = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"

# ── Auth helpers ─────────────────────────────────────────────────────────────

_ph     = PasswordHasher()           # Argon2id defaults (OWASP #1)
_bearer = HTTPBearer(auto_error=False)
_rate:   dict[str, list[float]] = defaultdict(list)


def _pg_connect():
    return psycopg2.connect(POSTGRES_DSN)


def _check_rate_limit(username: str):
    now      = time.time()
    attempts = _rate[username]
    attempts[:] = [t for t in attempts if now - t < _RATE_WINDOW]
    if len(attempts) >= _RATE_MAX:
        raise HTTPException(
            status_code=429,
            detail="Too many failed attempts. Try again in 15 minutes.",
        )


def _record_fail(username: str):
    _rate[username].append(time.time())


def _clear_rate(username: str):
    _rate.pop(username, None)


def _create_access_token(user_id: str, account_id: str, role: str) -> str:
    exp = datetime.now(timezone.utc) + timedelta(minutes=_ACCESS_MINUTES)
    return jwt.encode(
        {"sub": user_id, "account_id": account_id, "role": role,
         "type": "access", "exp": exp},
        JWT_SECRET, algorithm=JWT_ALGORITHM,
    )


def _make_refresh_token() -> tuple[str, str]:
    """Return (raw_token, sha256_hex). Store only the hash."""
    raw = secrets.token_urlsafe(48)
    return raw, hashlib.sha256(raw.encode()).hexdigest()


def _store_refresh_token(user_id: str, token_hash: str, expires_at: datetime):
    conn = _pg_connect()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO refresh_tokens (token_hash, user_id, expires_at) VALUES (%s,%s,%s)",
                (token_hash, user_id, expires_at),
            )
        conn.commit()
    finally:
        conn.close()


def _revoke_refresh_token(token_hash: str):
    conn = _pg_connect()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE refresh_tokens SET revoked = TRUE WHERE token_hash = %s",
                (token_hash,),
            )
        conn.commit()
    finally:
        conn.close()


async def get_current_user(
    creds: HTTPAuthorizationCredentials = Depends(_bearer),
) -> dict:
    if not creds:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        payload = jwt.decode(
            creds.credentials, JWT_SECRET,
            algorithms=[JWT_ALGORITHM],
            options={"require": ["sub", "account_id", "exp"]},
        )
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="Invalid token")
    if payload.get("type") != "access":
        raise HTTPException(status_code=401, detail="Invalid token type")
    payload["user_id"] = payload["sub"]
    return payload


# ── Bootstrap ────────────────────────────────────────────────────────────────

@app.on_event("startup")
def _bootstrap_demo_password():
    """Hash demo123 for the demo user if no password has been set yet."""
    if not POSTGRES_DSN:
        return
    try:
        conn = _pg_connect()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT password_hash FROM users WHERE user_id = %s",
                    (DUMMY_USER_ID,),
                )
                row = cur.fetchone()
                if row and not row[0]:
                    cur.execute(
                        "UPDATE users SET password_hash = %s WHERE user_id = %s",
                        (_ph.hash("demo123"), DUMMY_USER_ID),
                    )
                    conn.commit()
        finally:
            conn.close()
    except Exception:
        pass


# ── Health ────────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok"}


# ── Auth endpoints ────────────────────────────────────────────────────────────

@app.post("/register")
def register(body: dict):
    username  = (body.get("username") or "").strip().lower()
    password  = body.get("password") or ""
    email     = (body.get("email") or "").strip().lower()
    full_name = (body.get("full_name") or "").strip()

    if not username:
        raise HTTPException(status_code=422, detail="Username is required")
    if not password:
        raise HTTPException(status_code=422, detail="Password is required")
    if len(password) < 8:
        raise HTTPException(status_code=422, detail="Password must be at least 8 characters")
    if not POSTGRES_DSN:
        raise HTTPException(status_code=503, detail="No database configured")

    conn = _pg_connect()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT 1 FROM users WHERE username = %s", (username,))
            if cur.fetchone():
                raise HTTPException(status_code=409, detail="Username already taken")

            # Auto-join the single demo account (all users share the same data in Phase 1)
            cur.execute("SELECT account_id::text FROM retailer_accounts ORDER BY account_id LIMIT 1")
            row = cur.fetchone()
            account_id = row[0] if row else None

            cur.execute(
                """
                INSERT INTO users (username, email, full_name, password_hash, account_id, auth_provider, role)
                VALUES (%s, %s, %s, %s, %s, 'local', 'ADMIN')
                RETURNING user_id::text
                """,
                (username, email or None, full_name or username, _ph.hash(password), account_id),
            )
            user_id = cur.fetchone()[0]

            if account_id:
                cur.execute(
                    "INSERT INTO user_accounts (user_id, account_id) VALUES (%s, %s) ON CONFLICT DO NOTHING",
                    (user_id, account_id),
                )

        conn.commit()
    except HTTPException:
        conn.rollback()
        raise
    except Exception as exc:
        conn.rollback()
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        conn.close()

    access_token    = _create_access_token(user_id, account_id or "", "ADMIN")
    raw_rt, rt_hash = _make_refresh_token()
    _store_refresh_token(user_id, rt_hash, datetime.now(timezone.utc) + timedelta(days=_REFRESH_DAYS))

    return {
        "access_token":  access_token,
        "refresh_token": raw_rt,
        "token_type":    "bearer",
        "user_id":       user_id,
        "account_id":    account_id,
        "full_name":     full_name or username,
    }


@app.get("/accounts")
def get_accounts(current_user: dict = Depends(get_current_user)):
    user_id = current_user["user_id"]
    if not POSTGRES_DSN:
        return []
    conn = _pg_connect()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT ra.account_id::text, ra.account_code, ra.account_name,
                       ra.account_type, ra.country_code, ra.region,
                       ra.currency_code, ra.is_active
                FROM retailer_accounts ra
                JOIN user_accounts ua ON ra.account_id = ua.account_id
                WHERE ua.user_id = %s
                ORDER BY ra.account_name
                """,
                (user_id,),
            )
            cols = [d[0] for d in cur.description]
            return [dict(zip(cols, r)) for r in cur.fetchall()]
    finally:
        conn.close()


@app.post("/accounts")
def create_account(body: dict, current_user: dict = Depends(get_current_user)):
    user_id      = current_user["user_id"]
    account_name = (body.get("account_name") or "").strip()
    account_type = (body.get("account_type") or "GROCERY").strip().upper()
    country_code = (body.get("country_code") or "US").strip().upper()
    region       = (body.get("region") or "").strip()
    currency     = (body.get("currency_code") or "USD").strip().upper()

    if not account_name:
        raise HTTPException(status_code=422, detail="Account name is required")
    if not POSTGRES_DSN:
        raise HTTPException(status_code=503, detail="No database configured")

    # Auto-generate a unique account code from the name
    base = "ACCT_" + "".join(c if c.isalnum() else "_" for c in account_name.upper())[:15].strip("_")

    conn = _pg_connect()
    try:
        with conn.cursor() as cur:
            account_id_c = base
            suffix = 1
            while True:
                cur.execute("SELECT 1 FROM retailer_accounts WHERE account_code = %s", (account_id_c,))
                if not cur.fetchone():
                    break
                account_id_c = f"{base}_{suffix}"
                suffix += 1

            cur.execute(
                """
                INSERT INTO retailer_accounts
                    (account_code, account_name, account_type, country_code, region, currency_code, is_active)
                VALUES (%s, %s, %s, %s, %s, %s, true)
                RETURNING account_id::text
                """,
                (account_id_c, account_name, account_type,
                 country_code or None, region or None, currency),
            )
            new_account_id = cur.fetchone()[0]

            cur.execute(
                "INSERT INTO user_accounts (user_id, account_id) VALUES (%s, %s) ON CONFLICT DO NOTHING",
                (user_id, new_account_id),
            )
        conn.commit()
    except HTTPException:
        conn.rollback()
        raise
    except Exception as exc:
        conn.rollback()
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        conn.close()

    return {"account_id": new_account_id, "account_code": account_id_c, "account_name": account_name}


@app.post("/switch-account")
def switch_account(body: dict, current_user: dict = Depends(get_current_user)):
    user_id    = current_user["user_id"]
    account_id = (body.get("account_id") or "").strip()
    if not account_id:
        raise HTTPException(status_code=422, detail="account_id is required")
    if not POSTGRES_DSN:
        raise HTTPException(status_code=503, detail="No database configured")

    conn = _pg_connect()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT 1 FROM user_accounts WHERE user_id = %s AND account_id = %s",
                (user_id, account_id),
            )
            if not cur.fetchone():
                raise HTTPException(status_code=403, detail="Access denied to this account")
            cur.execute("UPDATE users SET account_id = %s WHERE user_id = %s", (account_id, user_id))
        conn.commit()
    finally:
        conn.close()

    role = current_user.get("role", "ADMIN")
    access_token    = _create_access_token(user_id, account_id, role)
    raw_rt, rt_hash = _make_refresh_token()
    _store_refresh_token(user_id, rt_hash, datetime.now(timezone.utc) + timedelta(days=_REFRESH_DAYS))
    return {
        "access_token":  access_token,
        "refresh_token": raw_rt,
        "token_type":    "bearer",
        "account_id":    account_id,
    }

@app.post("/login")
def login(credentials: dict):
    username = (credentials.get("username") or "").strip().lower()
    password = credentials.get("password") or ""

    _check_rate_limit(username)

    if not POSTGRES_DSN:
        raise HTTPException(status_code=503, detail="No database configured")

    conn = _pg_connect()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT user_id::text, password_hash, full_name, role, is_active,
                       account_id::text
                FROM users WHERE username = %s
                """,
                (username,),
            )
            row = cur.fetchone()
    finally:
        conn.close()

    if not row or not row[1]:
        _record_fail(username)
        raise HTTPException(status_code=401, detail="Invalid username or password")

    user_id, pw_hash, full_name, role, is_active, account_id = row

    if not is_active:
        raise HTTPException(status_code=401, detail="Account disabled")

    try:
        _ph.verify(pw_hash, password)
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        _record_fail(username)
        raise HTTPException(status_code=401, detail="Invalid username or password")

    # Rehash silently if Argon2 params have changed
    if _ph.check_needs_rehash(pw_hash):
        conn = _pg_connect()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE users SET password_hash = %s WHERE user_id = %s",
                    (_ph.hash(password), user_id),
                )
            conn.commit()
        finally:
            conn.close()

    _clear_rate(username)

    access_token       = _create_access_token(user_id, account_id, role)
    raw_rt, rt_hash    = _make_refresh_token()
    expires_at         = datetime.now(timezone.utc) + timedelta(days=_REFRESH_DAYS)
    _store_refresh_token(user_id, rt_hash, expires_at)

    return {
        "access_token":  access_token,
        "refresh_token": raw_rt,
        "token_type":    "bearer",
        "user_id":       user_id,
        "account_id":    account_id,
        "full_name":     full_name or "User",
    }


@app.post("/refresh")
def refresh_token(body: dict):
    raw_rt = body.get("refresh_token", "")
    if not raw_rt:
        raise HTTPException(status_code=401, detail="Missing refresh token")

    token_hash = hashlib.sha256(raw_rt.encode()).hexdigest()
    conn = _pg_connect()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT rt.user_id::text, rt.expires_at, rt.revoked,
                       u.account_id::text, u.role, u.is_active
                FROM refresh_tokens rt
                JOIN users u ON rt.user_id = u.user_id
                WHERE rt.token_hash = %s
                """,
                (token_hash,),
            )
            row = cur.fetchone()
    finally:
        conn.close()

    if not row:
        raise HTTPException(status_code=401, detail="Invalid refresh token")

    user_id, expires_at, revoked, account_id, role, is_active = row

    if revoked or not is_active:
        raise HTTPException(status_code=401, detail="Token revoked")

    exp_utc = expires_at if expires_at.tzinfo else expires_at.replace(tzinfo=timezone.utc)
    if exp_utc < datetime.now(timezone.utc):
        raise HTTPException(status_code=401, detail="Refresh token expired")

    # Rotate: revoke old token, issue new pair
    _revoke_refresh_token(token_hash)
    new_access          = _create_access_token(user_id, account_id, role)
    new_raw, new_hash   = _make_refresh_token()
    _store_refresh_token(user_id, new_hash,
                         datetime.now(timezone.utc) + timedelta(days=_REFRESH_DAYS))

    return {
        "access_token":  new_access,
        "refresh_token": new_raw,
        "token_type":    "bearer",
    }


@app.post("/logout")
def logout(body: dict, current_user: dict = Depends(get_current_user)):
    raw_rt = body.get("refresh_token", "")
    if raw_rt:
        _revoke_refresh_token(hashlib.sha256(raw_rt.encode()).hexdigest())
    return {"status": "ok"}


# ── Run history ───────────────────────────────────────────────────────────────

@app.get("/runs")
def get_runs(current_user: dict = Depends(get_current_user)):
    account_id = current_user["account_id"]
    if not POSTGRES_DSN:
        return []
    conn = _pg_connect()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT simulation_id::text, simulation_name, simulation_status,
                       created_at, start_week, end_week, random_seed, notes
                FROM simulation_config
                WHERE account_id = %s
                ORDER BY created_at DESC
                LIMIT 50
                """,
                (account_id,),
            )
            cols = [d[0] for d in cur.description]
            rows = [dict(zip(cols, row)) for row in cur.fetchall()]
            for row in rows:
                for k, v in row.items():
                    if hasattr(v, "isoformat"):
                        row[k] = v.isoformat()
            return rows
    finally:
        conn.close()


# ── Entity catalogue ──────────────────────────────────────────────────────────

def _resolve_data_account(cur, account_id: str) -> str:
    """Return account_id to use for catalog data. Falls back to demo account if this account has no items."""
    cur.execute("SELECT 1 FROM items WHERE account_id = %s LIMIT 1", (account_id,))
    if cur.fetchone():
        return account_id
    cur.execute("SELECT account_id::text FROM items LIMIT 1")
    row = cur.fetchone()
    return row[0] if row else account_id


@app.get("/entities")
def get_entities(current_user: dict = Depends(get_current_user)):
    account_id = current_user["account_id"]
    if not POSTGRES_DSN:
        raise HTTPException(status_code=503, detail="No POSTGRES_DSN configured")
    conn = _pg_connect()
    try:
        with conn.cursor() as cur:
            data_acct = _resolve_data_account(cur, account_id)

            def q(sql, params):
                cur.execute(sql, params)
                cols = [d[0] for d in cur.description]
                return [dict(zip(cols, r)) for r in cur.fetchall()]

            acct = (data_acct,)
            return {
                "items":     q("SELECT item_id::text, item_code, item_description FROM items WHERE account_id = %s ORDER BY item_code", acct),
                "stores":    q("SELECT store_id::text, store_code, store_name FROM stores WHERE account_id = %s ORDER BY store_code", acct),
                "dcs":       q("SELECT dc_id::text, dc_code, dc_name FROM distribution_centers WHERE account_id = %s ORDER BY dc_code", acct),
                "suppliers": q("SELECT supplier_id::text, supplier_code, supplier_name FROM suppliers WHERE account_id = %s ORDER BY supplier_code", acct),
            }
    finally:
        conn.close()


# ── Network mappings ──────────────────────────────────────────────────────────

@app.get("/mappings")
def get_mappings(current_user: dict = Depends(get_current_user)):
    account_id = current_user["account_id"]
    if not POSTGRES_DSN:
        raise HTTPException(status_code=503, detail="No POSTGRES_DSN configured")
    conn = _pg_connect()
    try:
        with conn.cursor() as cur:
            data_acct = _resolve_data_account(cur, account_id)

            def q(sql, params):
                cur.execute(sql, params)
                cols = [d[0] for d in cur.description]
                return [dict(zip(cols, r)) for r in cur.fetchall()]

            acct = (data_acct,)
            return {
                "store_items":    q("SELECT si.store_id::text, si.item_id::text FROM store_items si JOIN stores s ON si.store_id = s.store_id WHERE s.account_id = %s", acct),
                "dc_items":       q("SELECT di.dc_id::text, di.item_id::text FROM dc_items di JOIN distribution_centers dc ON di.dc_id = dc.dc_id WHERE dc.account_id = %s", acct),
                "supplier_items": q("SELECT si.supplier_id::text, si.item_id::text FROM supplier_items si JOIN suppliers s ON si.supplier_id = s.supplier_id WHERE s.account_id = %s", acct),
                "store_mappings": q("SELECT sm.from_store_id::text, sm.to_dc_id::text, sm.mapping_type FROM store_mappings sm JOIN stores s ON sm.from_store_id = s.store_id WHERE s.account_id = %s", acct),
                "dc_mappings":    q("SELECT dm.from_dc_id::text, dm.to_node_id::text, dm.mapping_type FROM dc_mappings dm JOIN distribution_centers dc ON dm.from_dc_id = dc.dc_id WHERE dc.account_id = %s", acct),
            }
    finally:
        conn.close()


@app.post("/mappings")
def save_mappings(body: dict, current_user: dict = Depends(get_current_user)):
    account_id = current_user["account_id"]   # always from JWT, never from body
    if not POSTGRES_DSN:
        raise HTTPException(status_code=503, detail="No POSTGRES_DSN configured")
    conn = _pg_connect()
    try:
        with conn.cursor() as cur:
            acct = (account_id,)
            cur.execute("DELETE FROM store_items WHERE store_id IN (SELECT store_id FROM stores WHERE account_id = %s)", acct)
            cur.execute("DELETE FROM dc_items WHERE dc_id IN (SELECT dc_id FROM distribution_centers WHERE account_id = %s)", acct)
            cur.execute("DELETE FROM supplier_items WHERE supplier_id IN (SELECT supplier_id FROM suppliers WHERE account_id = %s)", acct)
            cur.execute("DELETE FROM store_mappings WHERE from_store_id IN (SELECT store_id FROM stores WHERE account_id = %s)", acct)
            cur.execute("DELETE FROM dc_mappings WHERE from_dc_id IN (SELECT dc_id FROM distribution_centers WHERE account_id = %s)", acct)

            def bulk_insert(table: str, cols: list[str], rows: list[dict]):
                if not rows:
                    return
                placeholders = ", ".join([f"({', '.join(['%s'] * len(cols))})"] * len(rows))
                values = [row[c] for row in rows for c in cols]
                cur.execute(f"INSERT INTO {table} ({', '.join(cols)}) VALUES {placeholders}", values)

            bulk_insert("store_items",    ["store_id", "item_id"],                           body.get("store_items", []))
            bulk_insert("dc_items",       ["dc_id", "item_id"],                              body.get("dc_items", []))
            bulk_insert("supplier_items", ["supplier_id", "item_id"],                        body.get("supplier_items", []))
            bulk_insert("store_mappings", ["from_store_id", "to_dc_id", "mapping_type"],     body.get("store_mappings", []))
            bulk_insert("dc_mappings",    ["from_dc_id", "to_node_id", "mapping_type"],      body.get("dc_mappings", []))

        conn.commit()
        return {"status": "ok"}
    except Exception as exc:
        conn.rollback()
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        conn.close()


# ── Promos ────────────────────────────────────────────────────────────────────

@app.get("/promos")
def get_promos(current_user: dict = Depends(get_current_user)):
    account_id = current_user["account_id"]
    if not POSTGRES_DSN:
        raise HTTPException(status_code=503, detail="No POSTGRES_DSN configured")
    conn = _pg_connect()
    try:
        with conn.cursor() as cur:
            data_acct = _resolve_data_account(cur, account_id)
            cur.execute(
                """
                SELECT p.promo_id::text, p.promo_name, p.start_date::text, p.end_date::text,
                       p.demand_multiplier, pg.promo_group_name,
                       array_agg(pgi.item_id::text) AS item_ids
                FROM promos p
                JOIN promo_groups pg ON p.promo_group_id = pg.promo_group_id
                JOIN promo_group_items pgi ON pg.promo_group_id = pgi.promo_group_id
                WHERE p.account_id = %s AND p.simulation_id IS NULL
                GROUP BY p.promo_id, p.promo_name, p.start_date, p.end_date,
                         p.demand_multiplier, pg.promo_group_name
                ORDER BY p.start_date
                """,
                (data_acct,),
            )
            cols = [d[0] for d in cur.description]
            rows = [dict(zip(cols, row)) for row in cur.fetchall()]
            for row in rows:
                for k, v in row.items():
                    if hasattr(v, "isoformat"):
                        row[k] = v.isoformat()
            return rows
    finally:
        conn.close()


# ── Simulation proxy ──────────────────────────────────────────────────────────

@app.post("/run")
async def run_simulation(req: dict, current_user: dict = Depends(get_current_user)):
    req["account_id"] = current_user["account_id"]  # enforce from JWT
    try:
        async with httpx.AsyncClient(timeout=300.0) as client:
            resp = await client.post(f"{SIM_ENGINE_URL}/simulate", json=req)
            resp.raise_for_status()
            return resp.json()
    except httpx.ConnectError:
        raise HTTPException(status_code=503, detail="Simulation engine is not reachable")
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Simulation timed out")
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=e.response.status_code, detail=e.response.text)


# ── Scenario validate proxy ───────────────────────────────────────────────────

@app.post("/scenario/validate")
async def validate_scenario(body: dict, current_user: dict = Depends(get_current_user)):
    body["account_id"] = current_user["account_id"]  # enforce from JWT
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(f"{SIM_ENGINE_URL}/scenario/validate", json=body)
            resp.raise_for_status()
            return resp.json()
    except httpx.ConnectError:
        raise HTTPException(status_code=503, detail="Simulation engine is not reachable")
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=e.response.status_code, detail=e.response.text)


# ── Past simulation retrieval (proxy) ─────────────────────────────────────────

@app.get("/simulation/{simulation_id}")
async def get_simulation(simulation_id: str, current_user: dict = Depends(get_current_user)):
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.get(f"{SIM_ENGINE_URL}/simulation/{simulation_id}")
            resp.raise_for_status()
            return resp.json()
    except httpx.ConnectError:
        raise HTTPException(status_code=503, detail="Simulation engine is not reachable")
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=e.response.status_code, detail=e.response.text)


@app.get("/run-config/{simulation_id}")
async def get_run_config(simulation_id: str, current_user: dict = Depends(get_current_user)):
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(f"{SIM_ENGINE_URL}/run-config/{simulation_id}")
            resp.raise_for_status()
            return resp.json()
    except httpx.ConnectError:
        raise HTTPException(status_code=503, detail="Simulation engine is not reachable")
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=e.response.status_code, detail=e.response.text)
