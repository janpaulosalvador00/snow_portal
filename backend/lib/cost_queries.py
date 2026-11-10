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
    _refresh_oauth_locked,
    ensure_fresh_oauth_credentials,
    friendly_connect_error,
    is_oauth_token_error,
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
    resource_name: str | None = None,
    start_date: str | None = None,
    end_date: str | None = None,
) -> pd.DataFrame:
    """Consumption with OAuth refresh path via run_query_with_creds."""
    from datetime import date, datetime, timedelta, timezone

    from backend.lib.metering import _consumption_sql

    if grain not in ("day", "month", "hour"):
        grain = "day"
    res = None if not resource_name or resource_name == "All" else resource_name

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
            res,
            res,
        )
    else:
        days = int(days)
        sql = _consumption_sql(grain, absolute_range=False)
        params = (-days, service_type, service_type, res, res)

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
    """Build chart + summary from the same filtered frame (no top-N chart-only cut)."""
    if df.empty:
        return {"total_credits": 0, "summary": [], "chart": [], "stack_by": "resource"}
    # Drop rows that the Usage Type filter zeroed out (e.g. cloud-only under Compute).
    df = df[df["credits_display"].fillna(0).astype(float) > 1e-12].copy()
    if df.empty:
        return {"total_credits": 0, "summary": [], "chart": [], "stack_by": "resource"}
    summary = summarize_by_resource(df)
    chart = chart_frame(df)
    # Chart and table must share the same resource set (API filters already applied).
    names = set(summary["resource_name"].tolist())
    if names:
        chart = chart[chart["resource_name"].isin(names)]
    total = float(summary["credits_used"].sum())

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
        "stack_by": "resource",
    }


_STORAGE_USAGE_BYTE_COLUMNS = (
    "storage_bytes",
    "stage_bytes",
    "failsafe_bytes",
    "hybrid_table_storage_bytes",
    "archive_storage_cool_bytes",
    "archive_storage_cold_bytes",
    "archive_storage_retrieval_temp_bytes",
)


def account_overview(
    creds: dict,
    *,
    days: int = 28,
    start_date: str | None = None,
    end_date: str | None = None,
) -> dict[str, Any]:
    df = fetch_consumption_for_creds(
        creds,
        days=days,
        grain="day",
        usage_type="All",
        start_date=start_date,
        end_date=end_date,
    )
    total = float(df["credits_display"].sum()) if not df.empty else 0.0
    if start_date and end_date:
        try:
            from datetime import date as date_cls

            span = (
                date_cls.fromisoformat(end_date[:10])
                - date_cls.fromisoformat(start_date[:10])
            ).days + 1
            days = max(1, span)
        except ValueError:
            pass
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

    storage_bytes = None
    storage_tb = None
    storage_note = None
    try:
        # SELECT * because the optional columns (hybrid/archive) vary by account/edition.
        storage = run_query_with_creds(
            creds,
            """
            SELECT *
            FROM SNOWFLAKE.ACCOUNT_USAGE.STORAGE_USAGE
            ORDER BY USAGE_DATE DESC
            LIMIT 1
            """,
        )
        if not storage.empty:
            storage.columns = [c.lower() for c in storage.columns]
            row = storage.iloc[0]
            storage_bytes = 0.0
            for col in _STORAGE_USAGE_BYTE_COLUMNS:
                value = row.get(col)
                if value is not None and not pd.isna(value):
                    storage_bytes += float(value)
            storage_tb = storage_bytes / (1024**4)
    except Exception as exc:  # noqa: BLE001
        storage_note = friendly_connect_error(exc, auth_method=creds.get("auth_method"))

    return {
        "days": days,
        "total_credits": total,
        "by_service": by_service,
        "storage_bytes": storage_bytes,
        "storage_tb": storage_tb,
        "storage_note": storage_note,
    }


