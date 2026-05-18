"""
backend/auth.py — crypto and JWT utilities for Metrai authentication.

Password hashing: Argon2id via passlib (OWASP top recommendation).
Tokens: HS256 JWT (access, 15 min) + opaque refresh token (7 days, stored as SHA-256 hash).
"""

import hashlib
import logging
import os
import secrets
from datetime import datetime, timedelta, timezone

import jwt
from passlib.context import CryptContext

_log = logging.getLogger(__name__)

_pwd_ctx = CryptContext(schemes=["argon2"], deprecated="auto")

_JWT_SECRET = os.getenv("JWT_SECRET_KEY", "")
_JWT_ALG    = "HS256"

ACCESS_TTL  = timedelta(minutes=15)
REFRESH_TTL = timedelta(days=7)

if not _JWT_SECRET:
    _log.warning(
        "JWT_SECRET_KEY is not set — using insecure fallback. "
        "Set JWT_SECRET_KEY in .env before deploying to production."
    )
    _JWT_SECRET = "dev-only-insecure-secret-CHANGE-BEFORE-DEPLOY"


def hash_password(plain: str) -> str:
    return _pwd_ctx.hash(plain)


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return _pwd_ctx.verify(plain, hashed)
    except Exception:
        return False


def create_access_token(user_id: str, account_id: str, role: str) -> str:
    now = datetime.now(timezone.utc)
    return jwt.encode(
        {
            "sub":        user_id,
            "account_id": account_id,
            "role":       role,
            "iat":        int(now.timestamp()),
            "exp":        int((now + ACCESS_TTL).timestamp()),
            "type":       "access",
        },
        _JWT_SECRET,
        algorithm=_JWT_ALG,
    )


def create_refresh_token() -> tuple[str, str]:
    """Return (plain_token, sha256_hex).  Only the hash is persisted in the DB."""
    plain  = secrets.token_urlsafe(48)
    hashed = hashlib.sha256(plain.encode()).hexdigest()
    return plain, hashed


def decode_access_token(token: str) -> dict:
    """
    Decode and validate an access token.
    Raises jwt.PyJWTError subclasses on any failure (expired, invalid sig, wrong type).
    """
    payload = jwt.decode(token, _JWT_SECRET, algorithms=[_JWT_ALG])
    if payload.get("type") != "access":
        raise jwt.InvalidTokenError("Not an access token")
    return payload
