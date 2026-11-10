import type {
  InventoryToken,
  InventoryTokenStatus,
  InventoryTokenType,
} from "../api/tokenInventory";

export const TYPE_LABELS: Record<InventoryTokenType, string> = {
  oauth_access: "OAuth access",
  oauth_refresh: "OAuth refresh",
  pat: "PAT",
  password: "Senha",
  private_key: "Chave privada",
};

export const STATUS_LABELS: Record<InventoryTokenStatus, string> = {
  active: "Ativo",
  expired: "Expirado",
  revoked: "Revogado",
};

export const SOURCE_LABELS: Record<string, string> = {
  oauth: "login OAuth",
  typed: "digitado",
  upload: "arquivo enviado",
  folder: "pasta de tokens",
  saved_token: "token salvo",
};

export const EXPIRING_SOON_MS = 7 * 24 * 60 * 60 * 1000;

const absoluteFormat = new Intl.DateTimeFormat("pt-BR", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
const relativeFormat = new Intl.RelativeTimeFormat("pt-BR", { numeric: "auto" });

export function formatAbsolute(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : absoluteFormat.format(d);
}

export function formatRelative(iso: string, now: number): string {
  const diffSec = (new Date(iso).getTime() - now) / 1000;
  const abs = Math.abs(diffSec);
  if (abs < 60) return relativeFormat.format(Math.round(diffSec), "second");
  if (abs < 3600) return relativeFormat.format(Math.round(diffSec / 60), "minute");
  if (abs < 86400) return relativeFormat.format(Math.round(diffSec / 3600), "hour");
  if (abs < 86400 * 60) return relativeFormat.format(Math.round(diffSec / 86400), "day");
  return relativeFormat.format(Math.round(diffSec / (86400 * 30)), "month");
}

export function expiryTone(token: InventoryToken, now: number): "past" | "soon" | "ok" {
  if (!token.expires_at) return "ok";
  const ms = new Date(token.expires_at).getTime() - now;
  if (ms <= 0) return "past";
  return ms <= EXPIRING_SOON_MS ? "soon" : "ok";
}

export function statusBadgeClass(status: InventoryTokenStatus): string {
  if (status === "active") return "is-active";
  if (status === "expired") return "is-token-expired";
  return "is-inactive";
}

export function connectionLabel(token: InventoryToken): string {
  return token.connection?.name || token.connection_name || `Conexão #${token.connection_id}`;
}

/** ISO -> value for <input type="datetime-local"> in the browser's time zone. */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/** <input type="datetime-local"> value -> ISO (UTC), or null when empty/invalid. */
export function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** End of the day `days` from now, as a datetime-local value. */
export function daysFromNowInput(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(23, 59, 0, 0);
  return toLocalInput(d.toISOString());
}
