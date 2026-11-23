/** Shared Contas salvas / per-connection auto-refresh interval helpers. */

export const CONNECTIONS_GLOBAL_INTERVAL_KEY = "snow_portal_connections_global_interval";
/** ISO timestamp of last Contas salvas / ↻ refresh (same role as Alerts `fetched_at`). */
export const CONNECTIONS_LAST_REFRESHED_KEY = "snow_portal_connections_last_refreshed_at";

/** localStorage values in seconds (same shape as AlertsPage). */
export const GLOBAL_INTERVAL_OPTIONS = [
  ["0", "Desligada"],
  ["60", "1 min"],
  ["300", "5 min"],
  ["600", "10 min"],
  ["900", "15 min"],
  ["1800", "30 min"],
  ["3600", "60 min"],
] as const;

/**
 * Per-connection select: minutes as string, "global" (null), or "0" (Desligada).
 * Contract: null = Global, 0 = Desligada, 1..60 = minutes.
 */
export const CONN_INTERVAL_OPTIONS = [
  ["1", "1 min"],
  ["5", "5 min"],
  ["10", "10 min"],
  ["15", "15 min"],
  ["30", "30 min"],
  ["60", "60 min"],
  ["global", "Global"],
  ["0", "Desligada"],
] as const;

export type ConnIntervalValue = (typeof CONN_INTERVAL_OPTIONS)[number][0];

export function loadGlobalInterval(): string {
  return localStorage.getItem(CONNECTIONS_GLOBAL_INTERVAL_KEY) || "1800";
}

export function loadLastRefreshedAt(): string | null {
  return localStorage.getItem(CONNECTIONS_LAST_REFRESHED_KEY);
}

/**
 * Next auto-refresh instant — same formula as AlertsPage header:
 * `last && globalSeconds ? last + globalSeconds : null`.
 */
export function computeNextRefreshAt(
  lastIso: string | null,
  globalSeconds: number,
): string | null {
  if (!lastIso || !(globalSeconds > 0)) return null;
  const base = Date.parse(lastIso);
  if (Number.isNaN(base)) return null;
  return new Date(base + globalSeconds * 1000).toISOString();
}

export function intervalToSelectValue(minutes: number | null | undefined): ConnIntervalValue {
  if (minutes == null) return "global";
  if (minutes === 0) return "0";
  const s = String(minutes);
  return CONN_INTERVAL_OPTIONS.some(([v]) => v === s)
    ? (s as ConnIntervalValue)
    : "global";
}

/** null = Global; 0 = Desligada; positive = minutes. */
export function selectValueToMinutes(value: string): number | null {
  if (value === "global" || value === "") return null;
  if (value === "0") return 0;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function connIntervalBadge(minutes: number | null | undefined): string {
  if (minutes == null) return "Global";
  if (minutes === 0) return "Desligada";
  return `${minutes} min`;
}

/** CSS modifier for Contas salvas interval badge. */
export function connIntervalBadgeClass(minutes: number | null | undefined): string {
  if (minutes == null) return "badge interval interval-global";
  if (minutes === 0) return "badge interval interval-off";
  return "badge interval";
}

export function connIntervalTitle(minutes: number | null | undefined): string | undefined {
  if (minutes == null) return "Usa o intervalo Global da lista";
  if (minutes === 0) return "Auto-refresh desligado nesta conexão";
  return undefined;
}

export function dateTimeLabel(value: string | number | Date | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return `${date.toLocaleDateString("pt-BR")} ${date.toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

export function globalIntervalHelp(globalSeconds: number): string {
  if (globalSeconds <= 0) {
    return "hoje Desligada: esta conexão não atualiza automaticamente";
  }
  return `hoje: ${globalSeconds / 60} min`;
}
