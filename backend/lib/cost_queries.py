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
    start_date: str | None = None,
    end_date: str | None = None,
) -> pd.DataFrame:
    """Consumption with OAuth refresh path via run_query_with_creds."""
    from datetime import date, datetime, timedelta, timezone

    from backend.lib.metering import _consumption_sql

    if grain not in ("day", "month", "hour"):
        grain = "day"

    use_absolute = bool(start_date and end_date)
    if use_absolute:
        try:
            start_d = date.fromisoformat(start_date[:10])
            end_d = date.fromisoformat(end_date[:10])
        except ValueError as exc:
            raise ValueError("start_date/end_date devem ser YYYY-MM-DD.") from exc
        if end_d < start_d:
            raise ValueError("end_date deve ser >= start_date.")
        span = (end_d - start_d).days + 1
        if span > 365:
            raise ValueError("Intervalo máximo é 365 dias.")
        # Inclusive end: half-open [start, end+1 day) in UTC
        start_ts = datetime(start_d.year, start_d.month, start_d.day, tzinfo=timezone.utc)
        end_exclusive = datetime(
            end_d.year, end_d.month, end_d.day, tzinfo=timezone.utc
        ) + timedelta(days=1)
        sql = _consumption_sql(grain, absolute_range=True)
        params = (
            start_ts.isoformat(),
            end_exclusive.isoformat(),
            service_type,
            service_type,
            None,
            None,
        )
    else:
        days = int(days)
        sql = _consumption_sql(grain, absolute_range=False)
        params = (-days, service_type, service_type, None, None)

    df = run_query_with_creds(creds, sql, params)
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
    """Daily credit series with expected range (rolling mean ± 2·std) and outlier points."""
    df = fetch_consumption_for_creds(creds, days=days, grain="day", usage_type="All")
    if df.empty:
        return {
            "series": [],
            "anomalies": [],
            "items": [],
            "note": "Sem dados de metering no período.",
        }

    daily = (
        df.groupby("period_start", dropna=False)["credits_display"]
        .sum()
        .reset_index()
        .sort_values("period_start")
    )
    values = daily["credits_display"].astype(float).tolist()
    window = max(7, min(14, max(3, len(values) // 3)))
    k = 2.0

    series: list[dict] = []
    anomaly_rows: list[dict] = []
    for i, (_, row) in enumerate(daily.iterrows()):
        period = row["period_start"]
        date_str = period.isoformat() if hasattr(period, "isoformat") else str(period)
        if "T" in date_str:
            date_str = date_str[:10]
        credits = float(row["credits_display"] or 0)
        hist = values[max(0, i - window + 1) : i] if i > 0 else values[:1]
        mean = float(sum(hist) / len(hist)) if hist else credits
        if len(hist) >= 2:
            var = sum((x - mean) ** 2 for x in hist) / len(hist)
            std = var**0.5
        else:
            std = 0.0
        low = max(0.0, mean - k * std)
        high = mean + k * std
        if high <= low:
            high = low + max(0.01, mean * 0.1 + 0.01)
        is_anom = credits > high or (credits < low and mean > 0.5)
        series.append(
            {
                "date": date_str,
                "credits": credits,
                "expected_low": round(low, 4),
                "expected_high": round(high, 4),
                "is_anomaly": is_anom,
            }
        )
        if is_anom:
            delta = credits - high if credits > high else credits - low
            anomaly_rows.append(
                {
                    "date": date_str,
                    "credits": round(credits, 4),
                    "expected_low": round(low, 4),
                    "expected_high": round(high, 4),
                    "delta": round(delta, 4),
                }
            )

    anomaly_rows.sort(key=lambda x: x["date"], reverse=True)

    by_res = (
        df.groupby(["period_start", "resource_name"], dropna=False)["credits_display"]
        .sum()
        .reset_index()
    )
    items: list[dict] = []
    for name, grp in by_res.groupby("resource_name"):
        s = grp["credits_display"].astype(float)
        if len(s) < 3:
            continue
        mean = float(s.mean())
        std = float(s.std(ddof=0)) or 0.0
        latest = float(s.iloc[-1])
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
                "direction": "high" if pct > 0 else "low",
            }
        )
    items.sort(key=lambda x: abs(x["pct_vs_avg"]), reverse=True)

    return {
        "series": series,
        "anomalies": anomaly_rows[:100],
        "items": items[:50],
        "note": None,
    }


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

    # Map monitor name -> warehouses via SHOW WAREHOUSES.resource_monitor
    wh_by_monitor: dict[str, list[str]] = {}
    wh_df, _wh_err = _run_show(creds, "SHOW WAREHOUSES")
    if wh_df is not None and not wh_df.empty:
        name_col = "name" if "name" in wh_df.columns else wh_df.columns[0]
        mon_col = None
        for c in wh_df.columns:
            if "resource_monitor" in str(c).lower():
                mon_col = c
                break
        if mon_col:
            for _, wr in wh_df.iterrows():
                mon = wr.get(mon_col)
                if mon is None or (isinstance(mon, float) and pd.isna(mon)):
                    continue
                mon_s = str(mon).strip()
                if not mon_s or mon_s.upper() in ("NONE", "NULL", ""):
                    continue
                wh_name = str(wr.get(name_col) or "").strip()
                if not wh_name:
                    continue
                wh_by_monitor.setdefault(mon_s.upper(), []).append(wh_name)

    items = []
    for _, r in df.iterrows():
        name = str(r.get("name") or r.get('"name"') or "—")
        quota = _num(r, "credit_quota")
        used = _num(r, "used_credits")
        remaining = _num(r, "remaining_credits")
        pct = None
        if quota is not None and quota > 0 and used is not None:
            pct = round(100.0 * used / quota, 2)
        start = r.get("start_time") or r.get("created_on") or r.get('"start_time"')
        if hasattr(start, "isoformat"):
            start_s = start.isoformat()
        elif start is not None and not (isinstance(start, float) and pd.isna(start)):
            start_s = str(start)
        else:
            start_s = None
        warehouses = wh_by_monitor.get(name.upper(), [])
        items.append(
            {
                "name": name,
                "credit_quota": quota,
                "used_credits": used,
                "remaining_credits": remaining,
                "quota_used_pct": pct,
                "level": str(r.get("level") or r.get('"level"') or "—"),
                "frequency": str(r.get("frequency") or "—"),
                "warehouses": warehouses,
                "start_time": start_s,
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
