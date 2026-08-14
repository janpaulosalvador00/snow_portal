import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import {
  api,
  ApiError,
  getActiveConnectionId,
  isAbortError,
  setActiveConnectionId,
} from "../api/client";
import { AnomalyLineChart } from "../components/cost/AnomalyLineChart";
import {
  CostPageHeader,
  CostSkeleton,
  CostTabs,
  type CostTab,
} from "../components/cost/CostChrome";
import { CreditsTable } from "../components/cost/CreditsTable";
import { DateRangePicker, type DateRangeValue } from "../components/cost/DateRangePicker";
import { ErrorBanner } from "../components/cost/ErrorBanner";
import { FilterPill } from "../components/cost/FilterPill";
import { MonitorsPanel } from "../components/cost/MonitorsPanel";
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
  const [dateRange, setDateRange] = useState<DateRangeValue>({ mode: "preset", days: 7 });
  const [usageType, setUsageType] = useState("Compute");
  const [grain, setGrain] = useState("day");
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
  const loadAbortRef = useRef<AbortController | null>(null);

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
      loadAbortRef.current?.abort();
      loadAbortRef.current = null;
      setErr(null);
      setData(null);
      setOverview(null);
      setAnom(null);
      setMonitors(null);
      setBudgets(null);
      setOrg(null);
      setLoading(false);
      return;
    }
    loadAbortRef.current?.abort();
    const ac = new AbortController();
    loadAbortRef.current = ac;
    const { signal } = ac;

    setLoading(true);
    setErr(null);
    const id = Number(connectionId);
    setActiveConnectionId(id);

    // Absolute UTC window for every tab so presets match custom and never clamp silently.
    let startIso: string;
    let endIso: string;
    let spanDays: number;
    if (dateRange.mode === "custom") {
      startIso = dateRange.start;
      endIso = dateRange.end;
      spanDays = Math.max(
        1,
        Math.ceil((Date.parse(endIso) - Date.parse(startIso)) / 86400000) + 1,
      );
    } else {
      const end = new Date();
      const start = new Date();
      start.setUTCDate(start.getUTCDate() - (dateRange.days - 1));
      const toIso = (d: Date) => d.toISOString().slice(0, 10);
      startIso = toIso(start);
      endIso = toIso(end);
      spanDays = dateRange.days;
    }

    const qs = new URLSearchParams({
      connection_id: String(id),
      days: String(spanDays),
      start_date: startIso,
      end_date: endIso,
    });
    try {
      if (tab === "Consumption") {
        qs.set("usage_type", usageType);
        // Always fetch day grain; By Month aggregates client-side from the same series.
        qs.set("grain", "day");
        qs.set("service_type", serviceType);
        // Resources filter is client-side on the last response (no re-fetch needed).
        const res = await api<Consumption>(`/api/cost/consumption?${qs}`, { signal });
        if (signal.aborted) return;
        setData(res);
      } else if (tab === "Account Overview") {
        const res = await api<AccountOverview>(`/api/cost/account-overview?${qs}`, {
          signal,
        });
        if (signal.aborted) return;
        setOverview(res);
      } else if (tab === "Anomalies") {
        const res = await api<AnomaliesResp>(`/api/cost/anomalies?${qs}`, { signal });
        if (signal.aborted) return;
        setAnom(res);
      } else if (tab === "Resource Monitors") {
        const res = await api<MonitorsResp>(
          `/api/cost/resource-monitors?connection_id=${id}`,
          { signal },
        );
        if (signal.aborted) return;
        setMonitors(res);
      } else if (tab === "Budgets") {
        const res = await api<BudgetsResp>(`/api/cost/budgets?connection_id=${id}`, {
          signal,
        });
        if (signal.aborted) return;
        setBudgets(res);
      } else if (tab === "Organization Overview") {
        const res = await api<OrgResp>(`/api/cost/organization-overview?${qs}`, {
          signal,
        });
        if (signal.aborted) return;
        setOrg(res);
      }
    } catch (e) {
      if (signal.aborted || isAbortError(e)) return;
      setData(null);
      setOverview(null);
      setAnom(null);
      setMonitors(null);
      setBudgets(null);
      setOrg(null);
      setErr(e instanceof ApiError ? e.message : "Falha ao carregar Cost Management.");
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }

  // Load on tab/connection and whenever filters that hit the API change.
  // Resources / By Day|Month still adjust the last response client-side.
  useEffect(() => {
    const t = window.setTimeout(() => void load(), 200);
    return () => {
      window.clearTimeout(t);
      loadAbortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, tab, dateRange, usageType, serviceType]);

  // Changing Service Type invalidates resource picks from other service types.
  useEffect(() => {
    setResourceFilter("All");
  }, [serviceType]);

  const activeConn = connections.find((c) => c.id === connectionId);
  const hasTabData =
    (tab === "Consumption" && !!data) ||
    (tab === "Account Overview" && !!overview) ||
    (tab === "Anomalies" && !!anom) ||
    (tab === "Resource Monitors" && !!monitors) ||
    (tab === "Budgets" && !!budgets) ||
    (tab === "Organization Overview" && !!org);
  // Pill = warehouse saved on the connection only (never role / fake COMPUTE_WH).
  const warehousePill = activeConn
    ? activeConn.warehouse?.trim() || "WH auto"
    : null;

  // Table + KPI + chart share one filtered resource set from the last API response.
  const summaryRows = useMemo(() => {
    if (!data?.summary?.length) return [];
    if (resourceFilter === "All") return data.summary;
    return data.summary.filter((r) => r.name === resourceFilter);
  }, [data, resourceFilter]);

  const allowedResources = useMemo(
    () => new Set(summaryRows.map((r) => r.name)),
    [summaryRows],
  );

  const chartData = useMemo(() => {
    if (!data?.chart?.length || allowedResources.size === 0) return null;
    const byPeriod: Record<string, Record<string, number | string>> = {};
    const resources = new Set<string>();
    for (const row of data.chart) {
      if (!allowedResources.has(row.resource_name)) continue;
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
  }, [data, grain, allowedResources]);

  const resourceOptions = useMemo(() => {
    const names = data?.summary?.map((r) => r.name) || [];
    return [
      { value: "All", label: "All Resources" },
      ...names.map((n) => ({ value: n, label: n })),
    ];
  }, [data]);

  // Drop stale Resources selection after a refresh that no longer includes it.
  useEffect(() => {
    if (resourceFilter === "All" || !data?.summary) return;
    if (!data.summary.some((r) => r.name === resourceFilter)) {
      setResourceFilter("All");
    }
  }, [data, resourceFilter]);

  const noActive = !connectionId;
  const days =
    dateRange.mode === "preset"
      ? dateRange.days
      : Math.max(
          1,
          Math.ceil(
            (Date.parse(dateRange.end) - Date.parse(dateRange.start)) / 86400000,
          ) + 1,
        );
  const showTimeNonConsumption =
    tab === "Account Overview" ||
    tab === "Anomalies" ||
    tab === "Organization Overview";

  const headerCreditsUsed =
    tab === "Consumption" && data
      ? summaryRows.reduce((a, r) => a + r.credits_used, 0)
      : tab === "Account Overview" && overview
        ? overview.total_credits
        : null;

  return (
    <div className="cost-page">
      <div className="cost-sticky-nav">
        <CostPageHeader contextLabel={warehousePill} creditsUsed={headerCreditsUsed} />
        <CostTabs tab={tab} onTab={setTab} />
      </div>

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
            {tab === "Consumption" ? (
              <>
                <DateRangePicker value={dateRange} onChange={setDateRange} />
                {activeConn ? (
                  <span className="account-chip">
                    <select
                      className="account-chip-select"
                      value={String(connectionId)}
                      onChange={(e) => setConnectionId(Number(e.target.value))}
                      aria-label="Account"
                    >
                      {connections.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.account_identifier.includes("-")
                            ? c.account_identifier.split("-").slice(-1)[0]
                            : c.name}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="account-chip-clear"
                      title="Limpar conta ativa"
                      aria-label="Limpar conta ativa"
                      onClick={() => {
                        setActiveConnectionId(null);
                        setConnectionId("");
                      }}
                    >
                      ×
                    </button>
                  </span>
                ) : null}
                <FilterPill
                  label="Tags"
                  value="N/A"
                  onChange={() => undefined}
                  options={[{ value: "N/A", label: "All Tags" }]}
                  disabled
                />
                <span className="cost-filter-divider" aria-hidden />
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
            ) : (
              <>
                <FilterPill
                  label="Account"
                  value={String(connectionId)}
                  onChange={(v) => setConnectionId(Number(v))}
                  options={connections.map((c) => ({
                    value: String(c.id),
                    label: `${c.name} (${c.account_identifier})`,
                  }))}
                />
                {showTimeNonConsumption ? (
                  <FilterPill
                    label="Time Range"
                    value={String(days)}
                    onChange={(v) => setDateRange({ mode: "preset", days: Number(v) })}
                    options={[
                      { value: "7", label: "Last 7 days" },
                      { value: "28", label: "Last 28 days" },
                      { value: "90", label: "Last 3 months" },
                      { value: "180", label: "Last 6 months" },
                      { value: "365", label: "Last 12 months" },
                    ]}
                  />
                ) : null}
              </>
            )}
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
            {tab !== "Resource Monitors" ? (
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
            ) : null}
          </div>

          {err ? <ErrorBanner message={err} connectionId={connectionId} /> : null}

          {loading && !err && !hasTabData ? <CostSkeleton /> : null}

          {tab === "Consumption" && data ? (
            <div className={`cost-tab-body${loading ? " is-refreshing" : ""}`}>
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
            </div>
          ) : null}

          {tab === "Account Overview" && overview ? (
            <div className={`cost-tab-body${loading ? " is-refreshing" : ""}`}>
              <div className="metrics cost-metrics">
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
                <ResponsiveContainer width="100%" height={320}>
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
            </div>
          ) : null}

          {tab === "Anomalies" && anom ? (
            <div className={`cost-tab-body${loading ? " is-refreshing" : ""}`}>
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
            </div>
          ) : null}

          {tab === "Resource Monitors" && monitors ? (
            <div className={`cost-tab-body${loading ? " is-refreshing" : ""}`}>
              <MonitorsPanel
                items={monitors.items || []}
                note={monitors.note}
                onRefresh={() => void load()}
                loading={loading}
              />
            </div>
          ) : null}

          {tab === "Budgets" && budgets ? (
            <div className={`cost-tab-body${loading ? " is-refreshing" : ""}`}>
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
            </div>
          ) : null}

          {tab === "Organization Overview" && org ? (
            <div className={`cost-tab-body${loading ? " is-refreshing" : ""}`}>
              {org.note ? <div className="info-box">{org.note}</div> : null}
              {org.items.length ? (
                <div className="table cost-table cost-table-org">
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
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
