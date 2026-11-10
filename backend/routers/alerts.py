"""Cross-account Resource Monitor aggregation for the Alerts page."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query

from backend.lib import db, snowflake_cache
from backend.security import get_current_user

router = APIRouter(prefix="/api/alerts", tags=["alerts"])


def _disabled_client(connection: dict, detail: str) -> dict:
    return {
        "id": connection["id"],
        "name": connection["name"],
        "account_identifier": connection["account_identifier"],
        "status": "disabled",
        "error": detail,
        "note": None,
        "monitors": [],
        "max_quota_used_pct": None,
    }


def _fetch_client(connection: dict, credentials: dict, force: bool = False) -> dict:
    payload = snowflake_cache.cached_fetch(
        connection["id"], "resource_monitors", {}, creds=credentials, force=force
    )
    monitors = payload.get("items") or []
    note = payload.get("note")

    # _run_show intentionally degrades Snowflake failures to a note. Alerts needs
    # to surface those accounts as not monitored instead of silently calling them healthy.
    if note and not monitors and str(note).startswith("Sem acesso"):
        return _disabled_client(connection, str(note))

    percentages = [
        float(item["quota_used_pct"])
        for item in monitors
        if item.get("quota_used_pct") is not None
    ]
    monitors.sort(
        key=lambda item: (
            item.get("quota_used_pct") is not None,
            float(item.get("quota_used_pct") or 0),
        ),
        reverse=True,
    )
    return {
        "id": connection["id"],
        "name": connection["name"],
        "account_identifier": connection["account_identifier"],
        "status": "active",
        "error": None,
        "note": note,
        "monitors": monitors,
        "max_quota_used_pct": max(percentages) if percentages else 0,
        "fetched_at": payload.get("fetched_at"),
    }


@router.get("")
def alerts_resource_monitors(
    connection_id: list[int] | None = Query(None),
    refresh_id: list[int] | None = Query(None),
    user: dict = Depends(get_current_user),
):
    """Serve each account from the cache; ``refresh_id`` forces Snowflake for those ids."""
    force_ids = set(refresh_id or [])
    accessible = db.list_connections_for_user(user)
    if connection_id:
        requested = set(connection_id)
        accessible_ids = {row["id"] for row in accessible}
        if not requested.issubset(accessible_ids):
            raise HTTPException(status_code=403, detail="Sem permissão para uma das conexões.")
        connections = [row for row in accessible if row["id"] in requested]
    else:
        connections = accessible

    clients_by_id: dict[int, dict] = {}
    jobs: list[tuple[dict, dict]] = []
    for connection in connections:
        try:
            jobs.append((connection, db.get_connection_credentials(connection["id"])))
        except Exception as exc:  # noqa: BLE001
            clients_by_id[connection["id"]] = _disabled_client(connection, str(exc))

    if jobs:
        with ThreadPoolExecutor(max_workers=min(8, len(jobs))) as executor:
            futures = {
                executor.submit(
                    _fetch_client, connection, credentials, connection["id"] in force_ids
                ): connection
                for connection, credentials in jobs
            }
            for future in as_completed(futures):
                connection = futures[future]
                try:
                    clients_by_id[connection["id"]] = future.result()
                except Exception as exc:  # noqa: BLE001
                    clients_by_id[connection["id"]] = _disabled_client(connection, str(exc))

    clients = [clients_by_id[row["id"]] for row in connections]
    clients.sort(
        key=lambda client: (
            client["status"] == "active",
            float(client.get("max_quota_used_pct") or 0),
        ),
        reverse=True,
    )
    active = sum(client["status"] == "active" for client in clients)
    disabled = len(clients) - active
    critical = sum(
        client["status"] == "active"
        and float(client.get("max_quota_used_pct") or 0) >= 70
        for client in clients
    )
    return {
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "total_connections": len(clients),
        "active_connections": active,
        "disabled_accounts": disabled,
        "critical_clients": critical,
        "clients": clients,
    }
