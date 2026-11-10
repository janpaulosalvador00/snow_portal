"""Postgres-backed cache for Snowflake reads (one row per connection/dataset/filters)."""
from __future__ import annotations

import json
import logging
import math
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta, timezone
from typing import Any, Callable

from fastapi.encoders import jsonable_encoder

from backend.lib import cost_queries, db
from backend.lib.snowflake_client import discover_session_options_with_creds

logger = logging.getLogger(__name__)

Fetcher = Callable[[dict, dict], dict]


def _window(params: dict) -> dict:
    return {
        "days": params.get("days", 28),
        "start_date": params.get("start_date"),
        "end_date": params.get("end_date"),
    }


def _fetch_consumption(creds: dict, params: dict) -> dict:
    raw = cost_queries.fetch_consumption_for_creds(
        creds,
        grain=params.get("grain", "day"),
        service_type=params.get("service_type"),
        usage_type=params.get("usage_type", "Compute"),
        resource_name=params.get("resource_name"),
        **_window(params),
    )
    return cost_queries.consumption_payload(raw)


def _fetch_org_accounts(creds: dict, params: dict) -> dict:
    fallback = creds.get("account") or creds.get("account_identifier") or None
    return cost_queries.list_org_accounts(
        creds,
        fallback_name=str(fallback) if fallback else None,
        **_window(params),
    )


def _fetch_org_consumption(creds: dict, params: dict) -> dict:
    return cost_queries.org_consumption_by_account(
        creds,
        account_name=params.get("account_name"),
        service_type=params.get("service_type"),
        usage_type=params.get("usage_type", "Compute"),
        **_window(params),
    )


DATASETS: dict[str, Fetcher] = {
    "options": lambda creds, _p: discover_session_options_with_creds(creds),
    "consumption": _fetch_consumption,
    "org_accounts": _fetch_org_accounts,
    "org_consumption": _fetch_org_consumption,
    "service_types": lambda creds, _p: cost_queries.service_types(creds),
    "account_overview": lambda creds, p: cost_queries.account_overview(creds, **_window(p)),
    "anomalies": lambda creds, p: cost_queries.anomalies(creds, **_window(p)),
    "organization_overview": lambda creds, p: cost_queries.organization_overview(
        creds, **_window(p)
    ),
    "resource_monitors": lambda creds, _p: cost_queries.resource_monitors(creds),
    "budgets": lambda creds, _p: cost_queries.budgets(creds),
}


def params_key(params: dict) -> str:
    clean = {k: v for k, v in params.items() if v is not None}
    return json.dumps(clean, sort_keys=True, separators=(",", ":"))


def window_params(days: int, start_date: str | None, end_date: str | None) -> dict:
    return {"days": days, "start_date": start_date, "end_date": end_date}


def consumption_params(
    *,
    days: int,
    start_date: str | None,
    end_date: str | None,
    usage_type: str,
    service_type: str | None,
    resource_name: str | None,
    grain: str,
) -> dict:
    return {
        **window_params(days, start_date, end_date),
        "usage_type": usage_type,
        "service_type": None if not service_type or service_type == "All" else service_type,
        "resource_name": None if not resource_name or resource_name == "All" else resource_name,
        "grain": grain if grain in ("day", "month", "hour") else "day",
    }


def org_consumption_params(
    *,
    days: int,
    start_date: str | None,
    end_date: str | None,
    account_name: str | None,
    service_type: str | None = None,
    usage_type: str = "Compute",
) -> dict:
    name = (account_name or "").strip()
    service = (service_type or "").strip()
    return {
        **window_params(days, start_date, end_date),
        "account_name": None if not name or name == "All" else name,
        "service_type": None if not service or service == "All" else service,
        "usage_type": (
            usage_type if usage_type in ("All", "Compute", "Cloud Services") else "Compute"
        ),
    }