def anomalies(
    creds: dict,
    *,
    days: int = 28,
    start_date: str | None = None,
    end_date: str | None = None,
) -> dict[str, Any]:
    """Daily credit series with expected range (rolling mean ± 2·std) and outlier points."""
    df = fetch_consumption_for_creds(
        creds,
        days=days,
        grain="day",
        usage_type="All",
        start_date=start_date,
        end_date=end_date,
    )
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


def _show_frame(creds: dict, sql: str) -> pd.DataFrame:
    with snowflake_connection(**_creds_kwargs(creds)) as conn:
        cur = conn.cursor()
        cur.execute(sql)
        cols = [c[0] for c in cur.description] if cur.description else []
        rows = cur.fetchall()
        df = pd.DataFrame(rows, columns=cols)
        if not df.empty:
            df.columns = [str(c).lower() for c in df.columns]
        return df


def _run_show(creds: dict, sql: str) -> tuple[pd.DataFrame | None, str | None]:
    row = creds.get("row")
    connection_id = row.get("id") if isinstance(row, dict) else None
    method = (creds.get("auth_method") or "").lower()
    creds = ensure_fresh_oauth_credentials(creds, connection_id=connection_id)
    try:
        return _show_frame(creds, sql), None
    except Exception as exc:  # noqa: BLE001
        if method not in ("oauth", "local_oauth") or not is_oauth_token_error(exc):
            return None, friendly_connect_error(exc, auth_method=method)
        try:
            creds = _refresh_oauth_locked(creds, connection_id=connection_id)
            return _show_frame(creds, sql), None
        except Exception as exc2:  # noqa: BLE001
            return None, friendly_connect_error(exc2, auth_method=method)


def resource_monitors(creds: dict) -> dict[str, Any]:
    account_name: str | None = None
    try:
        # Prefer account name (matches ORGANIZATION_USAGE / Consumption filter);
        # fall back to locator if CURRENT_ACCOUNT_NAME is unavailable.
        adf = run_query_with_creds(
            creds,
            """
            SELECT
                CURRENT_ACCOUNT_NAME() AS account_name,
                CURRENT_ACCOUNT() AS account_locator
            """,
        )
        if adf is not None and not adf.empty:
            adf.columns = [str(c).lower() for c in adf.columns]
            raw = adf.iloc[0].get("account_name")
            if raw is None or (isinstance(raw, float) and pd.isna(raw)) or not str(raw).strip():
                raw = adf.iloc[0].get("account_locator")
            if raw is not None and not (isinstance(raw, float) and pd.isna(raw)):
                account_name = str(raw).strip() or None
    except Exception:  # noqa: BLE001
        try:
            adf = run_query_with_creds(creds, "SELECT CURRENT_ACCOUNT() AS account_name")
            if adf is not None and not adf.empty:
                adf.columns = [str(c).lower() for c in adf.columns]
                raw = adf.iloc[0].get("account_name")
                if raw is not None and not (isinstance(raw, float) and pd.isna(raw)):
                    account_name = str(raw).strip() or None
        except Exception:  # noqa: BLE001
            account_name = None

    df, err = _run_show(creds, "SHOW RESOURCE MONITORS")
    if err:
        return {
            "items": [],
            "account_name": account_name,
            "note": (
                "Sem acesso a Resource Monitors (precisa MONITOR / ACCOUNTADMIN). "
                f"Detalhe: {err}"
            ),
        }
    if df is None or df.empty:
        return {
            "items": [],
            "account_name": account_name,
            "note": "Nenhum resource monitor nesta conta.",
        }

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
                "account_name": account_name,
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
    return {"items": items, "account_name": account_name, "note": None}


_BUDGETS_PRIVILEGE_MARKERS = (
    "insufficient privilege",
    "not authorized",
    "access denied",
    "003001",
)
_BUDGETS_UNSUPPORTED_MARKERS = (
    "unsupported",
    "not supported",
    "syntax error",
)

