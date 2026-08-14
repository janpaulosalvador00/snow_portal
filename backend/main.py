"""snow_portal FastAPI entrypoint."""
from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.lib import db
from backend.routers import admin, auth, connections, consumption, cost


@asynccontextmanager
async def lifespan(_app: FastAPI):
    try:
        db.ensure_bootstrap()
    except Exception:
        # DB may not be ready on first import; health will surface it
        pass
    yield


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
app.include_router(consumption.router)
app.include_router(cost.router)
app.include_router(admin.router)


@app.get("/api/health")
def health():
    try:
        db.ensure_bootstrap()
        return {"status": "ok"}
    except Exception as exc:  # noqa: BLE001
        return {"status": "degraded", "detail": str(exc)}
