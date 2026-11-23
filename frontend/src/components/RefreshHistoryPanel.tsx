import { useCallback, useEffect, useState } from "react";
import {
  getRefreshHistory,
  isRefreshHistoryUnavailable,
  type RefreshHistoryItem,
} from "../api/refreshHistory";
import { ApiError, isAbortError } from "../api/client";
import { dateTimeLabel } from "../connections/refreshIntervals";
import { useRefresh } from "../refresh/RefreshContext";

/** Retry while sibling GET `/api/connections/refresh-history` is still missing. */
const RETRY_MS = 15_000;

function connectionLabel(row: RefreshHistoryItem): string {
  const name = row.connection_name?.trim() || row.name?.trim();
  if (name) return name;
  if (row.scope === "global" && row.connection_id == null) return "Global";
  if (row.connection_id != null) return `Conexão #${row.connection_id}`;
  return "—";
}

function intervalLabel(minutes: number | null | undefined): string {
  if (minutes == null) return "Global";
  if (minutes === 0) return "Desligada";
  return `${minutes} min`;
}

export function RefreshHistoryPanel() {
  const { refreshToken } = useRefresh();
  const [items, setItems] = useState<RefreshHistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [apiPending, setApiPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await getRefreshHistory({ limit: 200, signal });
      if (signal?.aborted) return;
      setItems(res.items);
      setApiPending(false);
      setError(null);
    } catch (e) {
      if (signal?.aborted || isAbortError(e)) return;
      if (isRefreshHistoryUnavailable(e)) {
        // TODO(backend-sibling): remove stub once GET refresh-history is live.
        setItems([]);
        setApiPending(true);
        setError(null);
        return;
      }
      setError(
        e instanceof ApiError
          ? e.message
          : "Não foi possível carregar o histórico de atualizações.",
      );
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    void load(ac.signal);
    return () => ac.abort();
  }, [load, refreshToken]);

  // Re-try until the backend route exists.
  useEffect(() => {
    if (!apiPending) return;
    const id = window.setInterval(() => {
      void load();
    }, RETRY_MS);
    return () => window.clearInterval(id);
  }, [apiPending, load]);

  if (loading && !items.length) {
    return <div className="info-box">Carregando histórico…</div>;
  }

  if (error) {
    return (
      <div className="error-box" role="alert">
        {error}
      </div>
    );
  }

  if (!items.length) {
    return (
      <div className="info-box refresh-history-empty" role="status">
        <strong>Nenhum registro ainda.</strong>
        <p>
          O histórico de cargas começa a ser gravado a partir de agora — cada
          atualização bem-sucedida (manual ou automática) aparece aqui com a
          última carga e a próxima prevista.
        </p>
        {apiPending ? (
          <p className="muted refresh-history-pending">
            Aguardando API de histórico… nova tentativa automática em breve.
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="refresh-history">
      <p className="muted refresh-history-lead">
        Registro append-only das cargas de dados (Última / Próxima) por conexão.
      </p>
      <div
        className="table refresh-history-table"
        role="table"
        aria-label="Histórico de atualizações"
      >
        <div className="table-head" role="row">
          <span role="columnheader">Registro</span>
          <span role="columnheader">Conexão</span>
          <span role="columnheader">Última carga</span>
          <span role="columnheader">Próxima prevista</span>
          <span role="columnheader">Intervalo</span>
        </div>
        {items.map((row) => (
          <div key={row.id} className="table-row" role="row">
            <span role="cell">{dateTimeLabel(row.created_at || row.last_refresh_at)}</span>
            <span role="cell" className="refresh-history-conn">
              {connectionLabel(row)}
              {row.scope === "global" ? (
                <span className="badge interval interval-global">Global</span>
              ) : null}
            </span>
            <span role="cell">{dateTimeLabel(row.last_refresh_at)}</span>
            <span role="cell">
              {row.next_refresh_at
                ? dateTimeLabel(row.next_refresh_at)
                : "—"}
            </span>
            <span role="cell">{intervalLabel(row.interval_minutes)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
