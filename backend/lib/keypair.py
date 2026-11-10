"""RSA key-pair (SNOWFLAKE_JWT) secrets: pack, validate and load private keys."""
from __future__ import annotations

import base64
import hashlib
import json

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

MAX_KEY_BYTES = 16 * 1024


def is_encrypted_pem(pem: str) -> bool:
    head = (pem or "")[:200].upper()
    return "ENCRYPTED PRIVATE KEY" in head or "PROC-TYPE: 4,ENCRYPTED" in head


def looks_like_private_key(text: str) -> bool:
    head = (text or "").lstrip()[:200].upper()
    return head.startswith("-----BEGIN") and "PRIVATE KEY" in head


def _normalize_pem(pem: str) -> str:
    value = (pem or "").strip().replace("\r\n", "\n")
    if not value:
        raise ValueError("Chave privada vazia.")
    if len(value.encode("utf-8")) > MAX_KEY_BYTES:
        raise ValueError("Arquivo grande demais para uma chave privada (máx. 16 KB).")
    upper = value[:200].upper()
    if "PUBLIC KEY" in upper and "PRIVATE KEY" not in upper:
        raise ValueError(
            "Este arquivo é a chave pública (.pub). Selecione a chave privada (.p8)."
        )
    if not value.startswith("-----BEGIN"):
        body = "".join(value.split())
        value = "-----BEGIN PRIVATE KEY-----\n" + "\n".join(
            body[i : i + 64] for i in range(0, len(body), 64)
        ) + "\n-----END PRIVATE KEY-----"
    return value + "\n"


def pack_keypair_secret(pem: str, passphrase: str | None = None) -> str:
    """Validate the key and return the JSON blob stored (encrypted) in the DB."""
    normalized = _normalize_pem(pem)
    pw = (passphrase or None) if is_encrypted_pem(normalized) else None
    load_private_key(normalized, pw)
    return json.dumps({"private_key": normalized, "passphrase": pw})


def unpack_keypair_secret(secret: str | None) -> tuple[str, str | None]:
    if not secret:
        raise ValueError("Chave privada ausente. Selecione o arquivo .p8 de novo.")
    raw = secret.strip()
    if raw.startswith("{"):
        data = json.loads(raw)
        pem = data.get("private_key")
        if not pem:
            raise ValueError("Credencial key pair sem chave privada.")
        return pem, data.get("passphrase") or None
    return raw, None


def load_private_key(pem: str, passphrase: str | None = None) -> rsa.RSAPrivateKey:
    encrypted = is_encrypted_pem(pem)
    if encrypted and not passphrase:
        raise ValueError(
            "A chave privada está criptografada. Informe a passphrase."
        )
    password = passphrase.encode("utf-8") if (passphrase and encrypted) else None
    try:
        key = serialization.load_pem_private_key(pem.encode("utf-8"), password=password)
    except TypeError as exc:
        raise ValueError(
            "A chave privada não é criptografada: deixe a passphrase vazia."
            if passphrase
            else "A chave privada está criptografada. Informe a passphrase."
        ) from exc
    except ValueError as exc:
        if encrypted:
            raise ValueError("Passphrase incorreta para esta chave privada.") from exc
        raise ValueError(
            "Arquivo não é uma chave privada PEM válida (esperado -----BEGIN PRIVATE KEY-----)."
        ) from exc
    if not isinstance(key, rsa.RSAPrivateKey):
        raise ValueError("A Snowflake só aceita chaves RSA para key pair.")
    return key


def private_key_der(secret: str) -> bytes:
    """Unencrypted PKCS#8 DER bytes, the format snowflake-connector expects."""
    pem, passphrase = unpack_keypair_secret(secret)
    key = load_private_key(pem, passphrase)
    return key.private_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )


def public_key_fingerprint(secret: str) -> str | None:
    """SHA256 fingerprint in the same format as DESC USER → RSA_PUBLIC_KEY_FP."""
    try:
        pem, passphrase = unpack_keypair_secret(secret)
        public_der = load_private_key(pem, passphrase).public_key().public_bytes(
            encoding=serialization.Encoding.DER,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        )
    except ValueError:
        return None
    return "SHA256:" + base64.b64encode(hashlib.sha256(public_der).digest()).decode("ascii")
