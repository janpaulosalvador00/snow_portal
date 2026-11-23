import { api, ApiError } from "./client";

/**
 * Contract with backend GET `/api/connections/refresh-history`
 * (table `connection_refresh_history`).
 *
 * TODO(backend-sibling): confirm response envelope when GET lands —
 * today schema exists; router may still be missing (404/405 → stub retry).
 */
export type RefreshHistoryScope = "connection" | "global";

export type RefreshHistoryItem = {
  id: number;
  connection_id: number | null;
  connection_name?: string | null;
  name?: string | null;
  last_refresh_at: string;
  next_refresh_at: string | null;
  interval_minutes: number | null;
  scope: RefreshHistoryScope;
  created_at: string;
};

export type RefreshHistoryResponse = {
  items: RefreshHistoryItem[];
};

const PATH = "/api/connections/refresh-history";

function normalizeItems(data: unknown): RefreshHistoryItem[] {
  if (Array.isArray(data)) return data as RefreshHistoryItem[];
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.items)) return obj.items as RefreshHistoryItem[];
    if (Array.isArray(obj.history)) return obj.history as RefreshHistoryItem[];
    if (Array.isArray(obj.rows)) return obj.rows as RefreshHistoryItem[];
  }
  return [];
}

/** True when the GET route is not ready yet (sibling backend still wiring). */
export function isRefreshHistoryUnavailable(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  return error.status === 404 || error.status === 405 || error.status === 501;
}

/**
 * List append-only refresh events visible to the current user.
 * Query: connection_id, limit, from, to (all optional).
 */
export async function getRefreshHistory(options: {
  connectionId?: number;
  limit?: number;
  from?: string;
  to?: string;
  signal?: AbortSignal;
} = {}): Promise<RefreshHistoryResponse> {
  const params = new URLSearchParams();
  if (options.connectionId != null) {
    params.set("connection_id", String(options.connectionId));
  }
  if (options.limit != null) params.set("limit", String(options.limit));
  if (options.from) params.set("from", options.from);
  if (options.to) params.set("to", options.to);
  const query = params.toString();
  const data = await api<unknown>(`${PATH}${query ? `?${query}` : ""}`, {
    signal: options.signal,
  });
  return { items: normalizeItems(data) };
}
