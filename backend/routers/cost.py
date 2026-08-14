"""Cost Management API — all tabs."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query

from backend.lib import db
from backend.lib import cost_queries
from backend.lib.snowflake_client import friendly_connect_error
from backend.security import get_current_user

router = APIRouter(prefix="/api/cost", tags=["cost"])


def _creds(user: dict, connection_id: int) -> dict:
    if not db.user_can_access_connection(user, connection_id):
        raise HTTPException(status_code=403, detail="Sem permissão para esta conexão.")
    try:
        return db.get_connection_credentials(connection_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/consumption")
def cost_consumption(
    connection_id: int = Query(...),
    days: int = Query(28, ge=1, le=365),
    usage_type: str = Query("Compute"),
    service_type: str | None = Query(None),
    resource_name: str | None = Query(None),
    grain: str = Query("day"),
    start_date: str | None = Query(None, description="YYYY-MM-DD (UTC)"),
    end_date: str | None = Query(None, description="YYYY-MM-DD (UTC)"),
    user: dict = Depends(get_current_user),
):
    creds = _creds(user, connection_id)
    svc = None if not service_type or service_type == "All" else service_type
    res = None if not resource_name or resource_name == "All" else resource_name
    if (start_date and not end_date) or (end_date and not start_date):
        raise HTTPException(
            status_code=400,
            detail="Informe start_date e end_date juntos (YYYY-MM-DD).",
        )
    try:
        raw = cost_queries.fetch_consumption_for_creds(
            creds,
            days=days,
            grain=grain if grain in ("day", "month", "hour") else "day",
            service_type=svc,
            usage_type=usage_type,
            resource_name=res,
            start_date=start_date,
            end_date=end_date,
        )
        return cost_queries.consumption_payload(raw)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        detail = friendly_connect_error(exc, auth_method=creds.get("auth_method"))
        raise HTTPException(
            status_code=400,
            detail=(
                "Falha ao consultar créditos. Confirme autenticação, role com acesso a "
                f"ACCOUNT_USAGE e warehouse. Detalhe: {detail}"
            ),
        ) from exc


@router.get("/account-overview")
def cost_account_overview(
    connection_id: int = Query(...),
    days: int = Query(28, ge=1, le=365),
    start_date: str | None = Query(None, description="YYYY-MM-DD (UTC)"),
    end_date: str | None = Query(None, description="YYYY-MM-DD (UTC)"),
    user: dict = Depends(get_current_user),
):
    creds = _creds(user, connection_id)
    if (start_date and not end_date) or (end_date and not start_date):
        raise HTTPException(
            status_code=400,
            detail="Informe start_date e end_date juntos (YYYY-MM-DD).",
        )
    try:
        return cost_queries.account_overview(
            creds, days=days, start_date=start_date, end_date=end_date
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/anomalies")
def cost_anomalies(
    connection_id: int = Query(...),
    days: int = Query(28, ge=1, le=365),
    start_date: str | None = Query(None, description="YYYY-MM-DD (UTC)"),
    end_date: str | None = Query(None, description="YYYY-MM-DD (UTC)"),
    user: dict = Depends(get_current_user),
):
    creds = _creds(user, connection_id)
    if (start_date and not end_date) or (end_date and not start_date):
        raise HTTPException(
            status_code=400,
            detail="Informe start_date e end_date juntos (YYYY-MM-DD).",
        )
    try:
        return cost_queries.anomalies(
            creds, days=days, start_date=start_date, end_date=end_date
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/resource-monitors")
def cost_resource_monitors(
    connection_id: int = Query(...),
    user: dict = Depends(get_current_user),
):
    creds = _creds(user, connection_id)
    try:
        return cost_queries.resource_monitors(creds)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/budgets")
def cost_budgets(
    connection_id: int = Query(...),
    user: dict = Depends(get_current_user),
):
    creds = _creds(user, connection_id)
    try:
        return cost_queries.budgets(creds)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/organization-overview")
def cost_organization_overview(
    connection_id: int = Query(...),
    days: int = Query(28, ge=1, le=365),
    start_date: str | None = Query(None, description="YYYY-MM-DD (UTC)"),
    end_date: str | None = Query(None, description="YYYY-MM-DD (UTC)"),
    user: dict = Depends(get_current_user),
):
    creds = _creds(user, connection_id)
    if (start_date and not end_date) or (end_date and not start_date):
        raise HTTPException(
            status_code=400,
            detail="Informe start_date e end_date juntos (YYYY-MM-DD).",
        )
    try:
        return cost_queries.organization_overview(
            creds, days=days, start_date=start_date, end_date=end_date
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(exc)) from exc