_BUDGETS_UNAVAILABLE = {
    "unsupported": {
        "message": "O recurso Budgets do Snowflake não está habilitado ou disponível nesta conta.",
        "help": (
            "Budgets não é suportado em alguns tipos de conta (ex.: reader/trial) ou "
            "regiões, e precisa ser ativado em Snowsight › Admin › Cost Management › "
            "Budgets (budget da conta ou budgets personalizados). Depois de ativado, "
            "os budgets aparecem aqui na próxima atualização."
        ),
    },
    "privileges": {
        "message": "A role desta conexão não tem privilégio para consultar Budgets.",
        "help": (
            "Conceda à role a application role SNOWFLAKE.BUDGET_VIEWER (budget da conta) "
            "e/ou a instance role <budget>!VIEWER dos budgets personalizados, ou use uma "
            "role com acesso (ex.: ACCOUNTADMIN) na conexão."
        ),
    },
}


def _budgets_unavailable_reason(err: str) -> str | None:
    lower = err.lower()
    if any(m in lower for m in _BUDGETS_PRIVILEGE_MARKERS):
        return "privileges"
    if any(m in lower for m in _BUDGETS_UNSUPPORTED_MARKERS):
        return "unsupported"
    return None


def budgets(creds: dict) -> dict[str, Any]:
    # SHOW BUDGETS is rejected on most accounts ("Unsupported feature"); budgets are
    # instances of the SNOWFLAKE.CORE.BUDGET class there.
    df, err = _run_show(creds, "SHOW BUDGETS")
    if err and _budgets_unavailable_reason(err) == "unsupported":
        df, err = _run_show(creds, "SHOW SNOWFLAKE.CORE.BUDGET INSTANCES IN ACCOUNT")
    if err:
        reason = _budgets_unavailable_reason(err)
        if reason:
            return {
                "items": [],
                "supported": False,
                "reason": reason,
                **_BUDGETS_UNAVAILABLE[reason],
                "detail": err,
                "note": None,
            }
        return {
            "items": [],
            "supported": True,
            "note": f"Falha ao consultar Budgets. Detalhe: {err}",
        }
    if df is None or df.empty:
        return {
            "items": [],
            "supported": True,
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
    return {"items": items, "supported": True, "note": None}


_ORG_METERING_COLUMNS = [
    "usage_date",
    "account_name",
    "service_type",
    "credits_used",
    "credits_compute",
    "credits_cloud",
]


def _org_metering_daily(
    creds: dict,
    *,
    days: int = 28,
    start_date: str | None = None,
    end_date: str | None = None,
) -> tuple[pd.DataFrame | None, str | None]:
    """Return ORGANIZATION_USAGE daily metering per account and service, or (None, note)."""
    return _metering_daily(
        creds,
        "ACCOUNT_NAME",
        "SNOWFLAKE.ORGANIZATION_USAGE.METERING_DAILY_HISTORY",
        days=days,
        start_date=start_date,
        end_date=end_date,
    )


def _account_metering_daily(
    creds: dict,
    account_name: str,
    *,
    days: int = 28,
    start_date: str | None = None,
    end_date: str | None = None,
) -> pd.DataFrame | None:
    """Connected account's ACCOUNT_USAGE daily metering (same shape as the org frame).

    ORGANIZATION_USAGE lags up to a day behind ACCOUNT_USAGE, so the most recent days of
    the connected account would be undercounted if read from the org view.
    """
    df, note = _metering_daily(
        creds,
        "%s",
        "SNOWFLAKE.ACCOUNT_USAGE.METERING_DAILY_HISTORY",
        days=days,
        start_date=start_date,
        end_date=end_date,
        lead_params=(account_name,),
    )
    return None if note else df


def _metering_daily(
    creds: dict,
    account_expr: str,
    view: str,
    *,
    days: int,
    start_date: str | None,
    end_date: str | None,
    lead_params: tuple = (),
) -> tuple[pd.DataFrame | None, str | None]:
    # account_expr/view are module constants, never user input.
    select = f"""
                SELECT
                    USAGE_DATE,
                    {account_expr} AS ACCOUNT_NAME,
                    SERVICE_TYPE,
                    SUM(CREDITS_USED) AS credits_used,
                    SUM(CREDITS_USED_COMPUTE) AS credits_compute,
                    SUM(CREDITS_USED_CLOUD_SERVICES) AS credits_cloud
                FROM {view}
    """
    try:
        if start_date and end_date:
            from datetime import date as date_cls

            start_d = date_cls.fromisoformat(start_date[:10])
            end_d = date_cls.fromisoformat(end_date[:10])
            if end_d < start_d:
                raise ValueError("end_date deve ser >= start_date.")
            df = run_query_with_creds(
                creds,
                select
                + """
                WHERE USAGE_DATE >= %s AND USAGE_DATE <= %s
                GROUP BY 1, 2, 3
                ORDER BY USAGE_DATE DESC
                LIMIT 50000
                """,
                (*lead_params, start_d.isoformat(), end_d.isoformat()),
            )
        else:
            df = run_query_with_creds(
                creds,
                select
                + """
                WHERE USAGE_DATE >= DATEADD('day', %s, CURRENT_DATE())
                GROUP BY 1, 2, 3
                ORDER BY USAGE_DATE DESC
                LIMIT 50000
                """,
                (*lead_params, -int(days)),
            )
    except ValueError:
        raise
    except Exception as exc:  # noqa: BLE001
        return None, (
            "Organization Usage requer ORGADMIN ou grant em "
            "SNOWFLAKE.ORGANIZATION_USAGE. "
            f"Detalhe: {friendly_connect_error(exc, auth_method=creds.get('auth_method'))}"
        )
    if df is None or df.empty:
        return pd.DataFrame(columns=_ORG_METERING_COLUMNS), None
    df = df.copy()
    df.columns = [c.lower() for c in df.columns]
    for col in ("credits_used", "credits_compute", "credits_cloud"):
        df[col] = pd.to_numeric(df[col], errors="coerce").fillna(0.0).astype(float)
    return df, None


def _org_daily_by_account(df: pd.DataFrame) -> pd.DataFrame:
    """Collapse per-service org metering back to one row per day and account."""
    if df.empty:
        return pd.DataFrame(columns=["usage_date", "account_name", "credits_used"])
    return (
        df.groupby(["usage_date", "account_name"], dropna=False)["credits_used"]
        .sum()
        .reset_index()
        .sort_values("usage_date", ascending=False)
    )


def _usage_column(usage_type: str) -> str:
    if usage_type == "Compute":
        return "credits_compute"
    if usage_type == "Cloud Services":
        return "credits_cloud"
    return "credits_used"


def _current_account_name(creds: dict) -> str | None:
    try:
        adf = run_query_with_creds(creds, "SELECT CURRENT_ACCOUNT_NAME() AS account_name")
    except Exception:  # noqa: BLE001
        return None
    if adf is None or adf.empty:
        return None
    adf.columns = [str(c).lower() for c in adf.columns]
    raw = adf.iloc[0].get("account_name")
    if raw is None or (isinstance(raw, float) and pd.isna(raw)):
        return None
    return str(raw).strip() or None


def account_name_from_identifier(identifier: str | None) -> str | None:
    """Best-effort ACCOUNT_NAME from ``orgname-accountname`` (locators keep their first segment)."""
    raw = (identifier or "").strip().lower()
    for suffix in (".snowflakecomputing.com", ".privatelink"):
        if suffix in raw:
            raw = raw.split(suffix, 1)[0]
    if raw.startswith("https://"):
        raw = raw[len("https://"):]
    if not raw:
        return None
    if "." in raw:
        return raw.split(".", 1)[0].upper() or None
    if "-" in raw:
        # URLs spell underscores in account names as hyphens (org-my-account → MY_ACCOUNT).
        return raw.split("-", 1)[1].replace("-", "_").upper() or None
    return raw.upper()


def connection_account(creds: dict) -> dict[str, Any]:
    """Snowflake account this connection lands on (raises when the session cannot open)."""
    df = run_query_with_creds(
        creds,
        """
        SELECT
            CURRENT_ACCOUNT_NAME() AS account_name,
            CURRENT_ORGANIZATION_NAME() AS organization_name,
            CURRENT_ACCOUNT() AS account_locator
        """,
    )
    row: dict[str, Any] = {}
    if df is not None and not df.empty:
        df.columns = [str(c).lower() for c in df.columns]
        row = df.iloc[0].to_dict()

    def _clean(key: str) -> str | None:
        v = row.get(key)
        if v is None or (isinstance(v, float) and pd.isna(v)):
            return None
        return str(v).strip() or None

    name = _clean("account_name")
    return {
        "account_name": name or account_name_from_identifier(creds.get("account")),
        "organization_name": _clean("organization_name"),
        "account_locator": _clean("account_locator"),
        "account_identifier": creds.get("account"),
        "source": "snowflake" if name else "identifier",
        "note": None,
    }


def service_types(creds: dict, *, days: int = 365) -> dict[str, Any]:
    """Full Service Type catalog plus any extra SERVICE_TYPE seen, flagged when it consumed."""
    from backend.lib.metering import SERVICE_TYPE_LABELS, _label_service

    consumed: dict[str, float] = {}
    note = None
    queries = (
        """
        SELECT SERVICE_TYPE, SUM(CREDITS_USED) AS credits_used
        FROM SNOWFLAKE.ORGANIZATION_USAGE.METERING_DAILY_HISTORY
        WHERE USAGE_DATE >= DATEADD('day', %s, CURRENT_DATE())
        GROUP BY 1
        """,
        """
        SELECT SERVICE_TYPE, SUM(CREDITS_USED) AS credits_used
        FROM SNOWFLAKE.ACCOUNT_USAGE.METERING_HISTORY
        WHERE START_TIME >= DATEADD('day', %s, CURRENT_TIMESTAMP())
        GROUP BY 1
        """,
    )
    for sql in queries:
        try:
            df = run_query_with_creds(creds, sql, (-int(days),))
        except Exception as exc:  # noqa: BLE001
            note = friendly_connect_error(exc, auth_method=creds.get("auth_method"))
            continue
        note = None
        if df is not None and not df.empty:
            df.columns = [str(c).lower() for c in df.columns]
            for _, r in df.iterrows():
                st = str(r.get("service_type") or "").strip()
                if st:
                    consumed[st] = consumed.get(st, 0.0) + float(r.get("credits_used") or 0)
        break

    values = set(SERVICE_TYPE_LABELS) | set(consumed)
    items = sorted(
        (
            {
                "value": v,
                "label": _label_service(v),
                "consumed": consumed.get(v, 0.0) > 1e-12,
            }
            for v in values
        ),
        key=lambda x: x["label"].lower(),
    )
    return {
        "items": [{"value": "All", "label": "All", "consumed": bool(consumed)}, *items],
        "days": days,
        "note": note,
    }


def organization_overview(
    creds: dict,
    *,
    days: int = 28,
    start_date: str | None = None,
    end_date: str | None = None,
) -> dict[str, Any]:
    df, note = _org_metering_daily(
        creds, days=days, start_date=start_date, end_date=end_date
    )
    if df is None:
        return {"available": False, "items": [], "note": note}

    df = _org_daily_by_account(df)
    if df.empty:
        return {
            "available": True,
            "items": [],
            "note": "Sem dados de ORGANIZATION_USAGE no período.",
        }
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


def list_org_accounts(
    creds: dict,
    *,
    days: int = 28,
    start_date: str | None = None,
    end_date: str | None = None,
    fallback_name: str | None = None,
) -> dict[str, Any]:
    """Distinct Snowflake account names for the All Accounts filter."""
    df, note = _org_metering_daily(
        creds, days=days, start_date=start_date, end_date=end_date
    )
    if df is None:
        accounts = [fallback_name] if fallback_name else []
        return {
            "available": False,
            "accounts": [a for a in accounts if a],
            "note": note,
        }
    names: list[str] = []
    if not df.empty and "account_name" in df.columns:
        for n in df["account_name"].dropna().astype(str).unique().tolist():
            name = n.strip()
            if name and name not in names:
                names.append(name)
        names.sort(key=str.lower)
    if not names and fallback_name:
        names = [fallback_name]
    return {"available": True, "accounts": names, "note": None}


def org_consumption_by_account(
    creds: dict,
    *,
    days: int = 28,
    start_date: str | None = None,
    end_date: str | None = None,
    account_name: str | None = None,
    service_type: str | None = None,
    usage_type: str = "Compute",
) -> dict[str, Any]:
    """Consumption payload stacked by service (All), resource (own account) or account.

    ``stack_by`` tells the UI which dimension the chart/table series represent.
    """
    from backend.lib.metering import _label_service

    account = None
    if account_name and account_name not in ("All", "ALL", "__all__"):
        account = account_name
    service = None if not service_type or service_type == "All" else service_type
    stack_by = "service" if service is None else "account"

    own = _current_account_name(creds)
    is_own = bool(own and account and own.upper() == account.upper())
    if service is not None and is_own:
        try:
            raw = fetch_consumption_for_creds(
                creds,
                days=days,
                grain="day",
                service_type=service,
                usage_type=usage_type,
                start_date=start_date,
                end_date=end_date,
            )
        except ValueError:
            raise
        except Exception:  # noqa: BLE001
            raw = None
        if raw is not None:
            return {
                **consumption_payload(raw),
                "available": True,
                "stack_by": "resource",
                "note": None,
            }

    window = {"days": days, "start_date": start_date, "end_date": end_date}
    own_df = (
        _account_metering_daily(creds, own, **window)
        if own and (account is None or is_own)
        else None
    )
    if is_own and own_df is not None:
        df, note = own_df, None
    else:
        df, note = _org_metering_daily(creds, **window)
        if df is not None and own_df is not None:
            others = df[df["account_name"].astype(str).str.upper() != own.upper()]
            df = pd.concat([others, own_df], ignore_index=True)
    if df is None:
        return {
            "available": False,
            "total_credits": 0.0,
            "summary": [],
            "chart": [],
            "stack_by": stack_by,
            "note": note,
        }

    if account is not None:
        df = df[df["account_name"].astype(str).str.upper() == account.upper()]
    if service is not None:
        df = df[df["service_type"].astype(str) == service]

    col = _usage_column(usage_type)
    df = df[df[col] > 1e-12] if not df.empty else df
    if df.empty:
        return {
            "available": True,
            "total_credits": 0.0,
            "summary": [],
            "chart": [],
            "stack_by": stack_by,
            "note": None,
        }

    df = df.copy()
    if stack_by == "service":
        df["series"] = df["service_type"].map(_label_service)
        series_type = "Service"
    else:
        df["series"] = df["account_name"].fillna("UNKNOWN").astype(str)
        series_type = "Account"
    df["period"] = df["usage_date"].map(
        lambda d: (d.isoformat() if hasattr(d, "isoformat") else str(d))[:10]
    )

    daily = df.groupby(["period", "series"], dropna=False)[col].sum().reset_index()
    chart = [
        {
            "period_start": r["period"],
            "resource_name": r["series"],
            "credits": float(r[col]),
        }
        for _, r in daily.sort_values(["period", "series"]).iterrows()
    ]

    by_series = df.groupby("series", dropna=False)[col].sum()
    summary = [
        {
            "name": name,
            "type": series_type,
            "tags": "",
            "credits_used": round(float(credits), 4),
        }
        for name, credits in sorted(
            by_series.items(), key=lambda x: (-x[1], str(x[0]).lower())
        )
    ]
    total = round(float(by_series.sum()), 4)
    return {
        "available": True,
        "total_credits": total,
        "summary": summary,
        "chart": chart,
        "stack_by": stack_by,
        "note": None,
    }


def _num(row: pd.Series, *keys: str) -> float | None:
    for k in keys:
        if k in row.index and pd.notna(row[k]):
            try:
                return float(row[k])
            except (TypeError, ValueError):
                continue
    return None
