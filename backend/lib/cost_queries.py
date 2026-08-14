"""Cost Management queries beyond Consumption (Account Overview, Anomalies, etc.)."""
from __future__ import annotations

from typing import Any

import pandas as pd

from backend.lib.metering import (
    chart_frame,
    fetch_consumption,
    summarize_by_resource,
)
from backend.lib.snowflake_client import (
    friendly_connect_error,
    run_query_with_creds,
    snowflake_connection,
)


def _creds_kwargs(creds: dict) -> dict:
    return {
        "account": creds["account"],
        "user": creds["user"],
        "auth_method": creds.get("auth_method", "pat"),
        "password": creds.get("password"),
        "authenticator_url": creds.get("authenticator_url"),
        "warehouse": creds.get("warehouse"),
        "role": creds.get("role"),
    }


def fetch_consumption_for_creds(
    creds: dict,
    *,
    days: int = 28,
    grain: str = "day",
    service_type: str | None = None,
    usage_type: str = "Compute",
) -> pd.DataFrame:
    """Consumption with OAuth refresh path via run_query_with_creds."""
    from backend.lib.metering import _consumption_sql

    if grain not in ("day", "month", "hour"):
        grain = "day"
    days = int(days)
    df = run_query_with_creds(
        creds,
        _consumption_sql(grain),
        (-days, service_type, service_type, None, None),
    )
    if df.empty:
        return df
    df.columns = [c.lower() for c in df.columns]
    from backend.lib.metering import _label_service

    df["type_label"] = df["service_type"].map(_label_service)
    df["tags"] = "—"
    if usage_type == "Compute":
        df["credits_display"] = df["credits_compute"].fillna(0)
    elif usage_type == "Cloud Services":
        df["credits_display"] = df["credits_cloud"].fillna(0)
    else:
        df["credits_display"] = df["credits_used"].fillna(0)
    return df


def consumption_payload(df: pd.DataFrame) -> dict[str, Any]:
    if df.empty:
        return {"total_credits": 0, "summary": [], "chart": []}
    summary = summarize_by_resource(df)
    chart = chart_frame(df)
    total = float(summary["credits_used"].sum())
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


def account_overview(creds: dict, *, days: int = 28) -> dict[str, Any]:
    df = fetch_consumption_for_creds(creds, days=days, grain="day", usage_type="All")
    total = float(df["credits_display"].sum()) if not df.empty else 0.0
    by_service: list[dict] = []
    if not df.empty:
        g = (
            df.groupby("type_label", dropna=False)["credits_display"]
            .sum()
            .reset_index()
            .sort_values("credits_display", ascending=False)
        )
        by_service = [
            {"label": r["type_label"], "credits": float(r["credits_display"])}
            for _, r in g.iterrows()
        ]

    storage_tb = None
    storage_note = None
    try:
        storage = run_query_with_creds(
            creds,
            """
            SELECT AVERAGE_DATABASE_BYTES, AVERAGE_FAILSAFE_BYTES, AVERAGE_STAGE_BYTES
            FROM SNOWFLAKE.ACCOUNT_USAGE.STORAGE_USAGE
            ORDER BY USAGE_DATE DESC
            LIMIT 1
            """,
        )
        if not storage.empty:
            storage.columns = [c.lower() for c in storage.columns]
            row = storage.iloc[0]
            bytes_total = float(
                (row.get("average_database_bytes") or 0)
                + (row.get("average_failsafe_bytes") or 0)
                + (row.get("average_stage_bytes") or 0)
            )
            storage_tb = bytes_total / (1024**4)
    except Exception as exc:  # noqa: BLE001
        storage_note = friendly_connect_error(exc, auth_method=creds.get("auth_method"))

    return {
        "days": days,
        "total_credits": total,
        "by_service": by_service,
        "storage_tb": storage_tb,
        "storage_note": storage_note,
    }


def anomalies(creds: dict, *, days: int = 28) -> dict[str, Any]:
    df = fetch_consumption_for_creds(creds, days=days, grain="day", usage_type="All")
    if df.empty:
        return {"items": [], "note": "Sem dados de metering no período."}

    daily = (
        df.groupby(["period_start", "resource_name"], dropna=False)["credits_display"]
        .sum()
        .reset_index()
    )
    items: list[dict] = []
    for name, grp in daily.groupby("resource_name"):
        series = grp["credits_display"].astype(float)
        if len(series) < 3:
            continue
        mean = float(series.mean())
        std = float(series.std(ddof=0)) or 0.0
        latest = float(series.iloc[-1])
        if mean <= 0:
            continue
        pct = ((latest - mean) / mean) * 100
        z = (latest - mean) / std if std > 0 else 0.0
        if abs(pct) < 50 and abs(z) < 2:
            continue
        items.append(
            {
                "resource_name": name,
                "latest_credits": latest,
                "avg_credits": mean,
                "pct_vs_avg": pct,
                "z_score": z,
                "severity": "high" if pct > 0 else "low",
            }
        )
    items.sort(key=lambda x: abs(x["pct_vs_avg"]), reverse=True)
    return {"items": items[:50], "note": None}


