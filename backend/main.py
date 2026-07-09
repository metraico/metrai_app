import hashlib
import json
import logging
import os
import secrets
import time
from collections import defaultdict
from datetime import datetime, timedelta, timezone

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)
logger = logging.getLogger("metrai_backend")

import httpx
import jwt
import psycopg2
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

load_dotenv()

logger = logging.getLogger("metrai.backend")

SIM_ENGINE_URL = os.getenv("SIM_ENGINE_URL", "http://localhost:8000")
POSTGRES_DSN   = os.getenv("POSTGRES_DSN")
JWT_SECRET     = os.getenv("JWT_SECRET", "dev-secret-change-in-production")

JWT_ALGORITHM    = "HS256"
_ACCESS_MINUTES  = 1440  # 24 hours
_REFRESH_DAYS    = 7
_RATE_WINDOW     = 900   # seconds (15 min)
_RATE_MAX        = 5     # failed attempts before lockout

app = FastAPI(
    title="Metrai App Backend",
    version="0.2.0",
    openapi_tags=[
        {"name": "auth",        "description": "Register, login, token refresh, and logout"},
        {"name": "accounts",    "description": "Retailer account management and account switching"},
        {"name": "runs",        "description": "Simulation run history and YAML template generation"},
        {"name": "entities",    "description": "Reference data — items, stores, DCs, suppliers, network mappings"},
        {"name": "promos",      "description": "Promo catalogue read access"},
        {"name": "simulation",  "description": "Simulation execution, lifecycle, and proxied run-config"},
        {"name": "analytics",   "description": "Proxied analytics from the simulation engine"},
        {"name": "system",      "description": "Health and liveness"},
    ],
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def _log_requests(request: Request, call_next):
    t0 = time.perf_counter()
    response = await call_next(request)
    ms = (time.perf_counter() - t0) * 1000
    logger.info("%s %s → %d  (%.0fms)", request.method, request.url.path, response.status_code, ms)
    return response

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


def _create_access_token(user_id: str, retailer_account_id: str, role: str) -> str:
    exp = datetime.now(timezone.utc) + timedelta(minutes=_ACCESS_MINUTES)
    return jwt.encode(
        {"sub": user_id, "retailer_account_id": retailer_account_id, "role": role,
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
            options={"require": ["sub", "exp"]},
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
    """Set username=demo and password=12345678 for the demo user if not already set."""
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
                        "UPDATE users SET username = 'demo', password_hash = %s WHERE user_id = %s",
                        (_ph.hash("12345678"), DUMMY_USER_ID),
                    )
                    conn.commit()
        finally:
            conn.close()
    except Exception:
        pass


# ── Health ────────────────────────────────────────────────────────────────────

@app.get(
    "/health",
    tags=["system"],
    summary="Service liveness check",
    description="Returns `{\"status\": \"ok\"}` when the backend is running. Use this as a Docker/load-balancer health probe. No authentication required.",
)
def health():
    """Returns `{"status": "ok"}` when the backend is running. Use as a Docker / load-balancer health probe. No authentication required."""
    return {"status": "ok"}


# ── Auth endpoints ────────────────────────────────────────────────────────────

@app.post(
    "/auth/register",
    tags=["auth"],
    summary="Create a new user account",
    description=(
        "Registers a new user with a username, password, email, and full name. "
        "Password must be at least 8 characters and is hashed with Argon2id before storage. "
        "On success, returns an access token, refresh token, and the new user's ID. "
        "The user is automatically linked to the shared demo retailer account (SALTYSNACK) on first registration. "
        "Returns 409 if the username is already taken."
    ),
)
@app.post("/register", tags=["auth"], include_in_schema=False)
def register(body: dict):
    """
    Registers a new user with username, password, email, and full name.
    Password must be at least 8 characters — stored as an Argon2id hash.
    Returns an access token and refresh token on success.
    The new user is automatically linked to the shared SALTYSNACK demo account.
    Returns **409** if the username is already taken.
    """
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

            cur.execute(
                """
                INSERT INTO users (username, email, full_name, password_hash, auth_provider, role)
                VALUES (%s, %s, %s, %s, 'local', 'ADMIN')
                RETURNING user_id::text
                """,
                (username, email or None, full_name or username, _ph.hash(password)),
            )
            user_id = cur.fetchone()[0]

            # Auto-join the shared SALTYSNACK demo account on registration
            cur.execute(
                "SELECT retailer_account_id::text FROM retailer_accounts WHERE retailer_account_code = 'SALTYSNACK' LIMIT 1"
            )
            row = cur.fetchone()
            if row:
                cur.execute(
                    "INSERT INTO user_accounts (user_id, retailer_account_id) VALUES (%s, %s) ON CONFLICT DO NOTHING",
                    (user_id, row[0]),
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

    access_token    = _create_access_token(user_id, "", "ADMIN")
    raw_rt, rt_hash = _make_refresh_token()
    _store_refresh_token(user_id, rt_hash, datetime.now(timezone.utc) + timedelta(days=_REFRESH_DAYS))

    return {
        "access_token":        access_token,
        "refresh_token":       raw_rt,
        "token_type":          "bearer",
        "user_id":             user_id,
        "retailer_account_id": None,
        "full_name":           full_name or username,
    }


@app.get(
    "/accounts",
    tags=["accounts"],
    summary="List retailer accounts for the logged-in user",
    description=(
        "Returns all retailer accounts the authenticated user has been granted access to. "
        "This is the first call to make after login — the response gives you the `retailer_account_id` values "
        "needed to call `POST /switch-account` and scope your session to a specific account. "
        "Each account includes its code, name, type (e.g. GROCERY), country, currency, and active status."
    ),
)
def get_accounts(current_user: dict = Depends(get_current_user)):
    """
    Returns all retailer accounts the authenticated user has been granted access to.

    This is typically the first call after login — use the returned `retailer_account_id`
    values to call `POST /switch-account` and scope your session to a specific account.
    Each account includes its code, name, type (e.g. GROCERY), country, currency, and active status.
    """
    user_id = current_user["user_id"]
    if not POSTGRES_DSN:
        return []
    conn = _pg_connect()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT ra.retailer_account_id::text AS retailer_account_id,
                       ra.retailer_account_code AS retailer_account_code,
                       ra.retailer_account_name AS retailer_account_name,
                       ra.retailer_account_type AS retailer_account_type,
                       ra.country_code, ra.region,
                       ra.currency_code, ra.is_active
                FROM retailer_accounts ra
                JOIN user_accounts ua ON ra.retailer_account_id = ua.retailer_account_id
                WHERE ua.user_id = %s
                ORDER BY ra.retailer_account_name
                """,
                (user_id,),
            )
            cols = [d[0] for d in cur.description]
            return [dict(zip(cols, r)) for r in cur.fetchall()]
    finally:
        conn.close()


@app.post(
    "/accounts",
    tags=["accounts"],
    summary="Create a new retailer account",
    description=(
        "Creates a new retailer account and automatically links it to the authenticated user. "
        "Required field: `account_name`. Optional: `account_type` (default: GROCERY), `country_code` (default: US), `currency_code` (default: USD), `region`. "
        "The `retailer_account_code` is auto-generated from the name (e.g. 'My Store Co' → `ACCT_MY_STORE_CO`) — you do not supply it. "
        "After creation, call `POST /switch-account` with the returned `retailer_account_id` to start using this account for simulations."
    ),
)
def create_account(body: dict, current_user: dict = Depends(get_current_user)):
    """
    Creates a new retailer account and automatically links it to the authenticated user.

    **Required:** `account_name`.
    **Optional:** `account_type` (default: GROCERY), `country_code` (default: US), `currency_code` (default: USD), `region`.

    The `retailer_account_code` is **auto-generated** from the name
    (e.g. "My Store Co" → `ACCT_MY_STORE_CO`) — do not supply it yourself.
    After creation, call `POST /switch-account` with the returned `retailer_account_id`
    to start using this account for simulations.
    """
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
                cur.execute("SELECT 1 FROM retailer_accounts WHERE retailer_account_code = %s", (account_id_c,))
                if not cur.fetchone():
                    break
                account_id_c = f"{base}_{suffix}"
                suffix += 1

            cur.execute(
                """
                INSERT INTO retailer_accounts
                    (retailer_account_code, retailer_account_name, retailer_account_type, country_code, region, currency_code, is_active)
                VALUES (%s, %s, %s, %s, %s, %s, true)
                RETURNING retailer_account_id::text
                """,
                (account_id_c, account_name, account_type,
                 country_code or None, region or None, currency),
            )
            new_account_id = cur.fetchone()[0]

            cur.execute(
                "INSERT INTO user_accounts (user_id, retailer_account_id) VALUES (%s, %s) ON CONFLICT DO NOTHING",
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

    return {"retailer_account_id": new_account_id, "retailer_account_code": account_id_c, "retailer_account_name": account_name}


@app.post(
    "/switch-account",
    tags=["accounts"],
    summary="Scope your session to a specific retailer account",
    description=(
        "Issues a new access + refresh token pair with the chosen `retailer_account_id` embedded in the JWT. "
        "**This must be called after login before using any simulation, run, entity, promo, or analytics APIs** — "
        "those endpoints read the retailer account directly from the token and return empty results (or 422) without it. "
        "Pass the `retailer_account_id` from `GET /accounts` in the request body. "
        "Returns 403 if the authenticated user does not have access to the requested account. "
        "Store the returned tokens and use them for all subsequent requests."
    ),
)
def switch_account(body: dict, current_user: dict = Depends(get_current_user)):
    """
    Issues a new access + refresh token pair with the chosen `retailer_account_id` embedded in the JWT.

    **This must be called after login before using any simulation, run, entity, promo, or analytics APIs.**
    Those endpoints read `retailer_account_id` directly from the token and return empty results (or errors) without it.

    Pass the `retailer_account_id` from `GET /accounts` in the body.
    Store the returned tokens and use them for all subsequent requests.
    Returns **403** if the authenticated user does not have access to the requested account.
    """
    user_id             = current_user["user_id"]
    retailer_account_id = (body.get("retailer_account_id") or "").strip()
    if not retailer_account_id:
        raise HTTPException(status_code=422, detail="retailer_account_id is required")
    if not POSTGRES_DSN:
        raise HTTPException(status_code=503, detail="No database configured")

    conn = _pg_connect()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT 1 FROM user_accounts WHERE user_id = %s AND retailer_account_id = %s",
                (user_id, retailer_account_id),
            )
            if not cur.fetchone():
                raise HTTPException(status_code=403, detail="Access denied to this account")
        conn.commit()
    finally:
        conn.close()

    role = current_user.get("role", "ADMIN")
    access_token    = _create_access_token(user_id, retailer_account_id, role)
    raw_rt, rt_hash = _make_refresh_token()
    _store_refresh_token(user_id, rt_hash, datetime.now(timezone.utc) + timedelta(days=_REFRESH_DAYS))
    return {
        "access_token":       access_token,
        "refresh_token":      raw_rt,
        "token_type":         "bearer",
        "retailer_account_id": retailer_account_id,
    }

@app.post(
    "/auth/login",
    tags=["auth"],
    summary="Log in and obtain tokens",
    description=(
        "Authenticates a user by username and password. "
        "Returns an access token (valid 24 hours) and a refresh token (valid 7 days). "
        "The access token is a JWT — include it as `Authorization: Bearer <token>` on all protected endpoints. "
        "Note: the token at this stage carries no `retailer_account_id`. "
        "You must call `POST /switch-account` after login to scope the token to a specific retailer account before using simulation or analytics APIs. "
        "Rate-limited to 5 failed attempts per 15 minutes per username."
    ),
)
@app.post("/login", tags=["auth"], include_in_schema=False)
def login(credentials: dict):
    """
    Authenticates a user by username and password.
    Returns an **access token** (valid 24 hours) and a **refresh token** (valid 7 days).
    Include the access token as `Authorization: Bearer <token>` on all protected endpoints.

    **Important:** the token at this stage carries no `retailer_account_id`.
    Call `POST /switch-account` after login to scope the token to a specific retailer account
    before using simulation, analytics, runs, or entity APIs.

    Rate-limited to 5 failed attempts per 15 minutes per username.
    """
    username = (credentials.get("username") or "").strip().lower()
    password = credentials.get("password") or ""

    _check_rate_limit(username)

    if not POSTGRES_DSN:
        raise HTTPException(status_code=503, detail="No database configured")

    conn = _pg_connect()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT user_id::text, password_hash, full_name, role, is_active FROM users WHERE username = %s",
                (username,),
            )
            row = cur.fetchone()
    finally:
        conn.close()

    if not row or not row[1]:
        _record_fail(username)
        raise HTTPException(status_code=401, detail="Invalid username or password")

    user_id, pw_hash, full_name, role, is_active = row

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

    access_token       = _create_access_token(user_id, "", role)
    raw_rt, rt_hash    = _make_refresh_token()
    expires_at         = datetime.now(timezone.utc) + timedelta(days=_REFRESH_DAYS)
    _store_refresh_token(user_id, rt_hash, expires_at)

    return {
        "access_token":        access_token,
        "refresh_token":       raw_rt,
        "token_type":          "bearer",
        "user_id":             user_id,
        "retailer_account_id": None,
        "full_name":           full_name or "User",
    }


@app.post(
    "/auth/refresh",
    tags=["auth"],
    summary="Refresh an expired access token",
    description=(
        "Exchanges a valid refresh token for a new access token + refresh token pair (token rotation). "
        "Use this when the access token has expired (the frontend Axios interceptor calls this automatically on 401 responses). "
        "The old refresh token is revoked immediately after use — each refresh token is single-use. "
        "Returns 401 if the token is expired, revoked, or invalid."
    ),
)
@app.post("/refresh", tags=["auth"], include_in_schema=False)
def refresh_token(body: dict):
    """
    Exchanges a valid refresh token for a new access + refresh token pair (token rotation).
    The old refresh token is **immediately revoked** — each refresh token is single-use.
    The frontend Axios interceptor calls this automatically on 401 responses.
    Returns **401** if the token is expired, revoked, or not found.
    """
    raw_rt = body.get("refresh_token", "")
    if not raw_rt:
        raise HTTPException(status_code=401, detail="Missing refresh token")

    token_hash = hashlib.sha256(raw_rt.encode()).hexdigest()
    conn = _pg_connect()
    try:
        with conn.cursor() as cur:
            # retailer_account_id lives on user_accounts (M:N), not users — pick the first link.
            cur.execute(
                """
                SELECT rt.user_id::text, rt.expires_at, rt.revoked,
                       (
                         SELECT ua.retailer_account_id::text
                         FROM user_accounts ua
                         WHERE ua.user_id = rt.user_id
                         ORDER BY ua.joined_at ASC
                         LIMIT 1
                       ) AS retailer_account_id,
                       u.role, u.is_active
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

    user_id, expires_at, revoked, retailer_account_id, role, is_active = row
    retailer_account_id = retailer_account_id or ""

    if revoked or not is_active:
        raise HTTPException(status_code=401, detail="Token revoked")

    exp_utc = expires_at if expires_at.tzinfo else expires_at.replace(tzinfo=timezone.utc)
    if exp_utc < datetime.now(timezone.utc):
        raise HTTPException(status_code=401, detail="Refresh token expired")

    # Rotate: revoke old token, issue new pair
    _revoke_refresh_token(token_hash)
    new_access          = _create_access_token(user_id, retailer_account_id, role)
    new_raw, new_hash   = _make_refresh_token()
    _store_refresh_token(user_id, new_hash,
                         datetime.now(timezone.utc) + timedelta(days=_REFRESH_DAYS))

    return {
        "access_token":  new_access,
        "refresh_token": new_raw,
        "token_type":    "bearer",
    }


@app.post(
    "/auth/logout",
    tags=["auth"],
    summary="Revoke the current refresh token",
    description=(
        "Invalidates the provided refresh token so it can no longer be used to obtain new access tokens. "
        "Pass the refresh token in the request body as `{\"refresh_token\": \"...\"}`. "
        "The access token itself cannot be revoked (it expires naturally after 24 hours). "
        "Requires a valid Bearer access token in the Authorization header."
    ),
)
@app.post("/logout", tags=["auth"], include_in_schema=False)
def logout(body: dict, current_user: dict = Depends(get_current_user)):
    """
    Revokes the provided refresh token so it can no longer be used to obtain new access tokens.
    Pass `{"refresh_token": "..."}` in the body.
    The access token itself cannot be revoked — it expires naturally after 24 hours.
    Requires a valid Bearer access token in the Authorization header.
    """
    raw_rt = body.get("refresh_token", "")
    if raw_rt:
        _revoke_refresh_token(hashlib.sha256(raw_rt.encode()).hexdigest())
    return {"status": "ok"}


# ── Run history ───────────────────────────────────────────────────────────────

@app.get(
    "/runs",
    tags=["runs"],
    summary="List simulation runs for the current account",
    description=(
        "Returns the 50 most recent simulation runs for the authenticated user's retailer account, ordered by creation date descending. "
        "Requires a account-scoped token (call `POST /switch-account` first). "
        "Optional query param `scenario_type`: pass `no_scenario` to filter baseline runs only, "
        "or any other value (e.g. `promo_forecast`, `hidden_lost_sales`) to filter by scenario type. "
        "Each run includes status, date range, seed, granularity, and whether it has been extended."
    ),
)
def get_runs(
    current_user: dict = Depends(get_current_user),
    scenario_type: str | None = None,
):
    """
    Returns the 50 most recent simulation runs for the authenticated user's retailer account, newest first.
    Requires an account-scoped token (call `POST /switch-account` first).

    **Optional query param `scenario_type`:**
    - Omit → return all runs
    - `no_scenario` → baseline runs only (no scenario applied)
    - Any other value (e.g. `promo_forecast`, `hidden_lost_sales`) → filter by that scenario type

    Each run includes: status, date range, seed, granularity, scenario type, and extension info.
    """
    retailer_account_id = current_user.get("retailer_account_id") or ""
    user_id             = current_user["user_id"]
    if not POSTGRES_DSN or not retailer_account_id:
        return []

    if scenario_type == "no_scenario":
        scenario_filter = "AND scenario_type IS NULL"
        scenario_params: tuple = ()
    elif scenario_type:
        scenario_filter = "AND scenario_type = %s"
        scenario_params = (scenario_type,)
    else:
        scenario_filter = ""
        scenario_params = ()

    conn = _pg_connect()
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                SELECT simulation_id::text, simulation_name, simulation_status,
                       created_at, start_week, end_week, random_seed, notes,
                       COALESCE(simulation_granularity, 'weekly') AS simulation_granularity,
                       COALESCE(scenario_type, 'no_scenario') AS scenario_type,
                       COALESCE(is_extended, FALSE) AS is_extended,
                       COALESCE(extension_count, 0) AS extension_count
                FROM simulation_config
                WHERE retailer_account_id = %s AND user_id = %s AND parent_simulation_id IS NULL {scenario_filter}
                ORDER BY created_at DESC
                LIMIT 50
                """,
                (retailer_account_id, user_id) + scenario_params,
            )
            cols = [d[0] for d in cur.description]
            rows = [dict(zip(cols, row)) for row in cur.fetchall()]
            for row in rows:
                for k, v in row.items():
                    if hasattr(v, "isoformat"):
                        row[k] = v.isoformat()
            logger.info("GET /runs — user=%s account=%s scenario=%s returned %d runs",
                        user_id, retailer_account_id, scenario_type, len(rows))
            return rows
    finally:
        conn.close()


# ── Entity catalogue ──────────────────────────────────────────────────────────

def _resolve_data_account(cur, retailer_account_id: str) -> str | None:
    """Return retailer_account_id to use for catalog data. Falls back to demo account
    if this account has no items, or if no retailer_account_id is set on the JWT yet
    (e.g. fresh login before /switch-account)."""
    if retailer_account_id:
        cur.execute("SELECT 1 FROM items WHERE retailer_account_id = %s LIMIT 1", (retailer_account_id,))
        if cur.fetchone():
            return retailer_account_id
    cur.execute("SELECT retailer_account_id::text FROM items LIMIT 1")
    row = cur.fetchone()
    return row[0] if row else None


@app.get(
    "/entities",
    tags=["entities"],
    summary="Fetch all reference entities for the current account",
    description=(
        "Returns the full catalogue of items, stores, distribution centres, and suppliers for the authenticated retailer account. "
        "Used by the UI to populate dropdowns, filters, and entity pickers throughout the simulation and analytics views. "
        "If the account has no items yet, falls back to the demo account's catalogue automatically. "
        "Requires an account-scoped token."
    ),
)
def get_entities(current_user: dict = Depends(get_current_user)):
    """
    Returns the full reference catalogue for the authenticated retailer account:
    **items**, **stores**, **distribution centres (DCs)**, and **suppliers**.

    Used by the UI to populate dropdowns, filters, and entity pickers throughout
    simulation setup and analytics views.
    If the account has no items yet, automatically falls back to the demo account's catalogue.
    Requires an account-scoped token.
    """
    retailer_account_id = current_user["retailer_account_id"]
    if not POSTGRES_DSN:
        raise HTTPException(status_code=503, detail="No POSTGRES_DSN configured")
    conn = _pg_connect()
    try:
        with conn.cursor() as cur:
            data_acct = _resolve_data_account(cur, retailer_account_id)

            def q(sql, params):
                cur.execute(sql, params)
                cols = [d[0] for d in cur.description]
                return [dict(zip(cols, r)) for r in cur.fetchall()]

            acct = (data_acct,)
            return {
                "items":     q("SELECT item_id::text, item_code, item_description FROM items WHERE retailer_account_id = %s ORDER BY item_code", acct),
                "stores":    q("SELECT store_id::text, store_code, store_name FROM stores WHERE retailer_account_id = %s ORDER BY store_code", acct),
                "dcs":       q("SELECT dc_id::text, dc_code, dc_name, COALESCE(dc_role, 'RETAILER_DC') AS dc_role FROM distribution_centers WHERE retailer_account_id = %s ORDER BY dc_code", acct),
                "suppliers": q("SELECT supplier_id::text, supplier_code, supplier_name FROM suppliers WHERE retailer_account_id = %s ORDER BY supplier_code", acct),
            }
    finally:
        conn.close()


# ── Run YAML template ────────────────────────────────────────────────────────

@app.get(
    "/run-yaml-template",
    tags=["runs"],
    summary="Generate a pre-filled simulation YAML config",
    description=(
        "Returns a YAML string pre-populated with the retailer account's actual DCs and suppliers from the database. "
        "Use this as the starting point for the simulation config editor — paste it into the New Simulation form. "
        "All WoS (weeks-of-supply) and lead-week parameters are customisable via query params and will be reflected in the generated YAML. "
        "Query params: `store_target_wos` (default 2), `store_initial_wos` (default 2), `retailer_dc_target_wos` (default 4), "
        "`retailer_dc_initial_wos` (default 4), `supplier_dc_initial_wos` (default 4), "
        "`retailer_dc_to_store_lead_weeks` (default 1), `supplier_dc_to_retailer_dc_lead_weeks` (default 1), "
        "`dc_otd_rate` (default 0.95), `dc_in_full_rate` (default 0.95), `supplier_otd_rate` (default 0.95), `supplier_in_full_rate` (default 0.95). "
        "Requires an account-scoped token."
    ),
)
def get_run_yaml_template(
    current_user: dict = Depends(get_current_user),
    store_target_wos: int = 2,
    store_initial_wos: int = 2,
    retailer_dc_target_wos: int = 4,
    retailer_dc_initial_wos: int = 4,
    supplier_dc_initial_wos: int = 4,
    retailer_dc_to_store_lead_weeks: int = 1,
    supplier_dc_to_retailer_dc_lead_weeks: int = 1,
    dc_otd_rate: float = 0.95,
    dc_in_full_rate: float = 0.95,
    supplier_otd_rate: float = 0.95,
    supplier_in_full_rate: float = 0.95,
):
    """Pre-filled YAML template using the retailer's actual DCs and suppliers."""
    import yaml as _yaml

    retailer_account_id = current_user["retailer_account_id"]
    if not POSTGRES_DSN:
        raise HTTPException(status_code=503, detail="No POSTGRES_DSN configured")

    dcs: list[str] = []
    suppliers: list[str] = []
    if retailer_account_id:
        conn = _pg_connect()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT dc_code FROM distribution_centers "
                    "WHERE retailer_account_id = %s AND COALESCE(dc_type, '') != 'SUPPLIER' ORDER BY dc_code",
                    (retailer_account_id,),
                )
                dcs = [r[0] for r in cur.fetchall()]

                cur.execute(
                    "SELECT supplier_code FROM suppliers WHERE retailer_account_id = %s ORDER BY supplier_code",
                    (retailer_account_id,),
                )
                suppliers = [r[0] for r in cur.fetchall()]
        finally:
            conn.close()

    template: dict = {
        "run": {
            "retailer_account_id":                    retailer_account_id,
            "simulation_name":                        "New Simulation Run",
            "notes":                                  "",
            "start_date":                             "2024-01-01",
            "end_date":                               "2024-12-31",
            "seed":                                   42,
            "store_target_wos":                       store_target_wos,
            "store_initial_wos":                      store_initial_wos,
            "retailer_dc_target_wos":                 retailer_dc_target_wos,
            "retailer_dc_initial_wos":                retailer_dc_initial_wos,
            "supplier_dc_initial_wos":                supplier_dc_initial_wos,
            "supplier_dc_to_retailer_dc_lead_weeks":  supplier_dc_to_retailer_dc_lead_weeks,
            "retailer_dc_to_store_lead_weeks":        retailer_dc_to_store_lead_weeks,
            "supplier_otd_rate":                      supplier_otd_rate,
            "supplier_in_full_rate":                  supplier_in_full_rate,
            "dc_otd_rate":                            dc_otd_rate,
            "dc_in_full_rate":                        dc_in_full_rate,
        }
    }

    if dcs:
        template["run"]["dcs"] = {
            dc: {
                "otd_rate":            dc_otd_rate,
                "in_full_rate":        dc_in_full_rate,
                "lead_weeks_to_store": retailer_dc_to_store_lead_weeks,
                "target_wos":          retailer_dc_target_wos,
                "initial_wos":         retailer_dc_initial_wos,
            }
            for dc in dcs
        }

    if suppliers:
        template["run"]["suppliers"] = {
            sup: {
                "otd_rate":     supplier_otd_rate,
                "in_full_rate": supplier_in_full_rate,
                "lead_weeks":   supplier_dc_to_retailer_dc_lead_weeks,
                "initial_wos":  supplier_dc_initial_wos,
            }
            for sup in suppliers
        }

    return {"yaml": _yaml.dump(template, default_flow_style=False, sort_keys=False, allow_unicode=True)}


# ── Network mappings ──────────────────────────────────────────────────────────

@app.get(
    "/mappings",
    tags=["entities"],
    summary="Get supply-chain network mappings",
    description=(
        "Returns the network topology for the retailer account: which stores are served by which DCs, "
        "which DCs are served by which supplier DCs, and which suppliers supply which items. "
        "These mappings define how inventory flows through the supply chain during simulation. "
        "Requires an account-scoped token."
    ),
)
def get_mappings(current_user: dict = Depends(get_current_user)):
    """
    Returns the supply-chain network topology for the retailer account:
    which stores are served by which DCs, which DCs are served by which supplier DCs,
    and which suppliers supply which items.
    These mappings define how inventory flows through the supply chain during a simulation run.
    Requires an account-scoped token.
    """
    retailer_account_id = current_user["retailer_account_id"]
    if not POSTGRES_DSN:
        raise HTTPException(status_code=503, detail="No POSTGRES_DSN configured")
    conn = _pg_connect()
    try:
        with conn.cursor() as cur:
            data_acct = _resolve_data_account(cur, retailer_account_id)

            def q(sql, params):
                cur.execute(sql, params)
                cols = [d[0] for d in cur.description]
                return [dict(zip(cols, r)) for r in cur.fetchall()]

            acct = (data_acct,)
            return {
                "store_items":    q("SELECT si.store_id::text, si.item_id::text FROM store_items si JOIN stores s ON si.store_id = s.store_id WHERE s.retailer_account_id = %s", acct),
                "dc_items":       q("SELECT di.dc_id::text, di.item_id::text FROM dc_items di JOIN distribution_centers dc ON di.dc_id = dc.dc_id WHERE dc.retailer_account_id = %s", acct),
                "supplier_items": q("SELECT si.supplier_id::text, si.item_id::text FROM supplier_items si JOIN suppliers s ON si.supplier_id = s.supplier_id WHERE s.retailer_account_id = %s", acct),
                "store_mappings": q("SELECT sm.from_store_id::text, sm.to_dc_id::text, sm.mapping_type FROM store_mappings sm JOIN stores s ON sm.from_store_id = s.store_id WHERE s.retailer_account_id = %s", acct),
                "dc_mappings":    q("SELECT dm.from_dc_id::text, dm.to_node_id::text, dm.mapping_type FROM dc_mappings dm JOIN distribution_centers dc ON dm.from_dc_id = dc.dc_id WHERE dc.retailer_account_id = %s", acct),
            }
    finally:
        conn.close()


@app.post(
    "/mappings",
    tags=["entities"],
    summary="Save supply-chain network mappings",
    description=(
        "Bulk-saves the network topology for the retailer account in a single transaction. "
        "Accepts store-to-DC mappings (`store_mappings`), DC-to-DC mappings (`dc_mappings`), "
        "item-to-supplier links (`supplier_items`), and item-to-store links (`store_items`). "
        "All existing mappings for the account are replaced by the new set. "
        "Requires an account-scoped token."
    ),
)
def save_mappings(body: dict, current_user: dict = Depends(get_current_user)):
    """
    Bulk-saves the supply-chain network topology for the retailer account in a single transaction.
    Accepts: `store_mappings` (store → DC), `dc_mappings` (DC → DC/supplier DC),
    `supplier_items` (supplier → item links), `store_items` (store → item links).
    All existing mappings for the account are replaced by the new set.
    Requires an account-scoped token.
    """
    retailer_account_id = current_user["retailer_account_id"]   # always from JWT, never from body
    if not POSTGRES_DSN:
        raise HTTPException(status_code=503, detail="No POSTGRES_DSN configured")
    conn = _pg_connect()
    try:
        with conn.cursor() as cur:
            acct = (retailer_account_id,)
            cur.execute("DELETE FROM store_items WHERE store_id IN (SELECT store_id FROM stores WHERE retailer_account_id = %s)", acct)
            cur.execute("DELETE FROM dc_items WHERE dc_id IN (SELECT dc_id FROM distribution_centers WHERE retailer_account_id = %s)", acct)
            cur.execute("DELETE FROM supplier_items WHERE supplier_id IN (SELECT supplier_id FROM suppliers WHERE retailer_account_id = %s)", acct)
            cur.execute("DELETE FROM store_mappings WHERE from_store_id IN (SELECT store_id FROM stores WHERE retailer_account_id = %s)", acct)
            cur.execute("DELETE FROM dc_mappings WHERE from_dc_id IN (SELECT dc_id FROM distribution_centers WHERE retailer_account_id = %s)", acct)

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

@app.get(
    "/promos",
    tags=["promos"],
    summary="List all promos for the current account",
    description=(
        "Returns the full promo catalogue for the authenticated retailer account — all promos that are not tied to a specific simulation run. "
        "Each promo includes its name, date range, demand multiplier, promo group, and the list of items it applies to. "
        "These are the base-level promos used when configuring a new simulation or rolling forecast. "
        "Requires an account-scoped token."
    ),
)
def get_promos(current_user: dict = Depends(get_current_user)):
    """
    Returns the full promo catalogue for the authenticated retailer account —
    all promos not tied to a specific simulation run.

    Each promo includes: name, date range, demand multiplier, promo group, and the items it applies to.
    These are the base-level promos used when configuring a new simulation or rolling forecast.
    Requires an account-scoped token.
    """
    retailer_account_id = current_user["retailer_account_id"]
    if not POSTGRES_DSN:
        raise HTTPException(status_code=503, detail="No POSTGRES_DSN configured")
    conn = _pg_connect()
    try:
        with conn.cursor() as cur:
            data_acct = _resolve_data_account(cur, retailer_account_id)
            cur.execute(
                """
                SELECT p.promo_id::text, p.promo_name, p.start_date::text, p.end_date::text,
                       p.demand_multiplier, pg.promo_group_name,
                       array_agg(pgi.item_id::text) AS item_ids
                FROM promos p
                JOIN promo_groups pg ON p.promo_group_id = pg.promo_group_id
                JOIN promo_group_items pgi ON pg.promo_group_id = pgi.promo_group_id
                WHERE p.retailer_account_id = %s AND p.simulation_id IS NULL
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

@app.post(
    "/run",
    tags=["simulation"],
    summary="Trigger a new simulation run (JSON body)",
    description=(
        "Starts a new simulation by proxying the request to the simulation engine. "
        "The `retailer_account_id` and `user_id` are injected automatically from the JWT — do not include them in the body. "
        "Required fields: `simulation_name`, `start_date`, `end_date`, `seed`, and the supply-chain config (stores, DCs, suppliers). "
        "Returns the completed simulation result synchronously — this call may take several seconds for large date ranges. "
        "Requires an account-scoped token."
    ),
)
async def run_simulation(req: dict, current_user: dict = Depends(get_current_user)):
    """
    Starts a new simulation by proxying the request to the simulation engine (JSON body).
    The `retailer_account_id` and `user_id` are injected automatically from the JWT — do not include them in the body.

    **Required fields:** `simulation_name`, `start_date`, `end_date`, `seed`, and supply-chain config (stores, DCs, suppliers).
    Returns the completed simulation result synchronously — may take several seconds for large date ranges.
    Requires an account-scoped token.
    """
    req["retailer_account_id"] = current_user["retailer_account_id"]  # enforce from JWT
    req["user_id"]             = current_user["user_id"]
    account = current_user["retailer_account_id"]
    logger.info("run  account=%s  name=%r  dates=%s→%s  policy=%s",
                account, req.get("simulation_name"), req.get("start_date"), req.get("end_date"),
                req.get("replenishment_policy"))
    try:
        async with httpx.AsyncClient(timeout=300.0) as client:
            resp = await client.post(f"{SIM_ENGINE_URL}/simulate", json=req)
            resp.raise_for_status()
            return resp.json()
    except httpx.ConnectError:
        logger.error("run  account=%s  engine unreachable", account)
        raise HTTPException(status_code=503, detail="Simulation engine is not reachable")
    except httpx.TimeoutException:
        logger.error("run  account=%s  engine timed out", account)
        raise HTTPException(status_code=504, detail="Simulation timed out")
    except httpx.HTTPStatusError as e:
        logger.error("run  account=%s  engine error %d: %s", account, e.response.status_code, e.response.text[:200])
        raise HTTPException(status_code=e.response.status_code, detail=e.response.text)


# ── YAML-based simulation run proxy ──────────────────────────────────────────

@app.post(
    "/run/yaml",
    tags=["simulation"],
    summary="Trigger a new simulation run (YAML body)",
    description=(
        "Same as `POST /run` but accepts a YAML string in `{\"yaml_content\": \"...\"}` format instead of a JSON object. "
        "The `retailer_account_id` is automatically injected into the YAML `run:` block from the JWT before forwarding to the engine — "
        "you do not need to include it in the YAML. "
        "This is the endpoint used by the New Simulation page's YAML editor. "
        "Requires an account-scoped token."
    ),
)
async def run_simulation_yaml(body: dict, current_user: dict = Depends(get_current_user)):
    """
    Accept {"yaml_content": "<yaml string>"}, inject retailer_account_id into
    the run: block at parse time (engine enforces it), and proxy to /simulate/yaml.
    """
    import yaml as _yaml

    account = current_user["retailer_account_id"]
    logger.info("run/yaml  account=%s", account)
    yaml_text = body.get("yaml_content", "")
    # Inject retailer_account_id into the run: block so the engine picks it up
    try:
        raw = _yaml.safe_load(yaml_text)
        if isinstance(raw, dict) and isinstance(raw.get("run"), dict):
            raw["run"]["retailer_account_id"] = current_user["retailer_account_id"]
            raw["run"]["user_id"] = current_user["user_id"]
            yaml_text = _yaml.dump(raw, default_flow_style=False)
    except Exception:
        pass  # engine will surface the YAML error with a clear 422

    try:
        async with httpx.AsyncClient(timeout=300.0) as client:
            resp = await client.post(
                f"{SIM_ENGINE_URL}/simulate",
                json={"yaml_content": yaml_text},
            )
            resp.raise_for_status()
            return resp.json()
    except httpx.ConnectError:
        logger.error("run/yaml  account=%s  engine unreachable", account)
        raise HTTPException(status_code=503, detail="Simulation engine is not reachable")
    except httpx.TimeoutException:
        logger.error("run/yaml  account=%s  engine timed out", account)
        raise HTTPException(status_code=504, detail="Simulation timed out")
    except httpx.HTTPStatusError as e:
        logger.error("run/yaml  account=%s  engine error %d: %s", account, e.response.status_code, e.response.text[:200])
        raise HTTPException(status_code=e.response.status_code, detail=e.response.text)


# ── Scenario validate proxy ───────────────────────────────────────────────────

@app.post(
    "/scenario/validate",
    tags=["simulation"],
    summary="Validate a scenario YAML before running",
    description=(
        "Validates a scenario YAML config (e.g. a `promo_forecast` or `hidden_lost_sales` scenario) "
        "by proxying to the simulation engine's validator. "
        "Use this to catch schema errors in the scenario editor before triggering a full simulation run. "
        "Returns validation errors with line-level detail if the YAML is malformed or references unknown entities. "
        "The `retailer_account_id` is injected from the JWT automatically. "
        "Requires an account-scoped token."
    ),
)
async def validate_scenario(body: dict, current_user: dict = Depends(get_current_user)):
    """
    Validates a scenario YAML config (e.g. `promo_forecast`, `hidden_lost_sales`) by proxying
    to the simulation engine's validator.

    Use this to catch schema errors in the scenario editor **before** triggering a full simulation run.
    Returns validation errors with detail if the YAML is malformed or references unknown entities.
    The `retailer_account_id` is injected from the JWT automatically (with demo-account fallback,
    so freshly registered users without seeded data can still validate against the demo catalogue).
    Requires an account-scoped token.
    """
    # Resolve the data account the same way /promos and /entities do — falls back to
    # the demo account when the user's own account has no items/promos seeded yet.
    # Without this, the engine's ScenarioResolver queries the raw JWT account and
    # reports "Promo not found for this retailer account. Available: []".
    raw_account_id = current_user.get("retailer_account_id") or ""
    if POSTGRES_DSN:
        conn = _pg_connect()
        try:
            with conn.cursor() as cur:
                data_acct = _resolve_data_account(cur, raw_account_id)
        finally:
            conn.close()
        body["retailer_account_id"] = data_acct or raw_account_id
    else:
        body["retailer_account_id"] = raw_account_id
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

@app.get(
    "/simulation/{simulation_id}",
    tags=["simulation"],
    summary="Fetch full simulation output",
    description=(
        "Retrieves the complete simulation result for a given `simulation_id`, proxied from the simulation engine. "
        "Includes all weekly POS, store inventory, DC inventory, supplier DC inventory, and shipment data. "
        "This data is read from ClickHouse and is only available after the background analytics write has completed "
        "(check `GET /analytics/{simulation_id}/status` first if unsure). "
        "Requires an account-scoped token."
    ),
)
async def get_simulation(simulation_id: str, current_user: dict = Depends(get_current_user)):
    """
    Retrieves the complete simulation result for a given run, proxied from the simulation engine.
    Includes all weekly POS, store inventory, DC inventory, supplier DC inventory, and shipment data
    read from ClickHouse.

    Only available after the background analytics write has completed —
    check analytics status first if unsure. Requires an account-scoped token.
    """
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            resp = await client.get(f"{SIM_ENGINE_URL}/simulation/{simulation_id}")
            resp.raise_for_status()
            return resp.json()
    except httpx.ConnectError:
        raise HTTPException(status_code=503, detail="Simulation engine is not reachable")
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=e.response.status_code, detail=e.response.text)


@app.get(
    "/run-config/{simulation_id}",
    tags=["simulation"],
    summary="Fetch the YAML config used for a past run",
    description=(
        "Retrieves the original YAML configuration that was used to create a specific simulation run. "
        "Useful for inspecting what parameters were set, cloning a run with minor tweaks, or debugging unexpected simulation results. "
        "Proxied from the simulation engine. Requires an account-scoped token."
    ),
)
async def get_run_config(simulation_id: str, current_user: dict = Depends(get_current_user)):
    """
    Retrieves the original YAML configuration used to create a specific simulation run.
    Useful for inspecting parameters, cloning a run with minor tweaks, or debugging results.
    Proxied from the simulation engine. Requires an account-scoped token.
    """
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(f"{SIM_ENGINE_URL}/run-config/{simulation_id}")
            resp.raise_for_status()
            return resp.json()
    except httpx.ConnectError:
        raise HTTPException(status_code=503, detail="Simulation engine is not reachable")
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=e.response.status_code, detail=e.response.text)


@app.delete(
    "/simulation/{simulation_id}",
    tags=["simulation"],
    summary="Delete a simulation and all its analytics data",
    description=(
        "Permanently deletes a simulation run and all associated analytics data from both PostgreSQL and ClickHouse. "
        "This action is irreversible — all POS, inventory, and shipment data for this run will be lost. "
        "Proxied to the simulation engine. Requires an account-scoped token."
    ),
)
async def delete_simulation(simulation_id: str, current_user: dict = Depends(get_current_user)):
    """
    Permanently deletes a simulation run and all associated analytics data from both PostgreSQL and ClickHouse.
    **This action is irreversible** — all POS, inventory, and shipment data for this run will be lost.
    Proxied to the simulation engine. Requires an account-scoped token.
    """
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.delete(f"{SIM_ENGINE_URL}/simulation/{simulation_id}")
            resp.raise_for_status()
            return resp.json()
    except httpx.ConnectError:
        raise HTTPException(status_code=503, detail="Simulation engine is not reachable")
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=e.response.status_code, detail=e.response.text)


@app.get(
    "/analytics/{simulation_id}/{path:path}",
    tags=["analytics"],
    summary="Proxy analytics queries to the simulation engine",
    description=(
        "Authenticated wildcard proxy for all analytics read endpoints on the simulation engine. "
        "Any `GET /analytics/{simulation_id}/<sub-path>` request is forwarded to the engine with all query parameters preserved. "
        "Common sub-paths: `summary/weekly-pos`, `summary/store-inventory`, `summary/dc-inventory`, "
        "`detail/store-sales`, `detail/dc-inventory`, `detail/supplier-dc-inventory`. "
        "Use this instead of calling the sim-engine directly when you need authenticated access. "
        "Requires an account-scoped token."
    ),
)
async def proxy_analytics(
    simulation_id: str,
    path: str,
    request: Request,
    current_user: dict = Depends(get_current_user),
):
    """
    Authenticated wildcard proxy for all analytics read endpoints on the simulation engine.
    Any `GET /analytics/{simulation_id}/<sub-path>` is forwarded with all query parameters preserved.

    **Common sub-paths:**
    - `summary/weekly-pos` — aggregated weekly POS across all stores/items
    - `summary/store-inventory` — store-level inventory by week
    - `summary/dc-inventory` — DC-level inventory by week
    - `detail/store-sales` — filterable row-level store sales
    - `detail/dc-inventory` — filterable DC inventory rows
    - `detail/supplier-dc-inventory` — supplier DC inventory rows

    Requires an account-scoped token.
    """
    account = current_user["retailer_account_id"]
    logger.info("analytics  account=%s  sim=%s  path=%s", account, simulation_id[:8], path)
    params = dict(request.query_params)
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.get(
                f"{SIM_ENGINE_URL}/analytics/{simulation_id}/{path}",
                params=params,
            )
            resp.raise_for_status()
            return resp.json()
    except httpx.ConnectError:
        raise HTTPException(status_code=503, detail="Simulation engine is not reachable")
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Analytics request timed out")
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=e.response.status_code, detail=e.response.text)
