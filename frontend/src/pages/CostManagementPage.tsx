import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api, ApiError, getActiveConnectionId, setActiveConnectionId } from "../api/client";
import { AnomalyLineChart } from "../components/cost/AnomalyLineChart";
import {
  CostPageHeader,
  CostSkeleton,
  CostTabs,
  type CostTab,
} from "../components/cost/CostChrome";
import { CreditsTable } from "../components/cost/CreditsTable";
import { ErrorBanner } from "../components/cost/ErrorBanner";
import { FilterPill } from "../components/cost/FilterPill";
import { MonitorsTable } from "../components/cost/MonitorsTable";
import { StackedConsumptionChart } from "../components/cost/StackedConsumptionChart";

type Conn = {
  id: number;
  name: string;
  account_identifier: string;
  warehouse?: string | null;
  role_name?: string | null;
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
  series?: {
    date: string;
    credits: number;
    expected_low: number;
    expected_high: number;
    is_anomaly: boolean;
  }[];
  anomalies?: {
    date: string;
    credits: number;
    expected_low: number;
    expected_high: number;
    delta: number;
  }[];
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
    quota_used_pct: number | null;
    level: string;
    frequency: string;
    warehouses: string[];
    start_time: string | null;
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

const SERVICE_OPTIONS = [
  { value: "All", label: "All" },
  { value: "WAREHOUSE_METERING", label: "Warehouse" },
  { value: "AI_SERVICES", label: "AI Services" },
  { value: "AI_INFERENCE", label: "AI Inference" },
  { value: "SNOWPARK_CONTAINER_SERVICES", label: "Snowpark Container" },
  { value: "AUTO_CLUSTERING", label: "Auto Clustering" },
  { value: "PIPE", label: "Snowpipe" },
  { value: "SERVERLESS_TASK", label: "Serverless Task" },
];

export function CostManagementPage() {
  const [connections, setConnections] = useState<Conn[]>([]);
  const [connectionId, setConnectionId] = useState<number | "">(getActiveConnectionId() ?? "");
  const [days, setDays] = useState(90);
  const [usageType, setUsageType] = useState("Compute");
  const [grain, setGrain] = useState("month");
  const [serviceType, setServiceType] = useState("WAREHOUSE_METERING");
  const [resourceFilter, setResourceFilter] = useState("All");
  const [data, setData] = useState<Consumption | null>(null);
  const [overview, setOverview] = useState<AccountOverview | null>(null);
  const [anom, setAnom] = useState<AnomaliesResp | null>(null);
  const [monitors, setMonitors] = useState<MonitorsResp | null>(null);
  const [budgets, setBudgets] = useState<BudgetsResp | null>(null);
  const [org, setOrg] = useState<OrgResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<CostTab>("Consumption");
  const [monitorSearch, setMonitorSearch] = useState("");
  const [monitorLevel, setMonitorLevel] = useState("All");
  const [monitorWh, setMonitorWh] = useState("All");
  const [monitorFreq, setMonitorFreq] = useState("All");

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

  // Auto-reload with debounce when filters/tab/connection change
  useEffect(() => {
    if (!connectionId) return;
    const t = window.setTimeout(() => {
      void load();
    }, 400);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, tab, days, usageType, grain, serviceType]);

  const activeConn = connections.find((c) => c.id === connectionId);
  const contextLabel = activeConn
    ? [activeConn.warehouse || activeConn.role_name || activeConn.name].filter(Boolean).join(" · ")
    : null;

  const chartData = useMemo(() => {
    if (!data?.chart?.length) return null;
    const byPeriod: Record<string, Record<string, number | string>> = {};
    const resources = new Set<string>();
    for (const row of data.chart) {
      if (resourceFilter !== "All" && row.resource_name !== resourceFilter) continue;
      const key =
        grain === "month" ? row.period_start.slice(0, 7) : row.period_start.slice(0, 10);
      resources.add(row.resource_name);
      if (!byPeriod[key]) byPeriod[key] = { period: key };
      byPeriod[key][row.resource_name] =
        Number(byPeriod[key][row.resource_name] || 0) + row.credits;
    }
    return {
      rows: Object.values(byPeriod).sort((a, b) =>
        String(a.period).localeCompare(String(b.period)),
      ),
      resources: Array.from(resources),
    };
  }, [data, grain, resourceFilter]);

  const summaryRows = useMemo(() => {
    if (!data?.summary) return [];
    if (resourceFilter === "All") return data.summary;
    return data.summary.filter((r) => r.name === resourceFilter);
  }, [data, resourceFilter]);

  const resourceOptions = useMemo(() => {
    const names = data?.summary?.map((r) => r.name) || [];
    return [
      { value: "All", label: "All Resources" },
      ...names.map((n) => ({ value: n, label: n })),
    ];
  }, [data]);

  const filteredMonitors = useMemo(() => {
    const items = monitors?.items || [];
    return items.filter((m) => {
      if (monitorSearch && !m.name.toLowerCase().includes(monitorSearch.toLowerCase())) {
        return false;
      }
      if (monitorLevel !== "All" && m.level !== monitorLevel) return false;
      if (monitorFreq !== "All" && m.frequency !== monitorFreq) return false;
      if (
        monitorWh !== "All" &&
        !(m.warehouses || []).some((w) => w === monitorWh)
      ) {
        return false;
      }
      return true;
    });
  }, [monitors, monitorSearch, monitorLevel, monitorWh, monitorFreq]);

  const monitorLevels = useMemo(() => {
    const s = new Set((monitors?.items || []).map((m) => m.level).filter(Boolean));
    return ["All", ...Array.from(s)];
  }, [monitors]);

  const monitorFreqs = useMemo(() => {
    const s = new Set((monitors?.items || []).map((m) => m.frequency).filter(Boolean));
    return ["All", ...Array.from(s)];
  }, [monitors]);

  const monitorWarehouses = useMemo(() => {
    const s = new Set<string>();
    for (const m of monitors?.items || []) {
      for (const w of m.warehouses || []) s.add(w);
    }
    return ["All", ...Array.from(s).sort()];
  }, [monitors]);

  const noActive = !connectionId;
  const showTime =
    tab === "Consumption" ||
    tab === "Account Overview" ||
    tab === "Anomalies" ||
    tab === "Organization Overview";

  return (
    <div className="cost-page">
      <CostPageHeader
        contextLabel={contextLabel}
        actions={
          tab === "Resource Monitors" ? (
            <button
              type="button"
              className="btn primary"
              disabled
              title="Abra na Snowflake Console"
            >
              + Resource Monitor
            </button>
          ) : null
        }
      />
      <CostTabs tab={tab} onTab={setTab} />

      <p className="cost-latency muted">
        Dados de ACCOUNT_USAGE / ORGANIZATION_USAGE podem ter atraso. Sem conta ativa, ative em{" "}
        <Link to="/conexoes">Conexões</Link>.
      </p>

      {noActive ? (
        <div className="warn-box">
          Nenhuma conta ativa. Vá em <Link to="/conexoes">Conexões</Link>, ative uma conta e, se
          necessário, <strong>Edite</strong> warehouse/role.
        </div>
      ) : (
        <>
          <div className="cost-filters">
            <FilterPill
              label="Account"
              value={String(connectionId)}
              onChange={(v) => setConnectionId(Number(v))}
              options={connections.map((c) => ({
                value: String(c.id),
                label: `${c.name} (${c.account_identifier})`,
              }))}
            />
            {showTime ? (
              <FilterPill
                label="Time Range"
                value={String(days)}
                onChange={(v) => setDays(Number(v))}
                options={[
                  { value: "7", label: "Last 7 days" },
                  { value: "28", label: "Last 28 days" },
                  { value: "90", label: "Last 3 months" },
                ]}
              />
            ) : null}
            {tab === "Consumption" ? (
              <>
                <FilterPill
                  label="Usage Type"
                  value={usageType}
                  onChange={setUsageType}
                  options={[
                    { value: "All", label: "All" },
                    { value: "Compute", label: "Compute" },
                    { value: "Cloud Services", label: "Cloud Services" },
                  ]}
                />
                <FilterPill
                  label="Service Type"
                  value={serviceType}
                  onChange={setServiceType}
                  options={SERVICE_OPTIONS}
                />
                <FilterPill
                  label="Resources"
                  value={resourceFilter}
                  onChange={setResourceFilter}
                  options={resourceOptions}
                />
              </>
            ) : null}
            {tab === "Anomalies" ? (
              <>
                <FilterPill
                  label="Monitors"
                  value="N/A"
                  onChange={() => undefined}
                  options={[{ value: "N/A", label: "N/A" }]}
                  disabled
                />
                <FilterPill
                  label="Tags"
                  value="N/A"
                  onChange={() => undefined}
                  options={[{ value: "N/A", label: "N/A" }]}
                  disabled
                />
                <FilterPill
                  label="Service types"
                  value="N/A"
                  onChange={() => undefined}
                  options={[{ value: "N/A", label: "N/A" }]}
                  disabled
                />
              </>
            ) : null}
            {tab === "Resource Monitors" ? (
              <>
                <label className="filter-pill filter-search">
                  <span className="filter-pill-label">Search</span>
                  <input
                    value={monitorSearch}
                    onChange={(e) => setMonitorSearch(e.target.value)}
                    placeholder="Search monitors"
                    aria-label="Search monitors"
                  />
                </label>
                <FilterPill
                  label="Level"
                  value={monitorLevel}
                  onChange={setMonitorLevel}
                  options={monitorLevels.map((l) => ({ value: l, label: l }))}
                />
                <FilterPill
                  label="Warehouse"
                  value={monitorWh}
                  onChange={setMonitorWh}
                  options={monitorWarehouses.map((w) => ({ value: w, label: w }))}
                />
                <FilterPill
                  label="Frequency"
                  value={monitorFreq}
                  onChange={setMonitorFreq}
                  options={monitorFreqs.map((f) => ({ value: f, label: f }))}
                />
              </>
            ) : null}
            <button
              type="button"
              className="btn icon-refresh"
              onClick={() => void load()}
              disabled={loading}
              title="Atualizar"
              aria-label="Atualizar"
            >
              ↻
            </button>
          </div>

          {err ? <ErrorBanner message={err} connectionId={connectionId} /> : null}

          {loading && !err ? <CostSkeleton /> : null}

          {!loading && tab === "Consumption" && data ? (
            <>
              <div className="kpi cost-kpi">
                {summaryRows
                  .reduce((a, r) => a + r.credits_used, 0)
                  .toFixed(1)}{" "}
                <span className="kpi-suffix">credits used</span>
              </div>
              {chartData?.rows.length ? (
                <StackedConsumptionChart
                  rows={chartData.rows}
                  resources={chartData.resources}
                  grain={grain}
                  onGrain={setGrain}
                />
              ) : (
                <div className="info-box">Nenhum consumo no período.</div>
              )}
              <CreditsTable rows={summaryRows} />
            </>
          ) : null}

          {!loading && tab === "Account Overview" && overview ? (
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
              <div className="chart-wrap cost-chart">
                <ResponsiveContainer width="100%" height={280}>
                  <BarChart
                    data={overview.by_service.map((r) => ({
                      name: r.label,
                      credits: r.credits,
                    }))}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#2A2F36" vertical={false} />
                    <XAxis dataKey="name" stroke="#8B939E" tick={{ fontSize: 11 }} />
                    <YAxis stroke="#8B939E" />
                    <Tooltip
                      contentStyle={{
                        background: "#1A1D21",
                        border: "1px solid #2A2F36",
                      }}
                    />
                    <Bar dataKey="credits" fill="#29B5E8" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div className="table cost-table">
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

          {!loading && tab === "Anomalies" && anom ? (
            <>
              {anom.note ? <div className="info-box">{anom.note}</div> : null}
              {anom.series && anom.series.length ? (
                <AnomalyLineChart series={anom.series} />
              ) : !anom.note ? (
                <div className="info-box">Nenhuma anomalia relevante no período.</div>
              ) : null}
              {anom.anomalies && anom.anomalies.length ? (
                <div className="table cost-table cost-table-anomalies">
                  <div className="table-head">
                    <span>DATE</span>
                    <span>CONSUMPTION</span>
                    <span>EXPECTED RANGE</span>
                    <span>OVER/UNDER EXPECTED</span>
                  </div>
                  {anom.anomalies.map((r) => (
                    <div key={r.date} className="table-row">
                      <span>{r.date}</span>
                      <span>{r.credits.toFixed(2)} credits</span>
                      <span className="muted">
                        {r.expected_low.toFixed(2)} – {r.expected_high.toFixed(2)}
                      </span>
                      <span className={r.delta > 0 ? "delta-pos" : "delta-neg"}>
                        {r.delta > 0 ? "+" : ""}
                        {r.delta.toFixed(2)} credits
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}
            </>
          ) : null}

          {!loading && tab === "Resource Monitors" && monitors ? (
            <>
              {monitors.note ? <div className="info-box">{monitors.note}</div> : null}
              <div className="monitors-count muted">
                {filteredMonitors.length} Resource Monitor
                {filteredMonitors.length === 1 ? "" : "s"}
              </div>
              {filteredMonitors.length ? <MonitorsTable items={filteredMonitors} /> : null}
            </>
          ) : null}

          {!loading && tab === "Budgets" && budgets ? (
            <>
              {budgets.note ? <div className="info-box">{budgets.note}</div> : null}
              {budgets.items.length ? (
                <div className="table cost-table">
                  <div className="table-head">
                    <span>NAME</span>
                    <span>DETAILS</span>
                  </div>
                  {budgets.items.map((r) => (
                    <div key={r.name} className="table-row">
                      <span className="mono">{r.name}</span>
                      <span className="muted">{JSON.stringify(r.raw)}</span>
                    </div>
                  ))}
                </div>
              ) : !budgets.note ? (
                <div className="info-box">Nenhum budget configurado nesta conta.</div>
              ) : null}
            </>
          ) : null}

          {!loading && tab === "Organization Overview" && org ? (
            <>
              {org.note ? <div className="info-box">{org.note}</div> : null}
              {org.items.length ? (
                <div className="table cost-table">
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