def _run_show(creds: dict, sql: str) -> tuple[pd.DataFrame | None, str | None]:
    try:
        with snowflake_connection(**_creds_kwargs(creds)) as conn:
            cur = conn.cursor()
            cur.execute(sql)
            cols = [c[0] for c in cur.description] if cur.description else []
            rows = cur.fetchall()
            df = pd.DataFrame(rows, columns=cols)
            if not df.empty:
                df.columns = [str(c).lower() for c in df.columns]
            return df, None
    except Exception as exc:  # noqa: BLE001
        # try refresh once for oauth
        try:
            from backend.lib.snowflake_client import refresh_oauth_credentials

            connection_id = creds.get("row", {}).get("id") if isinstance(creds.get("row"), dict) else None
            refreshed = refresh_oauth_credentials(creds, connection_id=connection_id)
            with snowflake_connection(**_creds_kwargs(refreshed)) as conn:
                cur = conn.cursor()
                cur.execute(sql)
                cols = [c[0] for c in cur.description] if cur.description else []
                rows = cur.fetchall()
                df = pd.DataFrame(rows, columns=cols)
                if not df.empty:
                    df.columns = [str(c).lower() for c in df.columns]
                return df, None
        except Exception as exc2:  # noqa: BLE001
            return None, friendly_connect_error(exc2, auth_method=creds.get("auth_method"))


def resource_monitors(creds: dict) -> dict[str, Any]:
    df, err = _run_show(creds, "SHOW RESOURCE MONITORS")
    if err:
        return {
            "items": [],
            "note": (
                "Sem acesso a Resource Monitors (precisa MONITOR / ACCOUNTADMIN). "
                f"Detalhe: {err}"
            ),
        }
    if df is None or df.empty:
        return {"items": [], "note": "Nenhum resource monitor nesta conta."}

    items = []
    for _, r in df.iterrows():
        items.append(
            {
                "name": r.get("name") or r.get("\"name\"") or "—",
                "credit_quota": _num(r, "credit_quota"),
                "used_credits": _num(r, "used_credits"),
                "remaining_credits": _num(r, "remaining_credits"),
                "level": str(r.get("level") or r.get("\"level\"") or "—"),
                "frequency": str(r.get("frequency") or "—"),
            }
        )
    return {"items": items, "note": None}


def budgets(creds: dict) -> dict[str, Any]:
    # Snowflake Budgets vary by version; try SHOW then degrade
    df, err = _run_show(creds, "SHOW BUDGETS")
    if err:
        return {
            "items": [],
            "note": (
                "Budgets indisponíveis nesta conta/role (objeto Budgets ou privilégio ausente). "
                f"Detalhe: {err}"
            ),
        }
    if df is None or df.empty:
        return {
            "items": [],
            "note": "Nenhum budget configurado nesta conta Snowflake.",
        }
    items = []
    for _, r in df.iterrows():
        row = {str(k): (None if pd.isna(v) else v) for k, v in r.items()}
        items.append(
            {
                "name": str(row.get("name") or row.get("budget_name") or "—"),
                "raw": {k: (str(v) if v is not None else None) for k, v in list(row.items())[:12]},
            }
        )
    return {"items": items, "note": None}


def organization_overview(creds: dict, *, days: int = 28) -> dict[str, Any]:
    try:
        df = run_query_with_creds(
            creds,
            """
            SELECT
                USAGE_DATE,
                ACCOUNT_NAME,
                SUM(CREDITS_USED) AS credits_used
            FROM SNOWFLAKE.ORGANIZATION_USAGE.METERING_DAILY_HISTORY
            WHERE USAGE_DATE >= DATEADD('day', %s, CURRENT_DATE())
            GROUP BY 1, 2
            ORDER BY USAGE_DATE DESC
            LIMIT 500
            """,
            (-int(days),),
        )
    except Exception as exc:  # noqa: BLE001
        return {
            "available": False,
            "items": [],
            "note": (
                "Organization Overview requer ORGADMIN ou grant em "
                "SNOWFLAKE.ORGANIZATION_USAGE. "
                f"Detalhe: {friendly_connect_error(exc, auth_method=creds.get('auth_method'))}"
            ),
        }

    if df.empty:
        return {
            "available": True,
            "items": [],
            "note": "Sem dados de ORGANIZATION_USAGE no período.",
        }
    df.columns = [c.lower() for c in df.columns]
    items = []
    for _, r in df.iterrows():
        d = r.get("usage_date")
        items.append(
            {
                "usage_date": d.isoformat() if hasattr(d, "isoformat") else str(d),
                "account_name": r.get("account_name"),
                "credits_used": float(r.get("credits_used") or 0),
            }
        )
    return {"available": True, "items": items, "note": None}


def _num(row: pd.Series, *keys: str) -> float | None:
    for k in keys:
        if k in row.index and pd.notna(row[k]):
            try:
                return float(row[k])
            except (TypeError, ValueError):
                continue
    return None
