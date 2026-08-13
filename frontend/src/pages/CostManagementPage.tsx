import { useEffect, useMemo, useState } from "react";
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

export function CostManagementPage() {
  const [connections, setConnections] = useState<Conn[]>([]);
  const [connectionId, setConnectionId] = useState<number | "">(getActiveConnectionId() ?? "");
  const [days, setDays] = useState(28);
  const [usageType, setUsageType] = useState("Compute");
  const [grain, setGrain] = useState("day");
  const [serviceType, setServiceType] = useState("All");
  const [data, setData] = useState<Consumption | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState("Consumption");

  useEffect(() => {
    void api<Conn[]>("/api/connections").then((list) => {
      setConnections(list);
      if (!connectionId && list.length) {
        setConnectionId(list[0].id);
        setActiveConnectionId(list[0].id);
      }
    });
  }, []);

  async function load() {
    if (!connectionId) return;
    setLoading(true);
    setErr(null);
    try {
      setActiveConnectionId(Number(connectionId));
      const qs = new URLSearchParams({
        connection_id: String(connectionId),
        days: String(days),
        usage_type: usageType,
        grain,
        service_type: serviceType,
      });
      const res = await api<Consumption>(`/api/consumption?${qs}`);
      setData(res);
    } catch (e) {
      setData(null);
      setErr(e instanceof ApiError ? e.message : "Falha ao carregar consumo.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (connectionId) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId]);

  const chartData = useMemo(() => {
    if (!data?.chart?.length) return [];
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

  return (
    <div>
      <h1>Cost Management</h1>
      <div className="tabs">
        {[
          "Organization Overview",
          "Account Overview",
          "Consumption",
          "Anomalies",
          "Budgets",
          "Resource Monitors",
        ].map((t) => (
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

      {tab !== "Consumption" ? (
        <div className="info-box">{tab} — previsto para a onda 2.</div>
      ) : (
        <>
          <div className="banner">
            Dados de SNOWFLAKE.ACCOUNT_USAGE podem ter atraso de algumas horas.
          </div>

          {!connections.length ? (
            <div className="warn-box">Cadastre uma conexão em Conexões antes de ver créditos.</div>
          ) : (
            <>
              <div className="filters">
                <label>
                  Time Range
                  <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
                    <option value={7}>Last 7 days</option>
                    <option value={28}>Last 28 days</option>
                    <option value={90}>Last 90 days</option>
                  </select>
                </label>
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
                <button type="button" className="btn primary" onClick={() => void load()} disabled={loading}>
                  {loading ? "Atualizando…" : "Atualizar"}
                </button>
              </div>

              {err ? <div className="error-box">{err}</div> : null}

              {data ? (
                <>
                  <div className="kpi">{data.total_credits.toFixed(1)} credits used</div>

                  {chartData && "rows" in chartData && chartData.rows.length ? (
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
                              fill={["#29B5E8", "#7AD3A0", "#C4A5E7", "#F0C674", "#E88B8B", "#8AB4F8"][i % 6]}
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
            </>
          )}
        </>
      )}
    </div>
  );
}
