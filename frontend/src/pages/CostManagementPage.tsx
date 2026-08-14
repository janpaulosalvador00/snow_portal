import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api, ApiError, getActiveConnectionId, setActiveConnectionId } from "../api/client";

type Conn = {
  id: number;
  name: string;
  account_identifier: string;
};

type Consumption = {
  total_credits: number;
  summary: { name: string; type: string; tags: string; credits_used: number }[];
  chart: { period_start: string; resource_name: string; credits: number }[];
};

type AccountOverview = {
  days: number;
  total_credits: number;
  by_service: { label: string; credits: number }[];
  storage_tb: number | null;
  storage_note: string | null;
};

type AnomaliesResp = {
  items: {
    resource_name: string;
    latest_credits: number;
    avg_credits: number;
    pct_vs_avg: number;
    z_score: number;
    direction: string;
  }[];
  note: string | null;
};

type MonitorsResp = {
  items: {
    name: string;
    credit_quota: number | null;
    used_credits: number | null;
    remaining_credits: number | null;
    level: string;
    frequency: string;
  }[];
  note: string | null;
};

type BudgetsResp = {
  items: { name: string; raw: Record<string, string | null> }[];
  note: string | null;
};

type OrgResp = {
  available: boolean;
  items: { usage_date: string; account_name: string; credits_used: number }[];
  note: string | null;
};

const TABS = [
  "Organization Overview",
  "Account Overview",
  "Consumption",
  "Anomalies",
  "Budgets",
  "Resource Monitors",
] as const;

type Tab = (typeof TABS)[number];

