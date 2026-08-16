"""Application configuration."""
from __future__ import annotations

import os
from functools import lru_cache

from dotenv import load_dotenv

load_dotenv()


@lru_cache
def get_settings() -> dict:
    return {
        "database_url": os.getenv(
            "DATABASE_URL",
            "postgresql://snow_portal:snow_portal@localhost:5432/snow_portal",
        ),
        "secret_key": os.getenv(
            "SNOW_PORTAL_SECRET_KEY",
            "change-me-to-a-long-random-string-at-least-32-chars",
        ),
        "admin_username": os.getenv("ADMIN_USERNAME", "admin"),
        "admin_password": os.getenv("ADMIN_PASSWORD", "admin123"),
        "session_timeout_hours": int(os.getenv("SESSION_TIMEOUT_HOURS", "12")),
        "oauth_redirect_uri": os.getenv(
            "OAUTH_REDIRECT_URI",
            "http://127.0.0.1:8010",
        ),
        "portal_public_url": os.getenv("PORTAL_PUBLIC_URL", "http://localhost:8501"),
    }
