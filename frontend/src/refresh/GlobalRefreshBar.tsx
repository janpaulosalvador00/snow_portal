import { useEffect, useRef, useState } from "react";
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
  const [infoOpen, setInfoOpen] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const globalSeconds = Number(globalInterval);
  const off = !(globalSeconds > 0);
  // Alerts: next ? dateTimeLabel(next) : "Auto desligada" — but only when off here,
  // so a linked Global never reads as desligado before the first refresh.
  const nextLabel = off
    ? "— (auto-refresh desligado)"
    : nextGlobalRefreshAt
      ? dateTimeLabel(nextGlobalRefreshAt)
      : "—";

  useEffect(() => {
    if (!infoOpen) return;
    const opener = document.activeElement as HTMLElement | null;
    document.body.classList.add("modal-open");
    closeRef.current?.focus();
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        setInfoOpen(false);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.classList.remove("modal-open");
      if (opener && document.contains(opener)) opener.focus();
    };
  }, [infoOpen]);

  return (
    <>
      <div
        className="global-refresh"
        role="group"
        aria-label="Intervalo global de atualização"
      >
        <div className="global-refresh-main">
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
          <button
            type="button"
            className="global-refresh-info"
            aria-label="Sobre intervalo Global e por conexão"
            aria-haspopup="dialog"
            aria-expanded={infoOpen}
            onClick={() => setInfoOpen(true)}
          >
            <span className="global-refresh-info-icon" aria-hidden>
              i
            </span>
          </button>
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

      {infoOpen ? (
        <div className="conn-modal-root">
          <div
            className="conn-modal-backdrop"
            aria-hidden
            onClick={() => setInfoOpen(false)}
          />
          <div
            className="conn-modal global-refresh-info-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="global-refresh-info-title"
          >
            <header className="conn-modal-header">
              <div>
                <h2 id="global-refresh-info-title">Intervalo Global</h2>
              </div>
              <button
                ref={closeRef}
                type="button"
                className="conn-modal-close"
                aria-label="Fechar"
                onClick={() => setInfoOpen(false)}
              >
                ×
              </button>
            </header>
            <div className="conn-modal-body">
              <p className="global-refresh-info-text">
                <strong>Intervalo por conexão:</strong> badge no card mostra o valor
                próprio (ex. <em>15 min</em>), <em>Global</em> (segue o controle
                acima) ou <em>Desligada</em> (sem auto-refresh nesta conexão). Com
                Global em <em>Desligada</em>, conexões no modo Global também ficam
                pausadas. Contas <em>Inativas</em> não entram no auto-refresh.
              </p>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
