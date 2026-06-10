import hashlib
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
logger = logging.getLogger("metrai.backend")

import jwt
import psycopg2
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

load_dotenv()

POSTGRES_DSN = os.getenv("POSTGRES_DSN")
JWT_SECRET   = os.getenv("JWT_SECRET", "dev-secret-change-in-production")

JWT_ALGORITHM   = "HS256"
_ACCESS_MINUTES = 15
_REFRESH_DAYS   = 7
_RATE_WINDOW    = 900   # seconds (15 min)
_RATE_MAX       = 5     # failed attempts before lockout

DUMMY_USER_ID = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"

app = FastAPI(
    title="Metrai App Backend",
    version="0.2.0",
    openapi_tags=[
        {"name": "auth", "description": "Registration, login, token refresh and logout"},
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


# ── Auth helpers ──────────────────────────────────────────────────────────────

_ph     = PasswordHasher()
_bearer = HTTPBearer(auto_error=False)
_rate:  dict[str, list[float]] = defaultdict(list)


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


# ── Bootstrap ─────────────────────────────────────────────────────────────────

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


# ── Auth endpoints ────────────────────────────────────────────────────────────

@app.post("/register", tags=["auth"])
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


@app.post("/login", tags=["auth"])
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

    access_token    = _create_access_token(user_id, "", role)
    raw_rt, rt_hash = _make_refresh_token()
    expires_at      = datetime.now(timezone.utc) + timedelta(days=_REFRESH_DAYS)
    _store_refresh_token(user_id, rt_hash, expires_at)

    return {
        "access_token":        access_token,
        "refresh_token":       raw_rt,
        "token_type":          "bearer",
        "user_id":             user_id,
        "retailer_account_id": None,
        "full_name":           full_name or "User",
    }


@app.post("/refresh", tags=["auth"])
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
                       u.retailer_account_id::text, u.role, u.is_active
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

    if revoked or not is_active:
        raise HTTPException(status_code=401, detail="Token revoked")

    exp_utc = expires_at if expires_at.tzinfo else expires_at.replace(tzinfo=timezone.utc)
    if exp_utc < datetime.now(timezone.utc):
        raise HTTPException(status_code=401, detail="Refresh token expired")

    # Rotate: revoke old token, issue new pair
    _revoke_refresh_token(token_hash)
    new_access        = _create_access_token(user_id, retailer_account_id, role)
    new_raw, new_hash = _make_refresh_token()
    _store_refresh_token(user_id, new_hash,
                         datetime.now(timezone.utc) + timedelta(days=_REFRESH_DAYS))

    return {
        "access_token":  new_access,
        "refresh_token": new_raw,
        "token_type":    "bearer",
    }


@app.post("/logout", tags=["auth"])
def logout(body: dict, current_user: dict = Depends(get_current_user)):
    raw_rt = body.get("refresh_token", "")
    if raw_rt:
        _revoke_refresh_token(hashlib.sha256(raw_rt.encode()).hexdigest())
    return {"status": "ok"}
