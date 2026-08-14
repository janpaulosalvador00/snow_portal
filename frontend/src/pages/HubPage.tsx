import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  api,
  ApiError,
  getActiveConnectionId,
  isAbortError,
  setActiveConnectionId,
} from "../api/client";
import { CostSkeleton } from "../components/cost/CostChrome";
import { ErrorBanner } from "../components/cost/ErrorBanner";
import { MonitorsPanel } from "../components/cost/MonitorsPanel";
import type { Monitor } from "../components/cost/MonitorsTable";

type Conn = {
  id: number;
  name: string;
  account_identifier: string;
  role_name?: string | null;
};

type MonitorsResp = {
  items: Monitor[];
  note: string | null;
};

export function HubPage() {
  const [connections, setConnections] = useState<Conn[]>([]);
  const [activeId, setActiveId] = useState<number | null>(getActiveConnectionId());
  const [monitors, setMonitors] = useState<MonitorsResp | null>(null);
  const [monitorsErr, setMonitorsErr] = useState<string | null>(null);
  const [monitorsLoading, setMonitorsLoading] = useState(false);
  const loadAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    void api<Conn[]>("/api/connections")
      .then((list) => {
        setConnections(list);
        const stored = getActiveConnectionId();
        if (stored && list.some((c) => c.id === stored)) {
          setActiveId(stored);
        } else if (stored && !list.some((c) => c.id === stored)) {
          setActiveConnectionId(null);
          setActiveId(null);
        } else {
          setActiveId(stored);
        }
      })
      .catch(() => setConnections([]));
  }, []);

  async function loadMonitors(connectionId: number) {
    loadAbortRef.current?.abort();
    const ac = new AbortController();
    loadAbortRef.current = ac;
    const { signal } = ac;

    setMonitorsLoading(true);
    setMonitorsErr(null);
    try {
      const res = await api<MonitorsResp>(
        `/api/cost/resource-monitors?connection_id=${connectionId}`,
        { signal },
      );
      if (signal.aborted) return;
      setMonitors(res);
    } catch (e) {
      if (signal.aborted || isAbortError(e)) return;
      setMonitors(null);
      setMonitorsErr(
        e instanceof ApiError ? e.message : "Falha ao carregar Resource Monitors.",
      );
    } finally {
      if (loadAbortRef.current === ac) setMonitorsLoading(false);
    }
  }

  useEffect(() => {
    if (activeId == null) {
      loadAbortRef.current?.abort();
      loadAbortRef.current = null;
      setMonitors(null);
      setMonitorsErr(null);
      setMonitorsLoading(false);
      return;
    }
    const t = window.setTimeout(() => void loadMonitors(activeId), 150);
    return () => {
      window.clearTimeout(t);
      loadAbortRef.current?.abort();
    };
  }, [activeId]);

  const active = connections.find((c) => c.id === activeId);
  const canSelect = connections.length > 1;

  function onSelectActive(value: string) {
    if (!value) {
      setActiveConnectionId(null);
      setActiveId(null);
      return;
    }
    const id = Number(value);
    if (!Number.isFinite(id) || !connections.some((c) => c.id === id)) return;
    setActiveConnectionId(id);
    setActiveId(id);
  }

  return (
    <div>
      <h1>Snow Portal</h1>
      <p className="muted">Controle de créditos Snowflake para o time de suporte.</p>

      <div className="metrics">
        <div className="metric">
          <span className="muted">Conexões</span>
          <strong>{connections.length}</strong>
        </div>
        <div className="metric">
          <span className="muted">Role da conexão</span>
          <strong>{active?.role_name?.trim() || "—"}</strong>
        </div>
        <div className="metric">
          <span className="muted">Conta ativa</span>
          {canSelect ? (
            <select
              className="metric-select"
              value={activeId != null ? String(activeId) : ""}
              onChange={(e) => onSelectActive(e.target.value)}
              aria-label="Conta ativa"
            >
              {!activeId ? (
                <option value="">Selecionar…</option>
              ) : null}
              {connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          ) : (
            <strong>{active ? active.name : "Nenhuma"}</strong>
          )}
        </div>
      </div>

      <section className="hub-monitors" aria-labelledby="hub-monitors-title">
        <h2 id="hub-monitors-title" className="hub-section-title">
          Resource Monitors
        </h2>

        {activeId == null ? (
          <p className="muted hub-monitors-hint">
            Nenhuma conta ativa. Vá em <Link to="/conexoes">Conexões</Link> e ative uma conta
            para ver os resource monitors.
          </p>
        ) : (
          <>
            {monitorsErr ? (
              <ErrorBanner message={monitorsErr} connectionId={activeId} />
            ) : null}
            {monitorsLoading && !monitorsErr && !monitors ? <CostSkeleton /> : null}
            {monitors ? (
              <div className={`cost-tab-body${monitorsLoading ? " is-refreshing" : ""}`}>
                <MonitorsPanel
                  items={monitors.items || []}
                  note={monitors.note}
                  onRefresh={() => void loadMonitors(activeId)}
                  loading={monitorsLoading}
                />
              </div>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}
