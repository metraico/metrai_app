import os
import re
from pathlib import Path

import httpx
import jwt
import psycopg2
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import OAuth2PasswordBearer

from backend.auth import (
    create_access_token,
    create_refresh_token,
    decode_access_token,
    hash_password,
    verify_password,
)

load_dotenv()

SIM_ENGINE_URL = os.getenv("SIM_ENGINE_URL", "http://localhost:8001")
POSTGRES_DSN   = os.getenv("POSTGRES_DSN")

_DEMO_USER_ID    = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"
_DEMO_ACCOUNT_ID = "b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"
_DEMO_PASSWORD   = "demo123"

_MAX_ATTEMPTS    = 5
_LOCKOUT_MINUTES = 15

_PASSWORD_RE = re.compile(r"^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$")

app = FastAPI(title="Metrai App Backend", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/login")


# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------

def _pg_connect():
    return psycopg2.connect(POSTGRES_DSN)


# ---------------------------------------------------------------------------
# Startup: run migration SQL + seed demo password
# ---------------------------------------------------------------------------

@app.on_event("startup")
def _startup():
    if not POSTGRES_DSN:
        return

    migration_sql_path = Path(__file__).parent / "migrations" / "001_auth.sql"
    if not migration_sql_path.exists():
        return

    migration_sql = migration_sql_path.read_text()

    conn = _pg_connect()
    try:
        with conn.cursor() as cur:
            cur.execute(migration_sql)
        conn.commit()
    except Exception as exc:
        conn.rollback()
        import logging
        logging.getLogger(__name__).error("Auth migration failed: %s", exc)
        return
    finally:
        conn.close()

    # Seed the demo user's password if it isn't set yet
    conn = _pg_connect()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT password_hash FROM users WHERE user_id = %s",
                (_DEMO_USER_ID,),
            )
            row = cur.fetchone()
        if row and not row[0]:
            hashed = hash_password(_DEMO_PASSWORD)
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE users SET password_hash = %s WHERE user_id = %s",
                    (hashed, _DEMO_USER_ID),
                )
            conn.commit()
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Auth dependency
# ---------------------------------------------------------------------------

def get_current_user(token: str = Depends(oauth2_scheme)) -> dict:
    try:
        return decode_access_token(token)
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,
                            detail="Token expired",
                            headers={"WWW-Authenticate": "Bearer"})
    except jwt.PyJWTError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,
                            detail="Invalid token",
                            headers={"WWW-Authenticate": "Bearer"})


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------

@app.get("/health")
def health():
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# Auth routes
# ---------------------------------------------------------------------------