export function CostManagementPage() {
  const [connections, setConnections] = useState<Conn[]>([]);
  const [connectionId, setConnectionId] = useState<number | "">(getActiveConnectionId() ?? "");
  const [days, setDays] = useState(28);
  const [usageType, setUsageType] = useState("Compute");
  const [grain, setGrain] = useState("day");
  const [serviceType, setServiceType] = useState("All");
  const [data, setData] = useState<Consumption | null>(null);
  const [overview, setOverview] = useState<AccountOverview | null>(null);
  const [anom, setAnom] = useState<AnomaliesResp | null>(null);
  const [monitors, setMonitors] = useState<MonitorsResp | null>(null);
  const [budgets, setBudgets] = useState<BudgetsResp | null>(null);
  const [org, setOrg] = useState<OrgResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<Tab>("Consumption");

  useEffect(() => {
    void api<Conn[]>("/api/connections").then((list) => {
      setConnections(list);
      const active = getActiveConnectionId();
      if (active && list.some((c) => c.id === active)) {
        setConnectionId(active);
      } else if (!active) {
        setConnectionId("");
      }
    });
  }, []);

  async function load() {
    if (!connectionId) {
      setErr(null);
      setData(null);
      setOverview(null);
      setAnom(null);
      setMonitors(null);
      setBudgets(null);
      setOrg(null);
      return;
    }
    setLoading(true);
    setErr(null);
    const id = Number(connectionId);
    setActiveConnectionId(id);
    const qs = new URLSearchParams({
      connection_id: String(id),
      days: String(days),
    });
    try {
      if (tab === "Consumption") {
        qs.set("usage_type", usageType);
        qs.set("grain", grain);
        qs.set("service_type", serviceType);
        const res = await api<Consumption>(`/api/cost/consumption?${qs}`);
        setData(res);
      } else if (tab === "Account Overview") {
        const res = await api<AccountOverview>(`/api/cost/account-overview?${qs}`);
        setOverview(res);
      } else if (tab === "Anomalies") {
        const res = await api<AnomaliesResp>(`/api/cost/anomalies?${qs}`);
        setAnom(res);
      } else if (tab === "Resource Monitors") {
        const res = await api<MonitorsResp>(
          `/api/cost/resource-monitors?connection_id=${id}`,
        );
        setMonitors(res);
      } else if (tab === "Budgets") {
        const res = await api<BudgetsResp>(`/api/cost/budgets?connection_id=${id}`);
        setBudgets(res);
      } else if (tab === "Organization Overview") {
        const res = await api<OrgResp>(`/api/cost/organization-overview?${qs}`);
        setOrg(res);
      }
    } catch (e) {
      setData(null);
      setOverview(null);
      setAnom(null);
      setMonitors(null);
      setBudgets(null);
      setOrg(null);
      setErr(e instanceof ApiError ? e.message : "Falha ao carregar Cost Management.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (connectionId) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, tab]);

  const chartData = useMemo(() => {
    if (!data?.chart?.length) return null;
    const byPeriod: Record<string, Record<string, number | string>> = {};
    const resources = new Set<string>();
    for (const row of data.chart) {
      const key = row.period_start.slice(0, 10);
      resources.add(row.resource_name);
      if (!byPeriod[key]) byPeriod[key] = { period: key };
      byPeriod[key][row.resource_name] =
        Number(byPeriod[key][row.resource_name] || 0) + row.credits;
    }
    return {
      rows: Object.values(byPeriod),
      resources: Array.from(resources),
    };
  }, [data]);

  const maxCredits = data?.summary?.[0]?.credits_used || 1;
  const noActive = !connectionId;

  return (
    <div>
      <h1>Cost Management</h1>
      <div className="tabs">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            className={tab === t ? "active" : ""}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="banner">
        Dados de ACCOUNT_USAGE / ORGANIZATION_USAGE podem ter atraso. Sem conta ativa, ative em{" "}
        <Link to="/conexoes">Conexões</Link>.
      </div>

      {noActive ? (
        <div className="warn-box">
          Nenhuma conta ativa. Vá em <Link to="/conexoes">Conexões</Link>, ative uma conta e, se
          necessário, <strong>Edite</strong> warehouse/role (deixe WH vazio se estiver bloqueado por
          resource monitor).
        </div>
      ) : (
        <>
          <div className="filters">
            <label>
              Account
              <select
                value={connectionId}
                onChange={(e) => setConnectionId(Number(e.target.value))}
              >
                {connections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.account_identifier})
                  </option>
                ))}
              </select>
            </label>
            {(tab === "Consumption" ||
              tab === "Account Overview" ||
              tab === "Anomalies" ||
              tab === "Organization Overview") && (
              <label>
                Time Range
                <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
                  <option value={7}>Last 7 days</option>
                  <option value={28}>Last 28 days</option>
                  <option value={90}>Last 90 days</option>
                </select>
              </label>
            )}
            {tab === "Consumption" ? (
              <>
                <label>
                  Usage Type
                  <select value={usageType} onChange={(e) => setUsageType(e.target.value)}>
                    <option>All</option>
                    <option>Compute</option>
                    <option>Cloud Services</option>
                  </select>
                </label>
                <label>
                  By
                  <select value={grain} onChange={(e) => setGrain(e.target.value)}>
                    <option value="day">Day</option>
                    <option value="month">Month</option>
                  </select>
                </label>
                <label>
                  Service Type
                  <select value={serviceType} onChange={(e) => setServiceType(e.target.value)}>
                    <option>All</option>
                    <option>WAREHOUSE_METERING</option>
                    <option>AI_SERVICES</option>
                    <option>AI_INFERENCE</option>
                    <option>SNOWPARK_CONTAINER_SERVICES</option>
                    <option>AUTO_CLUSTERING</option>
                    <option>PIPE</option>
                    <option>SERVERLESS_TASK</option>
                  </select>
                </label>
              </>
            ) : null}
            <button type="button" className="btn primary" onClick={() => void load()} disabled={loading}>
              {loading ? "Atualizando…" : "Atualizar"}
            </button>
          </div>

          {err ? (
            <div className="error-box">
              {err}
              <div style={{ marginTop: "0.5rem" }}>
                <Link to={connectionId ? `/conexoes?edit=${connectionId}` : "/conexoes"}>
                  Editar conexão (revalidar auth / warehouse / role)
                </Link>
              </div>
            </div>
          ) : null}

          {tab === "Consumption" && data ? (
            <>
              <div className="kpi">{data.total_credits.toFixed(1)} credits used</div>
              {chartData?.rows.length ? (
                <div className="chart-wrap">
                  <ResponsiveContainer width="100%" height={360}>
                    <BarChart data={chartData.rows}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#2A2F36" />
                      <XAxis dataKey="period" stroke="#8B939E" />
                      <YAxis stroke="#8B939E" />
                      <Tooltip
                        contentStyle={{ background: "#1A1D21", border: "1px solid #2A2F36" }}
                      />
                      <Legend />
                      {chartData.resources.map((r, i) => (
                        <Bar
                          key={r}
                          dataKey={r}
                          stackId="a"
                          fill={
                            ["#29B5E8", "#7AD3A0", "#C4A5E7", "#F0C674", "#E88B8B", "#8AB4F8"][
                              i % 6
                            ]
                          }
                        />
                      ))}
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <div className="info-box">Nenhum consumo no período.</div>
              )}
              <h3>Uso por recurso</h3>
              <div className="table">
                <div className="table-head">
                  <span>NAME</span>
                  <span>TYPE</span>
                  <span>TAGS</span>
                  <span>CREDITS USED</span>
                </div>
                {data.summary.map((row) => (
                  <div key={row.name + row.type} className="table-row">
                    <span>{row.name}</span>
                    <span>{row.type}</span>
                    <span>{row.tags}</span>
                    <span className="credits-cell">
                      <span
                        className="bar"
                        style={{
                          width: `${Math.min(100, (row.credits_used / maxCredits) * 100)}%`,
                        }}
                      />
                      <em>{row.credits_used.toFixed(1)}</em>
                    </span>
                  </div>
                ))}
              </div>
            </>
          ) : null}

          {tab === "Account Overview" && overview ? (
            <>
              <div className="metrics">
                <div className="metric">
                  <span className="muted">Credits ({overview.days}d)</span>
                  <strong>{overview.total_credits.toFixed(1)}</strong>
                </div>
                <div className="metric">
                  <span className="muted">Storage (TB approx)</span>
                  <strong>
                    {overview.storage_tb != null ? overview.storage_tb.toFixed(3) : "—"}
                  </strong>
                </div>
              </div>
              {overview.storage_note ? (
                <div className="info-box">{overview.storage_note}</div>
              ) : null}
              <h3>Por serviço</h3>
              <div className="table">
                <div className="table-head">
                  <span>SERVICE</span>
                  <span>CREDITS</span>
                </div>
                {overview.by_service.map((r) => (
                  <div key={r.label} className="table-row">
                    <span>{r.label}</span>
                    <span>{r.credits.toFixed(1)}</span>
                  </div>
                ))}
              </div>
            </>
          ) : null}

          {tab === "Anomalies" && anom ? (
            <>
              {anom.note ? <div className="info-box">{anom.note}</div> : null}
              {!anom.items.length && !anom.note ? (
                <div className="info-box">Nenhuma anomalia relevante no período.</div>
              ) : (
                <div className="table">
                  <div className="table-head">
                    <span>RESOURCE</span>
                    <span>LATEST</span>
                    <span>AVG</span>
                    <span>% VS AVG</span>
                  </div>
                  {anom.items.map((r) => (
                    <div key={r.resource_name} className="table-row">
                      <span>{r.resource_name}</span>
                      <span>{r.latest_credits.toFixed(2)}</span>
                      <span>{r.avg_credits.toFixed(2)}</span>
                      <span>
                        {r.pct_vs_avg > 0 ? "+" : ""}
                        {r.pct_vs_avg.toFixed(0)}% ({r.direction})
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : null}

          {tab === "Resource Monitors" && monitors ? (
            <>
              {monitors.note ? <div className="info-box">{monitors.note}</div> : null}
              {monitors.items.length ? (
                <div className="table">
                  <div className="table-head">
                    <span>NAME</span>
                    <span>QUOTA</span>
                    <span>USED</span>
                    <span>REMAINING</span>
                    <span>LEVEL</span>
                  </div>
                  {monitors.items.map((r) => (
                    <div key={r.name} className="table-row">
                      <span>{r.name}</span>
                      <span>{r.credit_quota ?? "—"}</span>
                      <span>{r.used_credits ?? "—"}</span>
                      <span>{r.remaining_credits ?? "—"}</span>
                      <span>{r.level}</span>
                    </div>
                  ))}
                </div>
              ) : null}
            </>
          ) : null}

          {tab === "Budgets" && budgets ? (
            <>
              {budgets.note ? <div className="info-box">{budgets.note}</div> : null}
              {budgets.items.length ? (
                <div className="table">
                  <div className="table-head">
                    <span>NAME</span>
                    <span>DETAILS</span>
                  </div>
                  {budgets.items.map((r) => (
                    <div key={r.name} className="table-row">
                      <span>{r.name}</span>
                      <span className="muted">{JSON.stringify(r.raw)}</span>
                    </div>
                  ))}
                </div>
              ) : null}
            </>
          ) : null}

          {tab === "Organization Overview" && org ? (
            <>
              {org.note ? <div className="info-box">{org.note}</div> : null}
              {org.items.length ? (
                <div className="table">
                  <div className="table-head">
                    <span>DATE</span>
                    <span>ACCOUNT</span>
                    <span>CREDITS</span>
                  </div>
                  {org.items.map((r, i) => (
                    <div key={`${r.usage_date}-${r.account_name}-${i}`} className="table-row">
                      <span>{r.usage_date}</span>
                      <span>{r.account_name}</span>
                      <span>{r.credits_used.toFixed(1)}</span>
                    </div>
                  ))}
                </div>
              ) : null}
            </>
          ) : null}
        </>
      )}
    </div>
  );
}
