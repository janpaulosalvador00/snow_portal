"""Cost Management API — all tabs (served from the Postgres Snowflake cache)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query

from backend.lib import db
from backend.lib import snowflake_cache as cache
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


def _check_window(start_date: str | None, end_date: str | None) -> None:
    if (start_date and not end_date) or (end_date and not start_date):
        raise HTTPException(
            status_code=400,
            detail="Informe start_date e end_date juntos (YYYY-MM-DD).",
        )


def _cached(connection_id: int, creds: dict, dataset: str, params: dict) -> dict:
    try:
        return cache.cached_fetch(connection_id, dataset, params, creds=creds)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
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
    _check_window(start_date, end_date)
    params = cache.consumption_params(
        days=days,
        start_date=start_date,
        end_date=end_date,
        usage_type=usage_type,
        service_type=service_type,
        resource_name=resource_name,
        grain=grain,
    )
    try:
        return cache.cached_fetch(connection_id, "consumption", params, creds=creds)
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
    _check_window(start_date, end_date)
    return _cached(
        connection_id,
        creds,
        "account_overview",
        cache.window_params(days, start_date, end_date),
    )


@router.get("/anomalies")
def cost_anomalies(
    connection_id: int = Query(...),
    days: int = Query(28, ge=1, le=365),
    start_date: str | None = Query(None, description="YYYY-MM-DD (UTC)"),
    end_date: str | None = Query(None, description="YYYY-MM-DD (UTC)"),
    user: dict = Depends(get_current_user),
):
    creds = _creds(user, connection_id)
    _check_window(start_date, end_date)
    return _cached(
        connection_id, creds, "anomalies", cache.window_params(days, start_date, end_date)
    )


@router.get("/resource-monitors")
def cost_resource_monitors(
    connection_id: int = Query(...),
    user: dict = Depends(get_current_user),
):
    creds = _creds(user, connection_id)
    return _cached(connection_id, creds, "resource_monitors", {})


@router.get("/budgets")
def cost_budgets(
    connection_id: int = Query(...),
    user: dict = Depends(get_current_user),
):
    creds = _creds(user, connection_id)
    return _cached(connection_id, creds, "budgets", {})


@router.get("/organization-overview")
def cost_organization_overview(
    connection_id: int = Query(...),
    days: int = Query(28, ge=1, le=365),
    start_date: str | None = Query(None, description="YYYY-MM-DD (UTC)"),
    end_date: str | None = Query(None, description="YYYY-MM-DD (UTC)"),
    user: dict = Depends(get_current_user),
):
    creds = _creds(user, connection_id)
    _check_window(start_date, end_date)
    return _cached(
        connection_id,
        creds,
        "organization_overview",
        cache.window_params(days, start_date, end_date),
    )


@router.get("/org-accounts")
def cost_org_accounts(
    connection_id: int = Query(...),
    days: int = Query(28, ge=1, le=365),
    start_date: str | None = Query(None, description="YYYY-MM-DD (UTC)"),
    end_date: str | None = Query(None, description="YYYY-MM-DD (UTC)"),
    user: dict = Depends(get_current_user),
):
    """Account names for the Consumption All Accounts filter (ORGANIZATION_USAGE)."""
    creds = _creds(user, connection_id)
    _check_window(start_date, end_date)
    return _cached(
        connection_id, creds, "org_accounts", cache.window_params(days, start_date, end_date)
    )


@router.get("/org-consumption")
def cost_org_consumption(
    connection_id: int = Query(...),
    days: int = Query(28, ge=1, le=365),
    start_date: str | None = Query(None, description="YYYY-MM-DD (UTC)"),
    end_date: str | None = Query(None, description="YYYY-MM-DD (UTC)"),
    account_name: str | None = Query(
        None, description="Snowflake ACCOUNT_NAME; omit or All for all accounts"
    ),
    service_type: str | None = Query(None, description="SERVICE_TYPE; omit or All for all"),
    usage_type: str = Query("Compute"),
    user: dict = Depends(get_current_user),
):
    """Consumption stacked by service, resource or account (see ``stack_by``)."""
    creds = _creds(user, connection_id)
    _check_window(start_date, end_date)
    return _cached(
        connection_id,
        creds,
        "org_consumption",
        cache.org_consumption_params(
            days=days,
            start_date=start_date,
            end_date=end_date,
            account_name=account_name,
            service_type=service_type,
            usage_type=usage_type,
        ),
    )


@router.get("/service-types")
def cost_service_types(
    connection_id: int = Query(...),
    user: dict = Depends(get_current_user),
):
    """Full Service Type catalog, flagging services that consumed in the last 365 days."""
    creds = _creds(user, connection_id)
    return _cached(connection_id, creds, "service_types", {})