@app.post("/auth/login")
def auth_login(credentials: dict):
    if not POSTGRES_DSN:
        raise HTTPException(status_code=503, detail="Database not configured")

    username = (credentials.get("username") or "").strip().lower()
    password = credentials.get("password") or ""

    if not username or not password:
        raise HTTPException(status_code=400, detail="Username and password are required")

    conn = _pg_connect()
    try:
        # Rate-limit check: too many recent failures?
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT COUNT(*) FROM login_attempts
                WHERE username     = %s
                  AND attempted_at > NOW() - INTERVAL '%s minutes'
                  AND success      = FALSE
                """,
                (username, _LOCKOUT_MINUTES),
            )
            fail_count = cur.fetchone()[0]

        if fail_count >= _MAX_ATTEMPTS:
            raise HTTPException(
                status_code=429,
                detail=f"Too many failed attempts. Try again in {_LOCKOUT_MINUTES} minutes.",
            )

        # Look up the user
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT user_id::text, account_id::text, full_name,
                       password_hash, role, is_active
                FROM   users
                WHERE  LOWER(username) = %s
                """,
                (username,),
            )
            row = cur.fetchone()

        success = bool(
            row
            and row[5]  # is_active
            and row[3]  # password_hash is not None
            and verify_password(password, row[3])
        )

        # Record the attempt (always, so failures accumulate)
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO login_attempts (username, success) VALUES (%s, %s)",
                (username, success),
            )
        conn.commit()

        if not success:
            raise HTTPException(status_code=401, detail="Invalid credentials")

        user_id, account_id, full_name, _, role, _ = row

        access_token            = create_access_token(user_id, account_id, role)
        plain_refresh, hash_refresh = create_refresh_token()

        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO refresh_tokens (token_hash, user_id, expires_at)
                VALUES (%s, %s, NOW() + INTERVAL '7 days')
                """,
                (hash_refresh, user_id),
            )
        conn.commit()

        return {
            "access_token":  access_token,
            "refresh_token": plain_refresh,
            "token_type":    "bearer",
            "user_id":       user_id,
            "account_id":    account_id,
            "full_name":     full_name,
            "role":          role,
        }
    finally:
        conn.close()


@app.post("/auth/register")
def auth_register(body: dict):
    if not POSTGRES_DSN:
        raise HTTPException(status_code=503, detail="Database not configured")

    username  = (body.get("username") or "").strip().lower()
    password  = body.get("password") or ""
    email     = (body.get("email") or "").strip().lower()
    full_name = (body.get("full_name") or "").strip()

    if not username or not password:
        raise HTTPException(status_code=400, detail="Username and password are required")

    if len(username) < 3:
        raise HTTPException(status_code=400, detail="Username must be at least 3 characters")

    if not _PASSWORD_RE.match(password):
        raise HTTPException(
            status_code=400,
            detail="Password must be ≥8 characters and contain uppercase, lowercase, and a digit.",
        )

    conn = _pg_connect()
    try:
        # Check username is not already taken
        with conn.cursor() as cur:
            cur.execute("SELECT 1 FROM users WHERE LOWER(username) = %s", (username,))
            if cur.fetchone():
                raise HTTPException(status_code=409, detail="Username already taken")

        password_hash = hash_password(password)

        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO users (username, password_hash, email, full_name, account_id, role, auth_provider)
                VALUES (%s, %s, %s, %s, %s, 'USER', 'local')
                RETURNING user_id::text, account_id::text, full_name, role
                """,
                (username, password_hash, email or None, full_name or username,
                 _DEMO_ACCOUNT_ID),
            )
            row = cur.fetchone()
        conn.commit()

        user_id, account_id, full_name_out, role = row

        access_token            = create_access_token(user_id, account_id, role)
        plain_refresh, hash_refresh = create_refresh_token()

        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO refresh_tokens (token_hash, user_id, expires_at)
                VALUES (%s, %s, NOW() + INTERVAL '7 days')
                """,
                (hash_refresh, user_id),
            )
        conn.commit()

        return {
            "access_token":  access_token,
            "refresh_token": plain_refresh,
            "token_type":    "bearer",
            "user_id":       user_id,
            "account_id":    account_id,
            "full_name":     full_name_out,
            "role":          role,
        }
    finally:
        conn.close()


@app.post("/auth/refresh")
def auth_refresh(body: dict):
    """Exchange a valid refresh token for a new access token."""
    if not POSTGRES_DSN:
        raise HTTPException(status_code=503, detail="Database not configured")

    plain = body.get("refresh_token", "")
    if not plain:
        raise HTTPException(status_code=400, detail="refresh_token is required")

    import hashlib
    token_hash = hashlib.sha256(plain.encode()).hexdigest()

    conn = _pg_connect()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT rt.user_id::text, u.account_id::text, u.role, u.is_active
                FROM   refresh_tokens rt
                JOIN   users u ON u.user_id = rt.user_id
                WHERE  rt.token_hash = %s
                  AND  rt.revoked_at IS NULL
                  AND  rt.expires_at > NOW()
                """,
                (token_hash,),
            )
            row = cur.fetchone()

        if not row or not row[3]:  # not found or user inactive
            raise HTTPException(status_code=401, detail="Refresh token invalid or expired")

        user_id, account_id, role, _ = row

        # Rotate: revoke old token, issue new pair
        new_plain, new_hash = create_refresh_token()
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = %s",
                (token_hash,),
            )
            cur.execute(
                """
                INSERT INTO refresh_tokens (token_hash, user_id, expires_at)
                VALUES (%s, %s, NOW() + INTERVAL '7 days')
                """,
                (new_hash, user_id),
            )
        conn.commit()

        return {
            "access_token":  create_access_token(user_id, account_id, role),
            "refresh_token": new_plain,
            "token_type":    "bearer",
        }
    finally:
        conn.close()


@app.post("/auth/logout")
def auth_logout(body: dict):
    """Revoke the supplied refresh token."""
    plain = body.get("refresh_token", "")
    if not plain or not POSTGRES_DSN:
        return {"status": "ok"}

    import hashlib
    token_hash = hashlib.sha256(plain.encode()).hexdigest()

    conn = _pg_connect()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = %s",
                (token_hash,),
            )
        conn.commit()
    finally:
        conn.close()
    return {"status": "ok"}


@app.get("/auth/me")
def auth_me(current_user: dict = Depends(get_current_user)):
    return {
        "user_id":    current_user["sub"],
        "account_id": current_user["account_id"],
        "role":       current_user["role"],
    }


@app.post("/auth/change-password")
def auth_change_password(body: dict, current_user: dict = Depends(get_current_user)):
    if not POSTGRES_DSN:
        raise HTTPException(status_code=503, detail="Database not configured")

    old_pw  = body.get("old_password", "")
    new_pw  = body.get("new_password", "")

    if not _PASSWORD_RE.match(new_pw):
        raise HTTPException(
            status_code=400,
            detail="Password must be ≥8 characters and contain uppercase, lowercase, and a digit.",
        )

    user_id = current_user["sub"]
    conn = _pg_connect()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT password_hash FROM users WHERE user_id = %s", (user_id,))
            row = cur.fetchone()
        if not row or not verify_password(old_pw, row[0]):
            raise HTTPException(status_code=401, detail="Current password is incorrect")

        new_hash = hash_password(new_pw)
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE users SET password_hash = %s WHERE user_id = %s",
                (new_hash, user_id),
            )
            # Revoke all existing refresh tokens — forces re-login on all devices
            cur.execute(
                "UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = %s AND revoked_at IS NULL",
                (user_id,),
            )
        conn.commit()
    finally:
        conn.close()
    return {"status": "ok", "message": "Password updated. Please log in again."}


