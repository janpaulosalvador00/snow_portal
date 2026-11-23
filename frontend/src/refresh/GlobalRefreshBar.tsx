import {
  GLOBAL_INTERVAL_OPTIONS,
  dateTimeLabel,
} from "../connections/refreshIntervals";
import { useRefresh } from "./RefreshContext";

/**
 * Contas salvas — Última / Próxima atualização + intervalo Global (localStorage).
 * Mount on ConnectionsPage hub tab, above the connections grid:
 *   {tab === "hub" ? <GlobalRefreshBar /> : null}
 */
export function GlobalRefreshBar() {
  const {
    lastRefreshedAt,
    nextGlobalRefreshAt,
    globalInterval,
    setGlobalInterval,
  } = useRefresh();
  const off = Number(globalInterval) <= 0;

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
          <span className="val val-next">
            {off || !nextGlobalRefreshAt
              ? "— (auto-refresh desligado)"
              : dateTimeLabel(nextGlobalRefreshAt)}
          </span>
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
