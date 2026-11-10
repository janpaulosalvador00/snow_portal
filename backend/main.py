"""snow_portal FastAPI entrypoint."""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.lib import db, token_status
from backend.routers import admin, alerts, auth, channels, connections, consumption, cost, tokens
from backend.routers import token_inventory

# App loggers only; the Snowflake connector is too chatty at INFO on the root logger.
_backend_logger = logging.getLogger("backend")
if not _backend_logger.handlers:
    _handler = logging.StreamHandler()
    _handler.setFormatter(logging.Formatter("%(levelname)s:     %(name)s %(message)s"))
    _backend_logger.addHandler(_handler)
    _backend_logger.setLevel(logging.INFO)
    _backend_logger.propagate = False
logger = logging.getLogger("backend.main")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    try:
        db.ensure_bootstrap()
    except Exception:
        # DB may not be ready on first import; health will surface it
        pass
    try:
        logger.info("connection_tokens backfill: %s", db.backfill_connection_tokens())
    except Exception:  # noqa: BLE001
        logger.exception("connection_tokens backfill failed")
    token_status_task = token_status.start_background_loop()
    try:
        yield
    finally:
        await token_status.stop_background_loop(token_status_task)


app = FastAPI(title="Snow Portal", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(connections.router)
app.include_router(tokens.router)
app.include_router(token_inventory.router)
app.include_router(consumption.router)
app.include_router(cost.router)
app.include_router(alerts.router)
app.include_router(admin.router)
app.include_router(channels.router)


@app.get("/api/health")
def health():
    try:
        db.ensure_bootstrap()
        return {"status": "ok"}
    except Exception as exc:  # noqa: BLE001
        return {"status": "degraded", "detail": str(exc)}
