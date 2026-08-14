"""Cost Management — Consumption from ACCOUNT_USAGE (legacy path; prefer /api/cost/consumption)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query

from backend.lib import cost_queries
from backend.lib import db
from backend.security import get_current_user

router = APIRouter(prefix="/api/consumption", tags=["consumption"])


@router.get("")
def get_consumption(
    connection_id: int = Query(...),
    days: int = Query(28, ge=1, le=365),
    usage_type: str = Query("Compute"),
    service_type: str | None = Query(None),
    grain: str = Query("day"),
    user: dict = Depends(get_current_user),
):
    if not db.user_can_access_connection(user, connection_id):
        raise HTTPException(status_code=403, detail="Sem permissão para esta conexão.")

    try:
        creds = db.get_connection_credentials(connection_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    svc = None if not service_type or service_type == "All" else service_type
    try:
        raw = cost_queries.fetch_consumption_for_creds(
            creds,
            days=days,
            grain=grain if grain in ("day", "month", "hour") else "day",
            service_type=svc,
            usage_type=usage_type,
        )
        return cost_queries.consumption_payload(raw)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=400,
            detail=(
                "Falha ao consultar créditos. Confirme autenticação, role com acesso a "
                f"ACCOUNT_USAGE e warehouse. Detalhe: {exc}"
            ),
        ) from exc