def _sanitize(value: Any) -> Any:
    """JSONB rejects NaN/Infinity; Snowflake frames can carry them."""
    if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
        return None
    if isinstance(value, dict):
        return {k: _sanitize(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_sanitize(v) for v in value]
    return value


def _with_meta(payload: dict, fetched_at: datetime, cached: bool) -> dict:
    return {**payload, "cached": cached, "fetched_at": fetched_at.isoformat()}


def cached_fetch(
    connection_id: int,
    dataset: str,
    params: dict | None = None,
    *,
    creds: dict | None = None,
    force: bool = False,
) -> dict:
    """Serve from Postgres unless missing or forced; then query Snowflake and store."""
    params = params or {}
    key = params_key(params)
    if not force:
        hit = db.get_cache(connection_id, dataset, key)
        if hit is not None:
            return _with_meta(hit["payload"], hit["fetched_at"], True)

    if creds is None:
        creds = db.get_connection_credentials(connection_id)
    payload = _sanitize(jsonable_encoder(DATASETS[dataset](creds, params)))
    fetched_at = db.upsert_cache(connection_id, dataset, key, json.dumps(payload))
    return _with_meta(payload, fetched_at, False)


def store(connection_id: int, dataset: str, params: dict | None, payload: dict) -> None:
    """Persist a payload obtained elsewhere (e.g. discover before the connection existed)."""
    clean = _sanitize(jsonable_encoder(payload))
    db.upsert_cache(connection_id, dataset, params_key(params or {}), json.dumps(clean))


def default_jobs(today: date | None = None) -> list[tuple[str, dict]]:
    """Datasets every screen loads with its default filters."""
    today = today or datetime.now(timezone.utc).date()
    # Cost Management opens on the 7-day preset; Início uses a plain 28-day window.
    start7 = (today - timedelta(days=6)).isoformat()
    end = today.isoformat()
    win7 = window_params(7, start7, end)
    return [
        ("options", {}),
        ("resource_monitors", {}),
        ("budgets", {}),
        ("service_types", {}),
        ("org_accounts", window_params(28, None, None)),
        ("org_accounts", win7),
        (
            "org_consumption",
            org_consumption_params(
                days=7,
                start_date=start7,
                end_date=end,
                account_name=None,
                service_type="WAREHOUSE_METERING",
                usage_type="Compute",
            ),
        ),
        (
            "consumption",
            consumption_params(
                days=7,
                start_date=start7,
                end_date=end,
                usage_type="Compute",
                service_type="WAREHOUSE_METERING",
                resource_name=None,
                grain="day",
            ),
        ),
        ("account_overview", win7),
        ("anomalies", win7),
        ("organization_overview", win7),
    ]


def refresh_connection(connection_id: int, creds: dict) -> list[dict]:
    """Re-query every default dataset plus every key used in the last 24h, in parallel."""
    jobs: dict[tuple[str, str], tuple[str, dict]] = {}
    for dataset, params in default_jobs():
        jobs[(dataset, params_key(params))] = (dataset, params)
    for row in db.list_recent_cache_keys(connection_id, hours=24):
        if row["dataset"] not in DATASETS:
            continue
        try:
            params = json.loads(row["params_key"] or "{}")
        except ValueError:
            continue
        jobs[(row["dataset"], params_key(params))] = (row["dataset"], params)

    results: list[dict] = []
    with ThreadPoolExecutor(max_workers=4) as executor:
        futures = {
            executor.submit(
                cached_fetch, connection_id, dataset, params, creds=creds, force=True
            ): (dataset, params)
            for dataset, params in jobs.values()
        }
        for future in as_completed(futures):
            dataset, params = futures[future]
            entry = {"dataset": dataset, "params_key": params_key(params), "ok": True, "error": None}
            try:
                payload = future.result()
                if dataset == "options":
                    entry["payload"] = payload
            except Exception as exc:  # noqa: BLE001
                logger.warning("refresh %s %s failed: %s", connection_id, dataset, str(exc)[:200])
                entry.update(ok=False, error=str(exc)[:300])
            results.append(entry)

    db.purge_stale_cache(connection_id, days=7)
    return results
