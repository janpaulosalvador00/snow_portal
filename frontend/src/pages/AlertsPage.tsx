import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  announceAlertsBadge,
  getAlerts,
  type AlertClient,
  type AlertsResponse,
} from "../api/alerts";
import { ApiError } from "../api/client";

type SeverityFilter = "all" | "alert" | "critical";
type CardInterval = "global" | "0" | "60" | "300" | "600" | "900" | "1800" | "3600";

const GLOBAL_INTERVAL_KEY = "snow_portal_alerts_global_interval";
const CARD_INTERVALS_KEY = "snow_portal_alerts_card_intervals";
const GLOBAL_OPTIONS = [
  ["0", "Desligada"],
  ["60", "1 min"],
  ["300", "5 min"],
  ["600", "10 min"],
  ["900", "15 min"],
  ["1800", "30 min"],
  ["3600", "60 min"],
] as const;
const CARD_OPTIONS = [
  ["0", "Desligado"],
  ["global", "Automático"],
  ["60", "1 min"],
  ["300", "5 min"],
  ["600", "10 min"],
  ["900", "15 min"],
  ["1800", "30 min"],
  ["3600", "60 min"],
] as const;

function loadCardIntervals(): Record<number, CardInterval> {
  try {
    return JSON.parse(localStorage.getItem(CARD_INTERVALS_KEY) || "{}") as Record<
      number,
      CardInterval
    >;
  } catch {
    return {};
  }
}

function summarize(clients: AlertClient[], fetchedAt: string): AlertsResponse {
  const active = clients.filter((client) => client.status === "active").length;
  const critical = clients.filter(
    (client) => client.status === "active" && (client.max_quota_used_pct || 0) >= 70,
  ).length;
  return {
    fetched_at: fetchedAt,
    total_connections: clients.length,
    active_connections: active,
    disabled_accounts: clients.length - active,
    critical_clients: critical,
    clients: [...clients].sort(
      (a, b) => (b.max_quota_used_pct || 0) - (a.max_quota_used_pct || 0),
    ),
  };
}

