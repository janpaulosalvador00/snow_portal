"""Performance tab: warehouse load + query hotspots (read-only recommendations)."""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Any

import pandas as pd

from backend.lib.snowflake_client import friendly_connect_error, run_query_with_creds

_LATENCY_NOTE = (
    "Dados de ACCOUNT_USAGE podem atrasar (queries até ~45 min; "
    "carga de warehouse até ~3 h). Recomendações são somente leitura — "
    "o portal não altera warehouses no Snowflake."
)

_QUEUE_RATIO_HIGH = 0.15  # queued share of (running+queued) over the window
_LOW_LOAD_MAX = 0.45  # mean (running+queued) per interval — candidate to downsize
_SPILL_RATIO_HIGH = 5.0  # remote spill / bytes_scanned (Snowflake Resource Optimization guide)
_HOTSPOT_LIMIT = 40


def _window(
    days: int,
    start_date: str | None,
    end_date: str | None,
) -> tuple[str, str, int]:
    today = datetime.now(timezone.utc).date()
    if start_date and end_date:
        start = date.fromisoformat(start_date[:10])
        end = date.fromisoformat(end_date[:10])
    else:
        end = today
        start = today - timedelta(days=max(1, int(days)) - 1)
    span = max(1, (end - start).days + 1)
    return start.isoformat(), end.isoformat(), span


def _wh_clause(warehouse: str | None) -> tuple[str, tuple]:
    name = (warehouse or "").strip()
    if not name or name.upper() == "ALL":
        return "", ()
    return " AND warehouse_name = %s", (name,)


