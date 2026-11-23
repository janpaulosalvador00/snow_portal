import {
  GLOBAL_INTERVAL_OPTIONS,
  dateTimeLabel,
} from "../connections/refreshIntervals";
import { useRefresh } from "./RefreshContext";

/**
 * Contas salvas — Última / Próxima + intervalo Global.
 * Timestamps mirror AlertsPage: last from refresh (`refreshed_at` / localStorage),
 * next = last + globalSeconds when Global > 0; "desligado" only when Global is 0.
 */
export function GlobalRefreshBar() {
  const {
    lastRefreshedAt,
    nextGlobalRefreshAt,
    globalInterval,
    setGlobalInterval,
  } = useRefresh();
  const globalSeconds = Number(globalInterval);
  const off = !(globalSeconds > 0);
  // Alerts: next ? dateTimeLabel(next) : "Auto desligada" — but only when off here,
  // so a linked Global never reads as desligado before the first refresh.
  const nextLabel = off
    ? "— (auto-refresh desligado)"
    : nextGlobalRefreshAt
      ? dateTimeLabel(nextGlobalRefreshAt)
      : "—";

  return (
    <div
      className="global-refresh"
      role="group"
      aria-label="Intervalo global de atualização"
    >
      <div
        className={`global-refresh-times${off ? " is-off" : ""}`}
        role="status"
        aria-live="polite"
      >
        <div className="row">
          <span className="lbl">Última atualização</span>
          <span className="val">{dateTimeLabel(lastRefreshedAt)}</span>
        </div>
        <div className="row">
          <span className="lbl">Próxima atualização</span>
          <span className="val val-next">{nextLabel}</span>
        </div>
      </div>
      <label className="global-refresh-field">
        <span className="sr-only">Intervalo global de atualização</span>
        <select
          value={globalInterval}
          onChange={(e) => setGlobalInterval(e.target.value)}
        >
          {GLOBAL_INTERVAL_OPTIONS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