function dateTimeLabel(value: string | number | Date | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return `${date.toLocaleDateString("pt-BR")} ${date.toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

function percentage(value: number): string {
  return `${value.toLocaleString("pt-BR", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })}%`;
}

function plural(value: number, singular: string, pluralForm: string): string {
  return `${value} ${value === 1 ? singular : pluralForm}`;
}

function intervalLabel(seconds: number): string {
  return `${seconds / 60} min`;
}

export function AlertsPage() {
  const [data, setData] = useState<AlertsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [refreshingIds, setRefreshingIds] = useState<number[]>([]);
  const [query, setQuery] = useState("");
  const [severity, setSeverity] = useState<SeverityFilter>("all");
  const [globalInterval, setGlobalInterval] = useState(
    () => localStorage.getItem(GLOBAL_INTERVAL_KEY) || "300",
  );
  const [cardIntervals, setCardIntervals] =
    useState<Record<number, CardInterval>>(loadCardIntervals);
  const [lastUpdates, setLastUpdates] = useState<Record<number, string>>({});
  const [headerLastUpdate, setHeaderLastUpdate] = useState<string | null>(null);

  const applyFullResponse = useCallback((response: AlertsResponse) => {
    setData(response);
    setHeaderLastUpdate(response.fetched_at);
    setLastUpdates(
      Object.fromEntries(response.clients.map((client) => [client.id, response.fetched_at])),
    );
    announceAlertsBadge(response.critical_clients);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void getAlerts()
      .then((response) => {
        if (!cancelled) applyFullResponse(response);
      })
      .catch((reason) => {
        if (!cancelled) {
          setError(
            reason instanceof ApiError ? reason.message : "Falha ao carregar os alertas.",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [applyFullResponse]);

  const refreshConnections = useCallback(
    async (ids?: number[], updateHeader = false) => {
      const all = !ids?.length;
      if (all) setRefreshingAll(true);
      else setRefreshingIds((current) => [...new Set([...current, ...ids])]);
      setError(null);
      try {
        const response = await getAlerts({
          force: all,
          connectionIds: all ? undefined : ids,
        });
        if (all) {
          applyFullResponse(response);
          return;
        }
        const refreshedIds = new Set(response.clients.map((client) => client.id));
        setData((current) => {
          const base = current?.clients || [];
          const refreshed = new Map(response.clients.map((client) => [client.id, client]));
          const merged = base.map((client) => refreshed.get(client.id) || client);
          const result = summarize(merged, response.fetched_at);
          announceAlertsBadge(result.critical_clients);
          return result;
        });
        setLastUpdates((current) => ({
          ...current,
          ...Object.fromEntries([...refreshedIds].map((id) => [id, response.fetched_at])),
        }));
        if (updateHeader) setHeaderLastUpdate(response.fetched_at);
      } catch (reason) {
        setError(
          reason instanceof ApiError ? reason.message : "Uma ou mais contas não atualizaram.",
        );
      } finally {
        if (all) setRefreshingAll(false);
        else {
          const completed = new Set(ids);
          setRefreshingIds((current) => current.filter((id) => !completed.has(id)));
        }
      }
    },
    [applyFullResponse],
  );

  useEffect(() => {
    if (!data?.clients.length) return;
    const timers: number[] = [];
    const globalSeconds = Number(globalInterval);
    const automaticIds = data.clients
      .filter(
        (client) =>
          client.status === "active" && (cardIntervals[client.id] || "global") === "global",
      )
      .map((client) => client.id);
    if (globalSeconds > 0 && automaticIds.length) {
      timers.push(
        window.setInterval(
          () => void refreshConnections(automaticIds, true),
          globalSeconds * 1000,
        ),
      );
    }
    for (const client of data.clients) {
      if (client.status !== "active") continue;
      const ownSeconds = Number(cardIntervals[client.id] || "global");
      if (ownSeconds > 0) {
        timers.push(
          window.setInterval(
            () => void refreshConnections([client.id]),
            ownSeconds * 1000,
          ),
        );
      }
    }
    return () => timers.forEach((timer) => window.clearInterval(timer));
  }, [cardIntervals, data?.clients, globalInterval, refreshConnections]);

  function setClientInterval(id: number, value: CardInterval) {
    setCardIntervals((current) => {
      const next = { ...current, [id]: value };
      localStorage.setItem(CARD_INTERVALS_KEY, JSON.stringify(next));
      return next;
    });
  }

  const activeClients = data?.clients.filter((client) => client.status === "active") || [];
  const buckets = [
    {
      key: "ok",
      label: "Saudáveis",
      range: "< 50%",
      count: activeClients.filter((client) => (client.max_quota_used_pct || 0) < 50).length,
    },
    {
      key: "attention",
      label: "Atenção",
      range: "50–69,9%",
      count: activeClients.filter((client) => {
        const value = client.max_quota_used_pct || 0;
        return value >= 50 && value < 70;
      }).length,
    },
    {
      key: "alert",
      label: "Alerta",
      range: "70–89,9%",
      count: activeClients.filter((client) => {
        const value = client.max_quota_used_pct || 0;
        return value >= 70 && value < 90;
      }).length,
    },
    {
      key: "critical",
      label: "Críticos",
      range: "≥ 90%",
      count: activeClients.filter((client) => (client.max_quota_used_pct || 0) >= 90).length,
    },
  ];

  const cards = useMemo(() => {
    if (!data) return [];
    const normalizedQuery = query.trim().toLocaleLowerCase("pt-BR");
    return data.clients.filter((client) => {
      const value = client.max_quota_used_pct || 0;
      const clientSeverity =
        client.status === "disabled" ? "disabled" : value >= 90 ? "critical" : "alert";
      const isCard = client.status === "disabled" || value >= 70;
      const matchesSeverity =
        severity === "all" || (client.status !== "disabled" && clientSeverity === severity);
      const matchesQuery =
        !normalizedQuery ||
        client.name.toLocaleLowerCase("pt-BR").includes(normalizedQuery) ||
        client.account_identifier.toLocaleLowerCase("pt-BR").includes(normalizedQuery);
      return isCard && matchesSeverity && matchesQuery;
    });
  }, [data, query, severity]);

  const visibleAlertCount = cards.filter((client) => client.status === "active").length;
  const globalSeconds = Number(globalInterval);
  const headerNext =
    headerLastUpdate && globalSeconds
      ? new Date(Date.parse(headerLastUpdate) + globalSeconds * 1000)
      : null;

  return (
    <div className="alerts-page">
      <div className="alerts-overview">
        <div className="alerts-page-header">
          <div className="alerts-page-title">
            <h1>Alerts</h1>
            <span aria-hidden>—</span>
            <p>Monitoramento de consumo de todos os clientes ativos.</p>
          </div>
          <div className="alerts-header-actions">
            <div className="alerts-refresh-stamps" role="status" aria-live="polite">
              <span>Última atualização</span>
              <strong>{dateTimeLabel(headerLastUpdate)}</strong>
              <span>Próxima atualização</span>
              <strong>{headerNext ? dateTimeLabel(headerNext) : "Auto desligada"}</strong>
            </div>
            <label className="alerts-refresh-field">
              <span className="sr-only">Intervalo de atualização automática</span>
              <select
                value={globalInterval}
                onChange={(event) => {
                  const value = event.target.value;
                  setGlobalInterval(value);
                  localStorage.setItem(GLOBAL_INTERVAL_KEY, value);
                }}
              >
                {GLOBAL_OPTIONS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="btn primary alerts-refresh-all"
              disabled={refreshingAll}
              onClick={() => void refreshConnections()}
            >
              <span aria-hidden>↻</span>
              {refreshingAll ? "Atualizando…" : "Atualizar todas"}
            </button>
          </div>
        </div>

        <div className="alerts-status-bar">
          <p className="alerts-status-line">
            <span
              className={`alerts-status-dot${refreshingAll ? " is-busy" : ""}`}
              aria-hidden
            />
            <span role="status" aria-live="polite">
              {data
                ? `${plural(data.active_connections, "conexão ativa", "conexões ativas")} · ${plural(data.disabled_accounts, "conta desligada", "contas desligadas")}`
                : "Carregando conexões…"}
            </span>
          </p>
          <div className="alerts-legend" aria-label="Legenda de severidade">
            <span><i className="is-alert" />Alerta — 70% a 89,9% da cota</span>
            <span><i className="is-critical" />Crítico — 90% ou mais da cota</span>
          </div>
        </div>

        <section aria-labelledby="alerts-kpis-title">
          <h2 id="alerts-kpis-title" className="sr-only">
            Distribuição de clientes por faixa de consumo
          </h2>
          <div className="alerts-kpis">
            {buckets.map((bucket) => {
              const total = activeClients.length;
              const share = total ? (bucket.count / total) * 100 : 0;
              return (
                <div key={bucket.key} className={`alerts-kpi is-${bucket.key}`}>
                  <span className="alerts-kpi-label">
                    {bucket.label} <small>{bucket.range}</small>
                  </span>
                  <span className="alerts-kpi-value">
                    <strong>{percentage(share)}</strong>
                    <small>
                      {bucket.count} de {total} clientes
                    </small>
                  </span>
                </div>
              );
            })}
          </div>
        </section>

        <div className="alerts-toolbar">
          <h2>
            Clientes críticos{" "}
            <span>
              — {visibleAlertCount} {visibleAlertCount === 1 ? "cliente acima" : "clientes acima"}{" "}
              de 70%, ordenados pelo monitor mais crítico
            </span>
          </h2>
          <div className="alerts-toolbar-actions">
            <label className="alerts-search">
              <span aria-hidden>⌕</span>
              <span className="sr-only">Buscar cliente</span>
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Buscar cliente…"
              />
            </label>
            <label>
              <span className="sr-only">Filtrar por severidade</span>
              <select
                value={severity}
                onChange={(event) => setSeverity(event.target.value as SeverityFilter)}
              >
                <option value="all">Todas as severidades</option>
                <option value="critical">Somente críticos</option>
                <option value="alert">Somente alerta</option>
              </select>
            </label>
          </div>
        </div>
      </div>

      <div className="alerts-card-scroll">
        {error ? <div className="error-box">{error}</div> : null}
        {loading && !data ? <div className="info-box">Carregando Resource Monitors…</div> : null}
        {!loading && data && !cards.length ? (
          <div className="alerts-empty">
            Nenhum cliente corresponde à busca ou ao filtro de severidade.
          </div>
        ) : null}
        <div className="alerts-grid">
          {cards.map((client) => {
            const value = client.max_quota_used_pct || 0;
            const isDisabled = client.status === "disabled";
            const clientSeverity = value >= 90 ? "critical" : "alert";
            const cardInterval = cardIntervals[client.id] || "global";
            const effectiveSeconds =
              cardInterval === "global" ? globalSeconds : Number(cardInterval);
            const last = lastUpdates[client.id] || data?.fetched_at || null;
            const next =
              last && effectiveSeconds && !isDisabled
                ? new Date(Date.parse(last) + effectiveSeconds * 1000)
                : null;
            const warningMonitors = client.monitors.filter(
              (monitor) => (monitor.quota_used_pct || 0) >= 70,
            );
            const belowCount = client.monitors.length - warningMonitors.length;
            const refreshing = refreshingIds.includes(client.id);
            const intervalCue =
              cardInterval === "global"
                ? globalSeconds
                  ? `Global · ${intervalLabel(globalSeconds)}`
                  : "Global desligado"
                : effectiveSeconds
                  ? `Próprio · ${intervalLabel(effectiveSeconds)}`
                  : "Sem auto";
            return (
              <article
                key={client.id}
                className={`alerts-card is-${isDisabled ? "disabled" : clientSeverity}${refreshing ? " is-busy" : ""}`}
                aria-busy={refreshing}
              >
                <div className="alerts-card-head">
                  <div>
                    <div className="alerts-client-name" title={client.name}>
                      {client.name}
                    </div>
                    <div className="alerts-client-account mono">{client.account_identifier}</div>
                  </div>
                  <span className={`alerts-badge is-${isDisabled ? "disabled" : clientSeverity}`}>
                    {isDisabled ? "Desligada" : clientSeverity === "critical" ? "Crítico" : "Alerta"}
                  </span>
                </div>

                {isDisabled ? (
                  <p className="alerts-card-error">
                    Conta desligada — sem monitoramento: {client.error || "falha de conexão."}
                  </p>
                ) : (
                  <ul className="alerts-monitor-list">
                    {warningMonitors.map((monitor) => {
                      const monitorValue = monitor.quota_used_pct || 0;
                      const monitorSeverity = monitorValue >= 90 ? "critical" : "alert";
                      return (
                        <li key={monitor.name} className={`is-${monitorSeverity}`}>
                          <span className="alerts-monitor-name" title={monitor.name}>
                            <i aria-hidden>{monitorSeverity === "critical" ? "●" : "△"}</i>
                            {monitor.name}
                          </span>
                          <strong>{percentage(monitorValue)}</strong>
                          <span className="alerts-quota-track">
                            <span style={{ width: `${Math.min(100, monitorValue)}%` }} />
                          </span>
                        </li>
                      );
                    })}
                    {belowCount > 0 ? (
                      <li className="alerts-monitor-more">
                        + {belowCount} {belowCount === 1 ? "monitor" : "monitores"} abaixo de 70%
                      </li>
                    ) : null}
                    {!client.monitors.length ? (
                      <li className="alerts-monitor-more">
                        {client.note || "Nenhum Resource Monitor nesta conta."}
                      </li>
                    ) : null}
                  </ul>
                )}

                <div className="alerts-card-foot">
                  <span className="alerts-card-stamps">
                    <span>Última atualização</span>
                    <strong>{refreshing ? "Atualizando…" : dateTimeLabel(last)}</strong>
                    <span>Próxima atualização</span>
                    <strong>{next ? dateTimeLabel(next) : "Auto desligada"}</strong>
                  </span>
                  <span className="alerts-card-actions">
                    {isDisabled ? (
                      <Link className="btn alerts-small-btn" to={`/conexoes?edit=${client.id}`}>
                        Revalidar conexão
                      </Link>
                    ) : (
                      <>
                        <small>{intervalCue}</small>
                        <label>
                          <span className="sr-only">Intervalo de atualização de {client.name}</span>
                          <select
                            value={cardInterval}
                            onChange={(event) =>
                              setClientInterval(client.id, event.target.value as CardInterval)
                            }
                          >
                            {CARD_OPTIONS.map(([optionValue, label]) => (
                              <option key={optionValue} value={optionValue}>
                                {label}
                              </option>
                            ))}
                          </select>
                        </label>
                      </>
                    )}
                    <button
                      type="button"
                      className="btn alerts-small-btn"
                      disabled={refreshing}
                      onClick={() => void refreshConnections([client.id])}
                      aria-label={`Atualizar ${client.name}`}
                    >
                      ↻
                    </button>
                  </span>
                </div>
              </article>
            );
          })}
        </div>
      </div>
    </div>
  );
}
