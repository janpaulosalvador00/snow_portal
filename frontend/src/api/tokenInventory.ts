import { api } from "./client";

export type InventoryTokenType =
  | "oauth_access"
  | "oauth_refresh"
  | "pat"
  | "password"
  | "private_key";

export type InventoryTokenStatus = "active" | "expired" | "revoked";

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
  expiry_note: string | null;
  last_refreshed_at: string | null;
  revoked_at: string | null;
  file_name: string | null;
  source: string | null;
  source_file: string | null;
  updated_at: string | null;
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

export function getTokenInventory(opts: { includeRevoked: boolean; signal?: AbortSignal }) {
  const qs = opts.includeRevoked ? "?include_revoked=true" : "";
  return api<TokenInventoryResponse>(`/api/tokens${qs}`, { signal: opts.signal });
}
