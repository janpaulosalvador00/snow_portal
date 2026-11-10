import { api } from "./client";

export type AlertMonitor = {
  name: string;
  quota_used_pct: number | null;
  credit_quota: number | null;
  used_credits: number | null;
  remaining_credits: number | null;
  level: string;
  frequency: string;
  warehouses: string[];
  start_time: string | null;
};

export type AlertClient = {
  id: number;
  name: string;
  account_identifier: string;
  status: "active" | "disabled";
  error: string | null;
  note: string | null;
  monitors: AlertMonitor[];
  max_quota_used_pct: number | null;
  fetched_at?: string | null;
};

export type AlertsResponse = {
  fetched_at: string;
  total_connections: number;
  active_connections: number;
  disabled_accounts: number;
  critical_clients: number;
  clients: AlertClient[];
};

export const ALERTS_BADGE_EVENT = "snow-portal:alerts-badge";

let cached: AlertsResponse | null = null;
let pending: Promise<AlertsResponse> | null = null;

export function announceAlertsBadge(count: number) {
  window.dispatchEvent(new CustomEvent(ALERTS_BADGE_EVENT, { detail: count }));
}

export async function getAlerts(
  options: { force?: boolean; connectionIds?: number[]; refreshIds?: number[] } = {},
): Promise<AlertsResponse> {
  const ids = options.connectionIds;
  const isFullRequest = !ids?.length;

  if (isFullRequest && !options.force && cached) return cached;
  if (isFullRequest && !options.force && pending) return pending;

  // connection_id narrows the response; refresh_id forces Snowflake (otherwise Postgres cache).
  const params = [
    ...(ids || []).map((id) => `connection_id=${encodeURIComponent(id)}`),
    ...(options.refreshIds || []).map((id) => `refresh_id=${encodeURIComponent(id)}`),
  ];
  const query = params.length ? `?${params.join("&")}` : "";
  const request = api<AlertsResponse>(`/api/alerts${query}`);
  if (isFullRequest) pending = request;

  try {
    const response = await request;
    if (isFullRequest) {
      cached = response;
      announceAlertsBadge(response.critical_clients);
    }
    return response;
  } finally {
    if (isFullRequest && pending === request) pending = null;
  }
}
