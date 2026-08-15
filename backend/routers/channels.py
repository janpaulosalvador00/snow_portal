"""Communication channels — Teams, Slack and Google Chat webhooks."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from backend.lib import db
from backend.security import require_admin

router = APIRouter(prefix="/api/channels", tags=["channels"])

VALID_PROVIDERS = ("teams", "slack", "gchat")
VALID_EVENTS = ("critical", "alert", "monitor", "budget", "inactive")
PROVIDER_HOSTS = {
    "teams": (
        "outlook.office.com",
        "outlook.office365.com",
        "webhook.office.com",
        "logic.azure.com",
        "powerautomate.com",
    ),
    "slack": ("hooks.slack.com",),
    "gchat": ("chat.googleapis.com",),
}


class ChannelCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    provider: str
    webhook: str = Field(min_length=1)
    events: list[str] = Field(min_length=1)
    team_id: int | None = None
    is_active: bool = True


class ChannelUpdate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    provider: str
    webhook: str | None = None
    events: list[str] = Field(min_length=1)
    team_id: int | None = None
    clear_team: bool = False
    is_active: bool = True


class DraftTest(BaseModel):
    name: str = Field(default="Novo canal", min_length=1, max_length=200)
    provider: str
    webhook: str = Field(min_length=1)


def _validate(provider: str, events: list[str] | None = None) -> str:
    value = provider.strip().lower()
    if value not in VALID_PROVIDERS:
        raise HTTPException(status_code=400, detail="Provedor inválido.")
    invalid = set(events or []) - set(VALID_EVENTS)
    if invalid:
        raise HTTPException(status_code=400, detail="Evento inválido.")
    return value


def _validate_webhook(provider: str, webhook: str) -> str:
    value = webhook.strip()
    parsed = urlparse(value)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise HTTPException(status_code=400, detail="Webhook deve ser uma URL HTTPS válida.")
    host = parsed.hostname.lower()
    allowed = PROVIDER_HOSTS[provider]
    if not any(host == suffix or host.endswith(f".{suffix}") for suffix in allowed):
        raise HTTPException(
            status_code=400,
            detail="O domínio do webhook não corresponde ao provedor selecionado.",
        )
    return value


def _destination(provider: str, name: str) -> str:
    if provider == "gchat":
        return f"Espaço {name}"
    slug = "-".join(name.lower().split())
    return f"#{slug}"


def _public_channel(row: dict) -> dict:
    if not row["is_active"]:
        status = "paused"
    elif row.get("last_ok") is False:
        status = "fail"
    else:
        status = "active"
    return {
        "id": row["id"],
        "name": row["name"],
        "provider": row["provider"],
        "destination": row.get("destination"),
        "webhook_masked": "••••••••" if row.get("id") else None,
        "events": list(row.get("events") or []),
        "team_id": row.get("team_id"),
        "team_name": row.get("team_name"),
        "is_active": row["is_active"],
        "status": status,
        "last_delivery_at": row.get("last_delivery_at"),
        "last_ok": row.get("last_ok"),
    }


def _send_webhook(provider: str, webhook: str, channel_name: str) -> None:
    payload = {
        "text": (
            f"Snow Portal · mensagem de teste\n"
            f"Canal: {channel_name}\n"
            f"Enviado em {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}"
        )
    }
    request = Request(
        webhook,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "User-Agent": "SnowPortal/1.0"},
        method="POST",
    )
    try:
        with urlopen(request, timeout=12) as response:  # noqa: S310 - host allowlisted above
            if not 200 <= response.status < 300:
                raise ValueError(f"Webhook respondeu HTTP {response.status}.")
    except HTTPError as exc:
        raise ValueError(f"Webhook respondeu HTTP {exc.code}.") from exc
    except URLError as exc:
        raise ValueError("Não foi possível acessar o webhook.") from exc


@router.get("")
def list_channels(_user: dict = Depends(require_admin)):
    rows = db.list_notification_channels()
    kpis = db.notification_delivery_kpis()
    return {
        "channels": [_public_channel(row) for row in rows],
        "kpis": {
            "active": sum(1 for row in rows if row["is_active"]),
            "total": len(rows),
            "providers": len({row["provider"] for row in rows}),
            **kpis,
        },
    }


@router.post("")
def create_channel(body: ChannelCreate, user: dict = Depends(require_admin)):
    provider = _validate(body.provider, body.events)
    webhook = _validate_webhook(provider, body.webhook)
    channel_id = db.create_notification_channel(
        name=body.name.strip(),
        provider=provider,
        destination=_destination(provider, body.name.strip()),
        webhook=webhook,
        team_id=body.team_id,
        is_active=body.is_active,
        events=body.events,
        created_by=user["id"],
    )
    return {"ok": True, "id": channel_id}


@router.patch("/{channel_id}")
def update_channel(channel_id: int, body: ChannelUpdate, _user: dict = Depends(require_admin)):
    provider = _validate(body.provider, body.events)
    webhook = _validate_webhook(provider, body.webhook) if body.webhook else None
    ok = db.update_notification_channel(
        channel_id,
        name=body.name.strip(),
        provider=provider,
        destination=_destination(provider, body.name.strip()),
        webhook=webhook,
        team_id=body.team_id,
        clear_team=body.clear_team,
        is_active=body.is_active,
        events=body.events,
    )
    if not ok:
        raise HTTPException(status_code=404, detail="Canal não encontrado.")
    return {"ok": True}


@router.post("/test")
def test_draft_channel(body: DraftTest, _user: dict = Depends(require_admin)):
    provider = _validate(body.provider)
    webhook = _validate_webhook(provider, body.webhook)
    try:
        _send_webhook(provider, webhook, body.name.strip())
    except ValueError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {"ok": True, "message": f"Mensagem de teste enviada para {body.name.strip()}."}


@router.post("/{channel_id}/test")
def test_saved_channel(channel_id: int, _user: dict = Depends(require_admin)):
    try:
        row, webhook = db.get_notification_webhook(channel_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    provider = _validate(row["provider"])
    webhook = _validate_webhook(provider, webhook)
    try:
        _send_webhook(provider, webhook, row["name"])
    except ValueError as exc:
        db.record_notification_delivery(
            channel_id,
            event_key="test",
            ok=False,
            detail=str(exc),
        )
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    db.record_notification_delivery(channel_id, event_key="test", ok=True, detail=None)
    return {"ok": True, "message": f"Mensagem de teste enviada para {row['name']}."}
