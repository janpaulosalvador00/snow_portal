"""Smoke tests that do not require Snowflake."""
from __future__ import annotations

import os
import sys

# Ensure project root on path
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from app.lib.crypto import decrypt_secret, encrypt_secret
from app.lib.metering import SERVICE_TYPE_LABELS, _label_service


def test_crypto_roundtrip() -> None:
    os.environ.setdefault(
        "SNOW_PORTAL_SECRET_KEY",
        "test-secret-key-for-unit-tests-32chars",
    )
    from app.lib.config import get_settings

    get_settings.cache_clear()
    token = encrypt_secret("pat-example-value")
    assert token != "pat-example-value"
    assert decrypt_secret(token) == "pat-example-value"
    get_settings.cache_clear()


def test_service_labels() -> None:
    assert _label_service("WAREHOUSE_METERING") == "Warehouse"
    assert "AI_SERVICES" in SERVICE_TYPE_LABELS


if __name__ == "__main__":
    test_crypto_roundtrip()
    test_service_labels()
    print("ok")
