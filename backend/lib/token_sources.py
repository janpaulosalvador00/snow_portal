"""Where a connection secret comes from: saved token, tokens folder or typed/uploaded.

Secrets are resolved server-side only; callers get plaintext to connect/store,
never to return to the browser.
"""
from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path, PurePath

from backend.lib import db, keypair, token_export

SECRET_FILE_EXTENSIONS = (".p8", ".pem", ".key", ".txt", ".token")
MAX_FILE_BYTES = 64 * 1024
_SNIFF_BYTES = 512


def folder_label() -> str:
    return (os.getenv("TOKENS_HOST_DIR") or "").strip() or str(token_export.tokens_dir() or "")


def _is_secret_file_name(name: str) -> bool:
    lower = name.lower()
    return (
        not name.startswith(".")
        and not lower.endswith(".json")
        and lower.endswith(SECRET_FILE_EXTENSIONS)
    )


def _sniff(head: str) -> tuple[str | None, bool]:
    """(kind, encrypted): kind is private_key, token, or None for unusable files."""
    stripped = head.lstrip()
    upper = stripped[:200].upper()
    if keypair.looks_like_private_key(stripped):
        return "private_key", keypair.is_encrypted_pem(stripped)
    if upper.startswith("-----BEGIN"):
        return None, False
    if not stripped.strip():
        return None, False
    return "token", False


def list_folder_files(kind: str | None = None) -> dict:
    """Secret-like files in TOKENS_EXPORT_DIR (name, size, mtime, kind; never content)."""
    folder = token_export.tokens_dir()
    if folder is None:
        return {"available": False, "folder": "", "files": []}
    files: list[dict] = []
    try:
        entries = sorted(folder.iterdir(), key=lambda p: p.name.lower())
    except OSError:
        return {"available": False, "folder": folder_label(), "files": []}
    for entry in entries:
        name = entry.name
        if not _is_secret_file_name(name):
            continue
        try:
            if not entry.is_file():
                continue
            stat = entry.stat()
            if stat.st_size == 0 or stat.st_size > MAX_FILE_BYTES:
                continue
            with entry.open("r", encoding="utf-8", errors="replace") as fh:
                file_kind, encrypted = _sniff(fh.read(_SNIFF_BYTES))
        except OSError:
            continue
        if file_kind is None or (kind and file_kind != kind):
            continue
        files.append(
            {
                "name": name,
                "size": stat.st_size,
                "modified_at": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
                "kind": file_kind,
                "encrypted": encrypted,
            }
        )
    return {"available": True, "folder": folder_label(), "files": files}


def read_folder_file(name: str) -> str:
    folder = token_export.tokens_dir()
    if folder is None:
        raise ValueError("Pasta de tokens não configurada (TOKENS_EXPORT_DIR).")
    raw = (name or "").strip()
    if (
        not raw
        or raw != PurePath(raw).name
        or "/" in raw
        or "\\" in raw
        or not _is_secret_file_name(raw)
    ):
        raise ValueError("Nome de arquivo inválido.")
    base = folder.resolve()
    path = (base / raw).resolve()
    if path.parent != base or not path.is_file():
        raise ValueError(f"Arquivo {raw} não encontrado na pasta de tokens.")
    if path.stat().st_size > MAX_FILE_BYTES:
        raise ValueError(f"Arquivo {raw} é grande demais para um token (máx. 64 KB).")
    try:
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        raise ValueError(f"Não foi possível ler {raw} como texto.") from exc


def _clean_pat(value: str) -> str:
    token = (value or "").strip()
    if not token:
        raise ValueError("Token vazio.")
    if keypair.looks_like_private_key(token):
        raise ValueError(
            "Este conteúdo é uma chave privada RSA. Use o método Key pair (RSA)."
        )
    if any(ch.isspace() for ch in token):
        raise ValueError("O PAT deve ser uma única linha, sem espaços.")
    return token


def _safe_file_name(name: str | None) -> str | None:
    if not name:
        return None
    return Path(str(name).replace("\\", "/")).name[:300] or None


def resolve_secret(
    user: dict,
    method: str,
    *,
    secret: str | None = None,
    secret_source: str | None = None,
    secret_file_name: str | None = None,
    token_id: int | None = None,
    token_file: str | None = None,
    passphrase: str | None = None,
) -> tuple[str | None, dict | None]:
    """Return (plaintext secret, origin) for PAT/password/key pair; passthrough otherwise.

    Raises ValueError (bad input) or PermissionError (token of an inaccessible connection).
    """
    if method not in db.TOKEN_TYPE_FOR_METHOD:
        return secret, None

    if token_id is not None:
        row, value = db.get_saved_token_secret(
            user, int(token_id), token_type=db.TOKEN_TYPE_FOR_METHOD[method]
        )
        return value, {"source": "saved_token", "source_file": row.get("source_file")}

    if token_file:
        if method == "password":
            raise ValueError("Senha não pode vir de arquivo; digite a senha.")
        content = read_folder_file(token_file)
        value = (
            keypair.pack_keypair_secret(content, passphrase)
            if method == "keypair"
            else _clean_pat(content)
        )
        return value, {"source": "folder", "source_file": token_file.strip()}

    if secret is not None and secret.strip():
        if method == "keypair":
            value = keypair.pack_keypair_secret(secret, passphrase)
        elif method == "pat":
            value = _clean_pat(secret)
        else:
            value = secret
        origin = "upload" if secret_source == "upload" else "typed"
        return value, {
            "source": origin,
            "source_file": _safe_file_name(secret_file_name) if origin == "upload" else None,
        }

    return None, None
