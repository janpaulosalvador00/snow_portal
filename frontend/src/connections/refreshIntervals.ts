/** Shared Contas salvas / per-connection auto-refresh interval helpers. */

export const CONNECTIONS_GLOBAL_INTERVAL_KEY = "snow_portal_connections_global_interval";

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

/** Per-connection select: minutes as string, or "global". */
export const CONN_INTERVAL_OPTIONS = [
  ["1", "1 min"],
  ["5", "5 min"],
  ["10", "10 min"],
  ["15", "15 min"],
  ["30", "30 min"],
  ["60", "60 min"],
  ["global", "Global"],
] as const;

export type ConnIntervalValue = (typeof CONN_INTERVAL_OPTIONS)[number][0];

export function loadGlobalInterval(): string {
  return localStorage.getItem(CONNECTIONS_GLOBAL_INTERVAL_KEY) || "1800";
}

export function intervalToSelectValue(minutes: number | null | undefined): ConnIntervalValue {
  if (minutes == null) return "global";
  const s = String(minutes);
  return CONN_INTERVAL_OPTIONS.some(([v]) => v === s)
    ? (s as ConnIntervalValue)
    : "global";
}

export function selectValueToMinutes(value: string): number | null {
  if (value === "global" || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function connIntervalBadge(minutes: number | null | undefined): string {
  if (minutes == null) return "Global";
  return `${minutes} min`;
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
