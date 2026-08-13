"""Encrypt / decrypt Snowflake PATs at rest."""
from __future__ import annotations

import base64
import hashlib

from cryptography.fernet import Fernet, InvalidToken

from app.lib.config import get_settings


def _fernet() -> Fernet:
    raw = get_settings()["secret_key"].encode("utf-8")
    digest = hashlib.sha256(raw).digest()
    key = base64.urlsafe_b64encode(digest)
    return Fernet(key)


def encrypt_secret(plaintext: str) -> str:
    return _fernet().encrypt(plaintext.encode("utf-8")).decode("utf-8")


def decrypt_secret(token: str) -> str:
    try:
        return _fernet().decrypt(token.encode("utf-8")).decode("utf-8")
    except InvalidToken as exc:
        raise ValueError("Falha ao descriptografar segredo. Verifique SNOW_PORTAL_SECRET_KEY.") from exc
