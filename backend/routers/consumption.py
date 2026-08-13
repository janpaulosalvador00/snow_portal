"""Cost Management — Consumption from ACCOUNT_USAGE."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query

from backend.lib import db
from backend.lib.metering import chart_frame, fetch_consumption, summarize_by_resource
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
        raw = fetch_consumption(
            account=creds["account"],
            user=creds["user"],
            auth_method=creds["auth_method"],
            password=creds.get("password"),
            authenticator_url=creds.get("authenticator_url"),
            days=days,
            grain=grain if grain in ("day", "month", "hour") else "day",
            service_type=svc,
            usage_type=usage_type,
            warehouse=creds.get("warehouse"),
            role=creds.get("role"),
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=400,
            detail=(
                "Falha ao consultar créditos. Confirme autenticação, role com acesso a "
                f"ACCOUNT_USAGE e warehouse. Detalhe: {exc}"
            ),
        ) from exc

    if raw.empty:
        return {
            "total_credits": 0,
            "summary": [],
            "chart": [],
        }

    summary = summarize_by_resource(raw)
    chart = chart_frame(raw)
    total = float(summary["credits_used"].sum())

    # Limit chart legend
    top = summary.head(12)["resource_name"].tolist()
    if top:
        chart = chart[chart["resource_name"].isin(top)]

    def _row_summary(r):
        return {
            "name": r["resource_name"],
            "type": r["type_label"],
            "tags": r["tags"],
            "credits_used": float(r["credits_used"]),
        }

    def _row_chart(r):
        period = r["period_start"]
        return {
            "period_start": period.isoformat() if hasattr(period, "isoformat") else str(period),
            "resource_name": r["resource_name"],
            "credits": float(r["credits_display"]),
        }

    return {
        "total_credits": total,
        "summary": [_row_summary(r) for _, r in summary.iterrows()],
        "chart": [_row_chart(r) for _, r in chart.iterrows()],
    }
