import { api } from "./client";
import type { SecretPayload } from "./tokens";

export type InventoryTokenType =
  | "oauth_access"
  | "oauth_refresh"
  | "pat"
  | "password"
  | "private_key";

export type InventoryTokenStatus = "active" | "expired" | "revoked";

/** Per-token edits the API allows (computed server-side from type, method and status). */
export type InventoryTokenActions = {
  replace_secret: boolean;
  edit_connection: boolean;
  set_expiry: boolean;
  refresh: boolean;
  reconnect: boolean;
  revoke: boolean;
  delete: boolean;
};

export type InventoryToken = {
  id: number;
  connection_id: number;
  connection_name: string | null;
  connection_exists: boolean;
  team_name: string | null;
  account_identifier: string | null;
  username: string | null;
  role_name: string | null;
  auth_method: string | null;
  auth_method_label: string | null;
  token_type: InventoryTokenType;
  status: InventoryTokenStatus;
  fingerprint_short: string | null;
  issued_at: string | null;
  expires_at: string | null;
  expires_at_source: "provider" | "manual" | null;
  expiry_note: string | null;
  last_refreshed_at: string | null;
  revoked_at: string | null;
  file_name: string | null;
  source: string | null;
  source_file: string | null;
  updated_at: string | null;
  /** Current connection settings (null when the connection was removed). */
  connection: {
    name: string | null;
    username: string | null;
    auth_method: string | null;
    warehouse: string | null;
    role_name: string | null;
    has_secret: boolean;
  } | null;
  actions: InventoryTokenActions;
};

export type TokenInventoryResponse = {
  tokens: InventoryToken[];
  summary: {
    active: number;
    expired: number;
    revoked: number;
    expiring_soon: number;
    total: number;
  };
  server_time: string;
  last_sweep: { checked_at?: string } | null;
  sweep_interval_sec: number;
};

export type TokenMutationResponse = {
  ok: boolean;
  message: string;
  token: InventoryToken | null;
};

export function getTokenInventory(opts: { includeRevoked: boolean; signal?: AbortSignal }) {
  const qs = opts.includeRevoked ? "?include_revoked=true" : "";
  return api<TokenInventoryResponse>(`/api/tokens${qs}`, { signal: opts.signal });
}

export function replaceTokenSecret(
  id: number,
  payload: SecretPayload & { expires_at?: string | null },
) {
  return api<TokenMutationResponse>(`/api/tokens/${id}/secret`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function editTokenConnection(
  id: number,
  payload: { name?: string; username?: string; role_name?: string; warehouse?: string },
) {
  return api<TokenMutationResponse>(`/api/tokens/${id}/connection`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export function setTokenExpiry(id: number, expiresAt: string | null) {
  return api<TokenMutationResponse>(`/api/tokens/${id}/expiry`, {
    method: "PUT",
    body: JSON.stringify({ expires_at: expiresAt }),
  });
}

export function revokeToken(id: number) {
  return api<TokenMutationResponse>(`/api/tokens/${id}/revoke`, {
    method: "POST",
    body: JSON.stringify({ confirm: true }),
  });
}

export function deleteTokenRecord(id: number) {
  return api<{ ok: boolean; message: string }>(`/api/tokens/${id}`, { method: "DELETE" });
}

export function refreshOAuthToken(id: number) {
  return api<TokenMutationResponse>(`/api/tokens/${id}/refresh`, { method: "POST" });
}

export function startOAuthReconnect(token: InventoryToken) {
  const conn = token.connection;
  return api<{ authorize_url: string }>("/api/connections/oauth/start", {
    method: "POST",
    body: JSON.stringify({
      connection_id: token.connection_id,
      account_identifier: token.account_identifier,
      username: conn?.username || token.username,
      name: conn?.name || token.connection_name,
      warehouse: conn?.warehouse || null,
      role_name: conn?.role_name || null,
      return_to: "/tokens",
    }),
  });
}

export type ConnectionOptions = {
  warehouses: { name: string; state?: string | null; suggested?: boolean }[];
  roles: string[];
  cached?: boolean;
  fetched_at?: string | null;
};

export function getConnectionOptions(connectionId: number, refresh = false) {
  return api<ConnectionOptions>(
    `/api/connections/${connectionId}/options${refresh ? "?refresh=1" : ""}`,
  );
}