# ---------------------------------------------------------------------------
# Run history
# ---------------------------------------------------------------------------

@app.get("/runs")
def get_runs(current_user: dict = Depends(get_current_user)):
    if not POSTGRES_DSN:
        return []
    account_id = current_user["account_id"]
    conn = _pg_connect()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT simulation_id::text, simulation_name, simulation_status,
                       created_at, start_week, end_week, random_seed, notes
                FROM   simulation_config
                WHERE  account_id = %s
                ORDER  BY created_at DESC
                LIMIT  50
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


# ---------------------------------------------------------------------------
# Entity catalogue
# ---------------------------------------------------------------------------

@app.get("/entities")
def get_entities(current_user: dict = Depends(get_current_user)):
    if not POSTGRES_DSN:
        raise HTTPException(status_code=503, detail="No POSTGRES_DSN configured")
    account_id = current_user["account_id"]
    conn = _pg_connect()
    try:
        with conn.cursor() as cur:
            def q(sql, params):
                cur.execute(sql, params)
                cols = [d[0] for d in cur.description]
                return [dict(zip(cols, r)) for r in cur.fetchall()]

            acct = (account_id,)
            return {
                "items":     q("SELECT item_id::text, item_code, item_description FROM items WHERE account_id = %s ORDER BY item_code", acct),
                "stores":    q("SELECT store_id::text, store_code, store_name FROM stores WHERE account_id = %s ORDER BY store_code", acct),
                "dcs":       q("SELECT dc_id::text, dc_code, dc_name FROM distribution_centers WHERE account_id = %s ORDER BY dc_code", acct),
                "suppliers": q("SELECT supplier_id::text, supplier_code, supplier_name FROM suppliers WHERE account_id = %s ORDER BY supplier_code", acct),
            }
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Network mappings — read
# ---------------------------------------------------------------------------

@app.get("/mappings")
def get_mappings(current_user: dict = Depends(get_current_user)):
    if not POSTGRES_DSN:
        raise HTTPException(status_code=503, detail="No POSTGRES_DSN configured")
    account_id = current_user["account_id"]
    conn = _pg_connect()
    try:
        with conn.cursor() as cur:
            def q(sql, params):
                cur.execute(sql, params)
                cols = [d[0] for d in cur.description]
                return [dict(zip(cols, r)) for r in cur.fetchall()]

            acct = (account_id,)
            return {
                "store_items":    q("SELECT si.store_id::text, si.item_id::text FROM store_items si JOIN stores s ON si.store_id = s.store_id WHERE s.account_id = %s", acct),
                "dc_items":       q("SELECT di.dc_id::text, di.item_id::text FROM dc_items di JOIN distribution_centers dc ON di.dc_id = dc.dc_id WHERE dc.account_id = %s", acct),
                "supplier_items": q("SELECT si.supplier_id::text, si.item_id::text FROM supplier_items si JOIN suppliers s ON si.supplier_id = s.supplier_id WHERE s.account_id = %s", acct),
                "store_mappings": q("SELECT sm.from_store_id::text, sm.to_dc_id::text, sm.mapping_type FROM store_mappings sm JOIN stores s ON sm.from_store_id = s.store_id WHERE s.account_id = %s", acct),
                "dc_mappings":    q("SELECT dm.from_dc_id::text, dm.to_node_id::text, dm.mapping_type FROM dc_mappings dm JOIN distribution_centers dc ON dm.from_dc_id = dc.dc_id WHERE dc.account_id = %s", acct),
            }
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Network mappings — write
# ---------------------------------------------------------------------------

@app.post("/mappings")
def save_mappings(body: dict, current_user: dict = Depends(get_current_user)):
    account_id = current_user["account_id"]  # always from JWT, never from body
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

            bulk_insert("store_items",    ["store_id", "item_id"],                          body.get("store_items", []))
            bulk_insert("dc_items",       ["dc_id", "item_id"],                             body.get("dc_items", []))
            bulk_insert("supplier_items", ["supplier_id", "item_id"],                       body.get("supplier_items", []))
            bulk_insert("store_mappings", ["from_store_id", "to_dc_id", "mapping_type"],    body.get("store_mappings", []))
            bulk_insert("dc_mappings",    ["from_dc_id", "to_node_id", "mapping_type"],     body.get("dc_mappings", []))

        conn.commit()
        return {"status": "ok"}
    except Exception as exc:
        conn.rollback()
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Simulation proxy
# ---------------------------------------------------------------------------

@app.post("/run")
async def run_simulation(req: dict, current_user: dict = Depends(get_current_user)):
    req["account_id"] = current_user["account_id"]  # always override from JWT
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
