"""ACCOUNT_USAGE metering queries for Cost Management → Consumption."""
from __future__ import annotations

import pandas as pd

from backend.lib.snowflake_client import run_query

# Friendly labels for common SERVICE_TYPE values
SERVICE_TYPE_LABELS = {
    "WAREHOUSE_METERING": "Warehouse",
    "CLOUD_SERVICES_ONLY": "Cloud Services",
    "AI_SERVICES": "AI Services",
    "AI_INFERENCE": "AI Inference",
    "SNOWPARK_CONTAINER_SERVICES": "Snowpark Container Services",
    "COMPUTE_POOL": "Compute Pool",
    "AUTO_CLUSTERING": "Automatic Clustering",
    "MATERIALIZED_VIEW": "Materialized Views",
    "PIPE": "Snowpipe",
    "QUERY_ACCELERATION": "Query Acceleration",
    "REPLICATION": "Replication",
    "SEARCH_OPTIMIZATION": "Search Optimization",
    "SERVERLESS_TASK": "Serverless Tasks",
    "CORTEX_ANALYST": "Cortex Analyst",
}


def _label_service(service_type: str | None) -> str:
    if not service_type:
        return "—"
    return SERVICE_TYPE_LABELS.get(service_type, service_type.replace("_", " ").title())


def _consumption_sql(grain: str, *, absolute_range: bool = False) -> str:
    # grain is validated by caller; never interpolate untrusted input
    if absolute_range:
        time_clause = "START_TIME >= %s AND START_TIME < %s"
    else:
        time_clause = "START_TIME >= DATEADD('day', %s, CURRENT_TIMESTAMP())"
    return f"""
SELECT
    COALESCE(NULLIF(TRIM(NAME), ''), SERVICE_TYPE, 'UNKNOWN') AS resource_name,
    SERVICE_TYPE,
    DATE_TRUNC('{grain}', START_TIME) AS period_start,
    SUM(CREDITS_USED) AS credits_used,
    SUM(CREDITS_USED_COMPUTE) AS credits_compute,
    SUM(CREDITS_USED_CLOUD_SERVICES) AS credits_cloud
FROM SNOWFLAKE.ACCOUNT_USAGE.METERING_HISTORY
WHERE {time_clause}
  AND (%s IS NULL OR SERVICE_TYPE = %s)
  AND (%s IS NULL OR COALESCE(NULLIF(TRIM(NAME), ''), SERVICE_TYPE) = %s)
GROUP BY 1, 2, 3
ORDER BY credits_used DESC
"""


def fetch_consumption(
    *,
    account: str,
    user: str,
    password: str | None = None,
    auth_method: str = "pat",
    authenticator_url: str | None = None,
    days: int = 28,
    grain: str = "day",
    service_type: str | None = None,
    resource_name: str | None = None,
    usage_type: str = "Compute",
    warehouse: str | None = None,
    role: str | None = None,
) -> pd.DataFrame:
    if grain not in ("day", "month", "hour"):
        grain = "day"
    days = int(days)

    df = run_query(
        account=account,
        user=user,
        auth_method=auth_method,
        password=password,
        authenticator_url=authenticator_url,
        warehouse=warehouse,
        role=role,
        sql=_consumption_sql(grain, absolute_range=False),
        params=(-days, service_type, service_type, resource_name, resource_name),
    )

    if df.empty:
        return df

    # Normalize column names (Snowflake may return uppercase)
    df.columns = [c.lower() for c in df.columns]
    df["type_label"] = df["service_type"].map(_label_service)
    df["tags"] = "—"

    if usage_type == "Compute":
        df["credits_display"] = df["credits_compute"].fillna(0)
    elif usage_type == "Cloud Services":
        df["credits_display"] = df["credits_cloud"].fillna(0)
    else:
        df["credits_display"] = df["credits_used"].fillna(0)

    return df


def summarize_by_resource(df: pd.DataFrame) -> pd.DataFrame:
    if df.empty:
        return df
    summary = (
        df.groupby(["resource_name", "service_type", "type_label", "tags"], dropna=False)["credits_display"]
        .sum()
        .reset_index()
        .rename(columns={"credits_display": "credits_used"})
        .sort_values("credits_used", ascending=False)
    )
    return summary


def chart_frame(df: pd.DataFrame) -> pd.DataFrame:
    if df.empty:
        return df
    chart = (
        df.groupby(["period_start", "resource_name"], dropna=False)["credits_display"]
        .sum()
        .reset_index()
    )
    return chart
