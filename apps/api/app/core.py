from __future__ import annotations

import hashlib
import os
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from functools import lru_cache
from pathlib import Path

from argon2 import PasswordHasher
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker


def utc_now() -> datetime:
    return datetime.now(UTC)


@dataclass(frozen=True)
class Settings:
    database_url: str
    session_cookie_name: str = "xox_session"
    session_ttl_days: int = 14
    cors_origin: str = "http://127.0.0.1:5173"


@lru_cache
def get_settings() -> Settings:
    base_dir = Path(__file__).resolve().parents[1]
    default_db = f"sqlite:///{(base_dir / 'data' / 'xox.db').as_posix()}"
    return Settings(
        database_url=os.getenv("XOX_DATABASE_URL", default_db),
        cors_origin=os.getenv("XOX_CORS_ORIGIN", "http://127.0.0.1:5173"),
    )


def _connect_args(database_url: str) -> dict[str, object]:
    if database_url.startswith("sqlite"):
        return {"check_same_thread": False}
    return {}


def build_session_factory(settings: Settings) -> sessionmaker[Session]:
    if settings.database_url.startswith("sqlite:///"):
        database_path = Path(settings.database_url.removeprefix("sqlite:///"))
        database_path.parent.mkdir(parents=True, exist_ok=True)
    engine = create_engine(settings.database_url, future=True, connect_args=_connect_args(settings.database_url))
    return sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False)


password_hasher = PasswordHasher()


def hash_password(password: str) -> str:
    return password_hasher.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return password_hasher.verify(password_hash, password)
    except Exception:
        return False


def issue_session_token() -> tuple[str, str, datetime]:
    token = secrets.token_urlsafe(48)
    token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
    expires_at = utc_now() + timedelta(days=get_settings().session_ttl_days)
    return token, token_hash, expires_at