def _recommend_warehouse(*, mean_running: float, mean_queued: float, days_with_queue: int, days: int) -> dict[str, str]:
    total = mean_running + mean_queued
    queue_share = (mean_queued / total) if total > 1e-9 else 0.0
    if mean_queued > 0.05 and (queue_share >= _QUEUE_RATIO_HIGH or days_with_queue >= max(2, days // 3)):
        return {
            "level": "warn",
            "code": "upsize_or_multicluster",
            "text": "Fila recorrente — considerar aumentar o tamanho ou multi-cluster / separar workload",
        }
    if total > 0 and total < _LOW_LOAD_MAX and mean_queued < 0.02 and days_with_queue <= 1:
        return {
            "level": "ok",
            "code": "downsize_candidate",
            "text": "Carga baixa e pouca fila — candidato a reduzir tamanho ou clusters",
        }
    return {
        "level": "neutral",
        "code": "none",
        "text": "Sem recomendação clara",
    }


def _recommend_query(*, executions: int, spill_ratio: float, total_elapsed_ms: float) -> dict[str, str]:
    if spill_ratio >= _SPILL_RATIO_HIGH:
        return {
            "level": "bad",
            "code": "remote_spill",
            "text": "Spill remoto alto — considerar warehouse maior ou processar em lotes menores",
        }
    if executions >= 20 and total_elapsed_ms >= 30 * 60 * 1000:
        return {
            "level": "warn",
            "code": "repeated_heavy",
            "text": "Muito repetida e cara — priorizar otimização dessa query",
        }
    if total_elapsed_ms >= 30 * 60 * 1000:
        return {
            "level": "warn",
            "code": "long_running",
            "text": "Tempo acumulado alto no período — revisar plano / tamanho do warehouse",
        }
    return {
        "level": "neutral",
        "code": "none",
        "text": "Sem sinal de memória ou repetição crítica",
    }


def _queue_label(mean_queued: float, queue_share: float) -> str:
    if mean_queued >= 0.1 or queue_share >= _QUEUE_RATIO_HIGH:
        return "alta"
    if mean_queued >= 0.02 or queue_share >= 0.05:
        return "média"
    return "baixa"


def _spill_label(ratio: float) -> str:
    if ratio >= _SPILL_RATIO_HIGH:
        return "alto"
    if ratio > 0.1:
        return "baixo"
    return "nenhum"


def _fmt_duration_ms(ms: float) -> str:
    sec = max(0, int(round(ms / 1000.0)))
    h, rem = divmod(sec, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h}h {m}m"
    if m:
        return f"{m}m {s}s"
    return f"{s}s"


def _privilege_payload(note: str, *, start: str, end: str, days: int) -> dict[str, Any]:
    return {
        "available": False,
        "days": days,
        "start_date": start,
        "end_date": end,
        "latency_note": _LATENCY_NOTE,
        "note": note,
        "warehouses": [],
        "load_series": [],
        "queries": [],
        "duration_buckets": [],
    }


def performance(
    creds: dict,
    *,
    days: int = 7,
    start_date: str | None = None,
    end_date: str | None = None,
    warehouse: str | None = None,
) -> dict[str, Any]:
    start, end, span = _window(days, start_date, end_date)
    wh_sql, wh_params = _wh_clause(warehouse)

    # --- Warehouse sizes (best-effort) ---
    size_by_wh: dict[str, str] = {}
    try:
        from backend.lib.cost_queries import _run_show

        wh_df, _ = _run_show(creds, "SHOW WAREHOUSES")
        if wh_df is not None and not wh_df.empty:
            name_col = "name" if "name" in wh_df.columns else wh_df.columns[0]
            size_col = "size" if "size" in wh_df.columns else None
            for _, row in wh_df.iterrows():
                n = str(row.get(name_col) or "").strip()
                if not n:
                    continue
                size_by_wh[n.upper()] = str(row.get(size_col) or "") if size_col else ""
    except Exception:  # noqa: BLE001
        pass

    # --- Load history ---
    load_sql = f"""
        SELECT
          TO_DATE(CONVERT_TIMEZONE('UTC', start_time)) AS usage_date,
          warehouse_name,
          AVG(avg_running) AS avg_running,
          AVG(avg_queued_load) AS avg_queued_load
        FROM SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_LOAD_HISTORY
        WHERE TO_DATE(CONVERT_TIMEZONE('UTC', start_time)) >= %s
          AND TO_DATE(CONVERT_TIMEZONE('UTC', start_time)) <= %s
          {wh_sql}
        GROUP BY 1, 2
        ORDER BY 1, 2
    """
    try:
        load_df = run_query_with_creds(creds, load_sql, (start, end, *wh_params))
    except Exception as exc:  # noqa: BLE001
        return _privilege_payload(
            friendly_connect_error(exc, auth_method=creds.get("auth_method")),
            start=start,
            end=end,
            days=span,
        )

    if load_df is None:
        load_df = pd.DataFrame()
    if not load_df.empty:
        load_df.columns = [str(c).lower() for c in load_df.columns]

    # --- Query hotspots ---
    query_sql = f"""
        SELECT
          COALESCE(query_hash, query_id) AS pattern_key,
          ANY_VALUE(LEFT(query_text, 180)) AS query_preview,
          ANY_VALUE(query_id) AS sample_query_id,
          ANY_VALUE(user_name) AS user_name,
          ANY_VALUE(warehouse_name) AS warehouse_name,
          COUNT(*) AS executions,
          SUM(total_elapsed_time) AS total_elapsed_ms,
          SUM(COALESCE(bytes_scanned, 0)) AS bytes_scanned,
          SUM(COALESCE(bytes_spilled_to_remote_storage, 0)) AS bytes_spilled_remote,
          SUM(COALESCE(bytes_spilled_to_local_storage, 0)) AS bytes_spilled_local
        FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY
        WHERE TO_DATE(CONVERT_TIMEZONE('UTC', start_time)) >= %s
          AND TO_DATE(CONVERT_TIMEZONE('UTC', start_time)) <= %s
          AND total_elapsed_time > 0
          AND execution_status = 'SUCCESS'
          {wh_sql}
        GROUP BY 1
        ORDER BY total_elapsed_ms DESC NULLS LAST
        LIMIT {_HOTSPOT_LIMIT}
    """
    try:
        q_df = run_query_with_creds(creds, query_sql, (start, end, *wh_params))
    except Exception as exc:  # noqa: BLE001
        return _privilege_payload(
            friendly_connect_error(exc, auth_method=creds.get("auth_method")),
            start=start,
            end=end,
            days=span,
        )

    if q_df is None:
        q_df = pd.DataFrame()
    if not q_df.empty:
        q_df.columns = [str(c).lower() for c in q_df.columns]

    # Duration buckets (all queries in window, not just hotspots)
    bucket_sql = f"""
        SELECT
          CASE
            WHEN total_elapsed_time <= 60000 THEN 'lt_60s'
            WHEN total_elapsed_time <= 300000 THEN '60s_5m'
            WHEN total_elapsed_time <= 1800000 THEN '5m_30m'
            ELSE 'gt_30m'
          END AS bucket,
          COUNT(*) AS query_count
        FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY
        WHERE TO_DATE(CONVERT_TIMEZONE('UTC', start_time)) >= %s
          AND TO_DATE(CONVERT_TIMEZONE('UTC', start_time)) <= %s
          AND total_elapsed_time > 0
          {wh_sql}
        GROUP BY 1
    """
    buckets_map = {"lt_60s": 0, "60s_5m": 0, "5m_30m": 0, "gt_30m": 0}
    try:
        b_df = run_query_with_creds(creds, bucket_sql, (start, end, *wh_params))
        if b_df is not None and not b_df.empty:
            b_df.columns = [str(c).lower() for c in b_df.columns]
            for _, row in b_df.iterrows():
                key = str(row.get("bucket") or "")
                if key in buckets_map:
                    buckets_map[key] = int(row.get("query_count") or 0)
    except Exception:  # noqa: BLE001
        pass

    duration_buckets = [
        {"bucket": "lt_60s", "label": "< 60s", "query_count": buckets_map["lt_60s"]},
        {"bucket": "60s_5m", "label": "60s – 5m", "query_count": buckets_map["60s_5m"]},
        {"bucket": "5m_30m", "label": "5m – 30m", "query_count": buckets_map["5m_30m"]},
        {"bucket": "gt_30m", "label": "> 30m", "query_count": buckets_map["gt_30m"]},
    ]

    # Aggregate load series (all warehouses or filtered)
    load_series: list[dict[str, Any]] = []
    if not load_df.empty:
        daily = (
            load_df.groupby("usage_date", dropna=False)
            .agg(avg_running=("avg_running", "sum"), avg_queued_load=("avg_queued_load", "sum"))
            .reset_index()
            .sort_values("usage_date")
        )
        for _, row in daily.iterrows():
            d = row["usage_date"]
            date_str = d.isoformat()[:10] if hasattr(d, "isoformat") else str(d)[:10]
            load_series.append(
                {
                    "date": date_str,
                    "avg_running": round(float(row["avg_running"] or 0), 4),
                    "avg_queued_load": round(float(row["avg_queued_load"] or 0), 4),
                }
            )

    warehouses: list[dict[str, Any]] = []
    if not load_df.empty:
        for wh_name, grp in load_df.groupby("warehouse_name"):
            name = str(wh_name or "").strip()
            if not name:
                continue
            mean_running = float(grp["avg_running"].astype(float).mean())
            mean_queued = float(grp["avg_queued_load"].astype(float).mean())
            total = mean_running + mean_queued
            queue_share = (mean_queued / total) if total > 1e-9 else 0.0
            days_with_queue = int((grp["avg_queued_load"].astype(float) > 0.02).sum())
            rec = _recommend_warehouse(
                mean_running=mean_running,
                mean_queued=mean_queued,
                days_with_queue=days_with_queue,
                days=span,
            )
            warehouses.append(
                {
                    "warehouse_name": name,
                    "size": size_by_wh.get(name.upper()) or None,
                    "mean_running": round(mean_running, 4),
                    "mean_queued": round(mean_queued, 4),
                    "queue_label": _queue_label(mean_queued, queue_share),
                    "days_with_queue": days_with_queue,
                    "recommendation": rec,
                }
            )
        warehouses.sort(key=lambda w: (w["mean_queued"], w["mean_running"]), reverse=True)

    queries: list[dict[str, Any]] = []
    if not q_df.empty:
        for _, row in q_df.iterrows():
            executions = int(row.get("executions") or 0)
            total_ms = float(row.get("total_elapsed_ms") or 0)
            scanned = float(row.get("bytes_scanned") or 0)
            spilled = float(row.get("bytes_spilled_remote") or 0)
            spill_ratio = (spilled / scanned) if scanned > 0 else (999.0 if spilled > 0 else 0.0)
            preview = str(row.get("query_preview") or "").replace("\n", " ").strip()
            if len(preview) > 160:
                preview = preview[:157] + "…"
            pattern = str(row.get("pattern_key") or "")
            queries.append(
                {
                    "pattern_key": pattern,
                    "query_preview": preview,
                    "sample_query_id": str(row.get("sample_query_id") or ""),
                    "user_name": str(row.get("user_name") or ""),
                    "warehouse_name": str(row.get("warehouse_name") or ""),
                    "executions": executions,
                    "total_elapsed_ms": total_ms,
                    "total_elapsed_label": _fmt_duration_ms(total_ms),
                    "bytes_scanned": scanned,
                    "bytes_spilled_remote": spilled,
                    "spill_ratio": round(spill_ratio, 3) if spill_ratio < 900 else None,
                    "spill_label": _spill_label(spill_ratio if spill_ratio < 900 else _SPILL_RATIO_HIGH),
                    "recommendation": _recommend_query(
                        executions=executions,
                        spill_ratio=spill_ratio if spill_ratio < 900 else _SPILL_RATIO_HIGH,
                        total_elapsed_ms=total_ms,
                    ),
                }
            )

    note = None
    if not warehouses and not queries:
        note = "Sem dados de carga ou queries no período (ou ACCOUNT_USAGE ainda não refletiu)."

    warehouse_names = sorted({w["warehouse_name"] for w in warehouses})
    if not warehouse_names and size_by_wh:
        warehouse_names = sorted(size_by_wh.keys())

    return {
        "available": True,
        "days": span,
        "start_date": start,
        "end_date": end,
        "latency_note": _LATENCY_NOTE,
        "note": note,
        "warehouse_filter": (warehouse or "").strip() or None,
        "warehouse_options": warehouse_names,
        "warehouses": warehouses,
        "load_series": load_series,
        "queries": queries,
        "duration_buckets": duration_buckets,
    }
