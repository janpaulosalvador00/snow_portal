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
  warehouse?: string | null;
  role_name?: string | null;
};

type MonitorsResp = {
  items: Monitor[];
  account_name?: string | null;
  note: string | null;
};

type OrgAccountsResp = {
  available: boolean;
  accounts: string[];
  note: string | null;
};

export function HubPage() {
  const [connections, setConnections] = useState<Conn[]>([]);
  const [activeId, setActiveId] = useState<number | null>(getActiveConnectionId());
  const [monitors, setMonitors] = useState<Monitor[]>([]);
  /** Authoritative Account filter options (All Accounts + these). Same source as Consumption. */
  const [orgAccountNames, setOrgAccountNames] = useState<string[]>([]);
  const [monitorsNote, setMonitorsNote] = useState<string | null>(null);
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
      // Org account names for this connection only (ORGANIZATION_USAGE) — same as Consumption.
      const orgPromise = api<OrgAccountsResp>(
        `/api/cost/org-accounts?connection_id=${connectionId}&days=28`,
        { signal },
      ).catch(() => null);

      // Resource monitors for the active connection only — no fan-out across portal connections.
      const res = await api<MonitorsResp>(
        `/api/cost/resource-monitors?connection_id=${connectionId}`,
        { signal },
      );
      if (signal.aborted) return;

      // Snowflake CURRENT_ACCOUNT() — never portal connection name / other connections.
      const snowflakeAcct = (res.account_name || "").trim() || null;
      const items = (res.items || []).map((item) => ({
        ...item,
        account_name: (item.account_name || "").trim() || snowflakeAcct,
      }));

      const org = await orgPromise;
      if (signal.aborted) return;

      let filterAccounts: string[] = [];
      if (org?.available && org.accounts?.length) {
        filterAccounts = org.accounts.map((a) => a.trim()).filter(Boolean);
      } else if (snowflakeAcct) {
        // Org unavailable / empty: All Accounts + CURRENT_ACCOUNT only.
        filterAccounts = [snowflakeAcct];
      }

      setOrgAccountNames(filterAccounts);
      setMonitors(items);
      setMonitorsNote(res.note && !items.length ? res.note : null);
      setMonitorsErr(null);
    } catch (e) {
      if (signal.aborted || isAbortError(e)) return;
      setMonitors([]);
      setOrgAccountNames([]);
      setMonitorsNote(null);
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
      setMonitors([]);
      setOrgAccountNames([]);
      setMonitorsNote(null);
      setMonitorsErr(null);
      setMonitorsLoading(false);
      return;
    }
    const t = window.setTimeout(() => void loadMonitors(activeId), 150);
    return () => {
      window.clearTimeout(t);
      loadAbortRef.current?.abort();
    };
    // Re-load when active connection changes (not when the connections list identity churns).
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: only activeId
  }, [activeId]);

  const active = connections.find((c) => c.id === activeId);
  const canSelect = connections.length > 1;
  const hasMonitorsData = monitors.length > 0 || !!monitorsNote;

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
      <div className="hub-page-header">
        <div>
          <h1>Snow Portal</h1>
          <p className="muted">Controle de créditos Snowflake para o time de suporte.</p>
        </div>
        {active ? (
          <span className="cost-context-pill" title="Warehouse da conexão ativa">
            {active.warehouse?.trim() || "WH auto"}
          </span>
        ) : null}
      </div>

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
            {monitorsErr && !hasMonitorsData ? (
              <ErrorBanner message={monitorsErr} connectionId={activeId} />
            ) : null}
            {monitorsLoading && !hasMonitorsData ? <CostSkeleton /> : null}
            {hasMonitorsData || (!monitorsLoading && !monitorsErr) ? (
              <div className={`cost-tab-body${monitorsLoading ? " is-refreshing" : ""}`}>
                <MonitorsPanel
                  items={monitors}
                  note={monitorsNote}
                  accountOptions={orgAccountNames}
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
