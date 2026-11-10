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
import { FilterPill, type FilterPillOption } from "../components/cost/FilterPill";
import { MonitorsPanel } from "../components/cost/MonitorsPanel";
import { StackedConsumptionChart } from "../components/cost/StackedConsumptionChart";
import { useRefresh } from "../refresh/RefreshContext";
import { RefreshIconButton } from "../refresh/RefreshIconButton";

type Conn = {
  id: number;
  name: string;
  account_identifier: string;
  warehouse?: string | null;
  role_name?: string | null;
};

type StackBy = "service" | "resource" | "account";

type Consumption = {
  total_credits: number;
  summary: { name: string; type: string; tags: string; credits_used: number }[];
  chart: { period_start: string; resource_name: string; credits: number }[];
  available?: boolean;
  stack_by?: StackBy;
  note?: string | null;
};

type ServiceTypesResp = {
  items: { value: string; label: string; consumed: boolean }[];
  note: string | null;
};

const STACK_LABELS: Record<StackBy, { view: string; header: string }> = {
  service: { view: "View by Service", header: "SERVICE" },
  resource: { view: "View by Resource", header: "NAME" },
  account: { view: "View by Account", header: "ACCOUNT" },
};

/** Warehouse totals differ between these views because the Snowflake sources lag differently. */
const WAREHOUSE_SOURCE_HINTS: Partial<Record<StackBy, { label: string; text: string }>> = {
  resource: {
    label: "ACCOUNT_USAGE",
    text:
      "Fonte: ACCOUNT_USAGE.METERING_HISTORY da conta conectada (atraso de até ~3h). " +
      "Na visão por conta, as demais contas vêm de ORGANIZATION_USAGE.METERING_DAILY_HISTORY, " +
      "que pode atrasar até ~24h nos dias mais recentes.",
  },
  account: {
    label: "ORGANIZATION_USAGE",
    text:
      "Conta conectada: ACCOUNT_USAGE.METERING_DAILY_HISTORY (atraso de até ~3h). Demais contas: " +
      "ORGANIZATION_USAGE.METERING_DAILY_HISTORY (consolidado da organização, atraso de até " +
      "~24h) — os dias mais recentes dessas contas podem subir depois.",
  },
};

type OrgAccountsResp = {
  available: boolean;
  accounts: string[];
  note: string | null;
};

const ALL_ACCOUNTS = "__all__";
/** Connection changed and its Snowflake account is still being resolved. */
const PENDING_ACCOUNT = "__pending__";
/** Connection account could not be resolved — never show another account in its place. */
const UNKNOWN_ACCOUNT = "__unknown__";

type ConnAccount = {
  account_name: string | null;
  organization_name: string | null;
  account_locator: string | null;
  account_identifier?: string | null;
  source: "snowflake" | "identifier";
  note?: string | null;
};

/** Org account list with the connection's own account guaranteed (stale identifier fallbacks mapped). */
function accountsWithRelated(
  list: string[],
  related: string | null,
  identifier: string | undefined,
): string[] {
  const ident = identifier?.trim().toUpperCase();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [...list, ...(related ? [related] : [])]) {
    const name = related && ident && raw.trim().toUpperCase() === ident ? related : raw.trim();
    const key = name.toUpperCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

const sameAccount = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.toUpperCase() === b.toUpperCase();

type AccountOverview = {
  days: number;
  total_credits: number;
  by_service: { label: string; credits: number }[];
  storage_bytes?: number | null;
  storage_tb: number | null;
  storage_note: string | null;
};

function formatStorage(o: AccountOverview): string {
  const bytes = o.storage_bytes ?? (o.storage_tb != null ? o.storage_tb * 1024 ** 4 : null);
  if (bytes == null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

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
  /** `false` when Budgets is not enabled for the account or the role lacks privileges. */
  supported?: boolean;
  reason?: "unsupported" | "privileges";
  message?: string;
  help?: string;
  detail?: string;
};

type OrgResp = {
  available: boolean;
  items: { usage_date: string; account_name: string; credits_used: number }[];
  note: string | null;
};

const DEFAULT_SERVICE_TYPE = "WAREHOUSE_METERING";
const DEFAULT_SERVICE_OPTIONS: FilterPillOption[] = [
  { value: "All", label: "All" },
  { value: DEFAULT_SERVICE_TYPE, label: "Warehouse" },
];

export function CostManagementPage() {
  const [connections, setConnections] = useState<Conn[]>([]);
  const [connectionId, setConnectionId] = useState<number | "">(getActiveConnectionId() ?? "");
  const [dateRange, setDateRange] = useState<DateRangeValue>({ mode: "preset", days: 7 });
  const [usageType, setUsageType] = useState("Compute");
  const [grain, setGrain] = useState("day");
  const [serviceType, setServiceType] = useState(DEFAULT_SERVICE_TYPE);
  const [serviceOptions, setServiceOptions] = useState(DEFAULT_SERVICE_OPTIONS);
  const [resourceFilter, setResourceFilter] = useState("All");
  /** Account the connection lands on (`/api/cost/connection-account`), keyed by connection. */
  const [connAccount, setConnAccount] = useState<{ connId: number; info: ConnAccount | null } | null>(
    null,
  );
  /**
   * Right-hand account pick, owned by one connection: `__all__`, ACCOUNT_NAME or `__unknown__`.
   * Any other connection id means "not picked yet" and resolves to the connection's account.
   */
  const [accountPick, setAccountPick] = useState<{ connId: number | ""; value: string }>({
    connId: "",
    value: ALL_ACCOUNTS,
  });
  const [orgAccounts, setOrgAccounts] = useState<string[]>([]);
  const [orgAccountsNote, setOrgAccountsNote] = useState<string | null>(null);
  /** Dimension the Consumption chart/table series represent (from the API `stack_by`). */
  const [stackBy, setStackBy] = useState<StackBy>("service");
  const [data, setData] = useState<Consumption | null>(null);
  /** UTC window (inclusive YYYY-MM-DD) the current `data` was fetched for. */
  const [dataWindow, setDataWindow] = useState<{ start: string; end: string } | null>(null);
  const [overview, setOverview] = useState<AccountOverview | null>(null);
  const [anom, setAnom] = useState<AnomaliesResp | null>(null);
  const [monitors, setMonitors] = useState<MonitorsResp | null>(null);
  const [budgets, setBudgets] = useState<BudgetsResp | null>(null);
  const [org, setOrg] = useState<OrgResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<CostTab>("Consumption");
  const loadAbortRef = useRef<AbortController | null>(null);
  const skipConnListRefresh = useRef(true);
  const { refreshToken, refreshError } = useRefresh();

  /** Keep warehouse pill in sync with Conexões (saved `connection.warehouse`). */
  function reloadConnections(opts?: { syncActive?: boolean }) {
    void api<Conn[]>("/api/connections")
      .then((list) => {
        setConnections(list);
        if (!opts?.syncActive) return;
        const active = getActiveConnectionId();
        if (active && list.some((c) => c.id === active)) {
          setConnectionId(active);
        } else if (!active) {
          setConnectionId("");
        }
      })
      .catch(() => {
        /* keep prior list; cost load surfaces auth/network errors */
      });
  }

  // Mount + window focus / tab visible — pick up WH saved in Conexões without stale cache.
  useEffect(() => {
    reloadConnections({ syncActive: true });
    const onFocus = () => reloadConnections();
    const onVis = () => {
      if (document.visibilityState === "visible") reloadConnections();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  // After switching account in the Cost dropdown, refresh list so pill WH matches API.
  useEffect(() => {
    if (skipConnListRefresh.current) {
      skipConnListRefresh.current = false;
      return;
    }
    if (connectionId === "") return;
    reloadConnections();
  }, [connectionId]);

  // Global refresh may have healed the stored warehouse; pick it up for the pill.
  useEffect(() => {
    if (refreshToken > 0) reloadConnections();
  }, [refreshToken]);

  // If stored WH is gone on the account, /options auto-persists the suggested WH —
  // then refresh the connections list so the header pill updates without visiting Conexões.
  useEffect(() => {
    if (!connectionId) return;
    const id = Number(connectionId);
    if (!id) return;
    let cancelled = false;
    void api<{ warehouse_auto_saved?: string | null }>(`/api/connections/${id}/options`)
      .then((res) => {
        if (cancelled) return;
        if (res.warehouse_auto_saved) reloadConnections();
      })
      .catch(() => {
        /* Cost load surfaces auth/network errors; heal is best-effort */
      });
    return () => {
      cancelled = true;
    };
  }, [connectionId]);

  // Full Service Type catalog (cached server-side); consumed services get a marker.
  useEffect(() => {
    if (!connectionId) {
      setServiceOptions(DEFAULT_SERVICE_OPTIONS);
      return;
    }
    let cancelled = false;
    void api<ServiceTypesResp>(`/api/cost/service-types?connection_id=${Number(connectionId)}`)
      .then((res) => {
        if (cancelled || !res.items?.length) return;
        setServiceOptions(
          res.items.map((o) => ({
            value: o.value,
            label: o.label,
            consumed: Boolean(o.consumed) && o.value !== "All",
          })),
        );
      })
      .catch(() => {
        /* keep prior options; cost load surfaces auth/network errors */
      });
    return () => {
      cancelled = true;
    };
  }, [connectionId, refreshToken]);

  // Resolve which Snowflake account the selected connection belongs to (cached server-side).
  useEffect(() => {
    if (!connectionId) {
      setConnAccount(null);
      return;
    }
    const id = Number(connectionId);
    let cancelled = false;
    void api<ConnAccount>(`/api/cost/connection-account?connection_id=${id}`)
      .then((info) => {
        if (!cancelled) setConnAccount({ connId: id, info });
      })
      .catch(() => {
        if (!cancelled) setConnAccount({ connId: id, info: null });
      });
    return () => {
      cancelled = true;
    };
  }, [connectionId, refreshToken]);

  /** `undefined` while resolving, `null` when the account could not be identified. */
  const relatedAccount: string | null | undefined =
    connectionId !== "" && connAccount?.connId === connectionId
      ? connAccount.info?.account_name?.trim() || null
      : undefined;
  const accountFilter =
    connectionId !== "" && accountPick.connId === connectionId
      ? accountPick.value
      : PENDING_ACCOUNT;

  // Every connection change (pick, restore, initial load) lands on the connection's own account.
  useEffect(() => {
    if (connectionId === "" || relatedAccount === undefined) return;
    if (accountPick.connId === connectionId) return;
    setAccountPick({ connId: connectionId, value: relatedAccount ?? UNKNOWN_ACCOUNT });
  }, [connectionId, relatedAccount, accountPick.connId]);

  function selectConnection(id: number | "") {
    setAccountPick({ connId: "", value: PENDING_ACCOUNT });
    setConnectionId(id);
    setActiveConnectionId(id === "" ? null : id);
  }

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
      setOrgAccounts([]);
      setOrgAccountsNote(null);
      setStackBy("service");
      setLoading(false);
      return;
    }
    if (tab === "Consumption" && accountFilter === PENDING_ACCOUNT) {
      // Re-runs once the connection's account resolves; never query with a stale account.
      loadAbortRef.current?.abort();
      loadAbortRef.current = null;
      setErr(null);
      setLoading(true);
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
        const related = relatedAccount ?? null;
        const accountsRes = await api<OrgAccountsResp>(`/api/cost/org-accounts?${qs}`, {
          signal,
        });
        if (signal.aborted) return;
        const names = accountsWithRelated(
          accountsRes.accounts ?? [],
          related,
          connections.find((c) => c.id === id)?.account_identifier,
        );
        setOrgAccounts(names);
        setOrgAccountsNote(accountsRes.note);
        // A pick the org list no longer includes falls back to the connection's account.
        let effectiveAccount = accountFilter;
        if (
          effectiveAccount !== ALL_ACCOUNTS &&
          effectiveAccount !== UNKNOWN_ACCOUNT &&
          !names.some((n) => sameAccount(n, effectiveAccount))
        ) {
          effectiveAccount = related ?? UNKNOWN_ACCOUNT;
          setAccountPick({ connId: id, value: effectiveAccount });
        }
        const isOwnAccount =
          effectiveAccount === UNKNOWN_ACCOUNT || sameAccount(effectiveAccount, related);

        const canUseOrg =
          accountsRes.available && names.length > 0 && effectiveAccount !== UNKNOWN_ACCOUNT;
        if (canUseOrg) {
          const orgQs = new URLSearchParams(qs);
          if (effectiveAccount !== ALL_ACCOUNTS) {
            orgQs.set("account_name", effectiveAccount);
          }
          const res = await api<Consumption>(`/api/cost/org-consumption?${orgQs}`, {
            signal,
          });
          if (signal.aborted) return;
          // Own account without ORGANIZATION_USAGE rows: its ACCOUNT_USAGE is the source of truth.
          if (res.available === false || (isOwnAccount && !res.summary?.length)) {
            // Fall back to single-account warehouse metering.
            const wh = await api<Consumption>(`/api/cost/consumption?${qs}`, { signal });
            if (signal.aborted) return;
            setData(wh);
            setStackBy(wh.stack_by ?? "resource");
          } else {
            setData(res);
            setStackBy(res.stack_by ?? "account");
          }
        } else {
          const res = await api<Consumption>(`/api/cost/consumption?${qs}`, { signal });
          if (signal.aborted) return;
          setData(res);
          setStackBy(res.stack_by ?? "resource");
        }
        setDataWindow({ start: startIso, end: endIso });
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
      setOrgAccounts([]);
      setStackBy("service");
      setErr(e instanceof ApiError ? e.message : "Falha ao carregar Cost Management.");
    } finally {
      // Only the latest in-flight request may clear the spinner (aborts leave loading on).
      if (loadAbortRef.current === ac) setLoading(false);
    }
  }

  // Stable filter key — avoid re-running when dateRange object identity churns.
  const dateKey =
    dateRange.mode === "preset"
      ? `p:${dateRange.days}`
      : `c:${dateRange.start}:${dateRange.end}`;

  // Load on tab/connection and whenever filters that hit the API change.
  // Resources / By Day|Month still adjust the last response client-side.
  useEffect(() => {
    const t = window.setTimeout(() => void load(), 200);
    return () => {
      window.clearTimeout(t);
      loadAbortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, tab, dateKey, usageType, serviceType, accountFilter, refreshToken]);

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
    // Days without metering rows still belong to the window (Snowsight shows them as 0).
    if (grain === "day" && dataWindow) {
      const day = new Date(`${dataWindow.start}T00:00:00Z`);
      const last = new Date(`${dataWindow.end}T00:00:00Z`);
      while (day <= last) {
        const key = day.toISOString().slice(0, 10);
        if (!byPeriod[key]) byPeriod[key] = { period: key };
        day.setUTCDate(day.getUTCDate() + 1);
      }
    }
    return {
      rows: Object.values(byPeriod).sort((a, b) =>
        String(a.period).localeCompare(String(b.period)),
      ),
      resources: Array.from(resources),
    };
  }, [data, dataWindow, grain, allowedResources]);

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

  const relatedInfo = connAccount?.connId === connectionId ? connAccount.info : null;
  const relatedLabel =
    relatedAccount === undefined
      ? "Identificando conta…"
      : relatedAccount ?? "Conta não identificada";
  const accountHint = activeConn
    ? [
        `Conta da conexão ${activeConn.name}: ${relatedLabel}`,
        relatedInfo?.organization_name && relatedAccount
          ? `${relatedInfo.organization_name}.${relatedAccount}`
          : null,
        relatedInfo?.account_locator ? `locator ${relatedInfo.account_locator}` : null,
        relatedInfo?.source === "identifier"
          ? `derivada do identificador ${relatedInfo.account_identifier ?? activeConn.account_identifier}`
          : null,
        relatedInfo?.note || null,
      ]
        .filter(Boolean)
        .join(" · ")
    : undefined;

  /** Org Overview filters its rows client-side by the same account pick. */
  const orgAccountNames = useMemo(
    () =>
      accountsWithRelated(
        Array.from(new Set((org?.items ?? []).map((r) => String(r.account_name ?? "")))),
        relatedAccount ?? null,
        activeConn?.account_identifier,
      ),
    [org, relatedAccount, activeConn?.account_identifier],
  );
  const orgItems = useMemo(() => {
    const items = org?.items ?? [];
    if (
      accountFilter === ALL_ACCOUNTS ||
      accountFilter === PENDING_ACCOUNT ||
      accountFilter === UNKNOWN_ACCOUNT
    ) {
      return items;
    }
    return items.filter((r) => sameAccount(r.account_name, accountFilter));
  }, [org, accountFilter]);

  /** Account pill: editable where the data spans the org, locked to the connection elsewhere. */
  const accountEditable = tab === "Consumption" || tab === "Organization Overview";
  const accountOptions: { value: string; label: string }[] = (() => {
    if (accountFilter === PENDING_ACCOUNT) {
      return [{ value: PENDING_ACCOUNT, label: relatedLabel }];
    }
    if (!accountEditable) return [{ value: accountFilter, label: relatedLabel }];
    const names = tab === "Consumption" ? orgAccounts : orgAccountNames;
    const list = accountsWithRelated(names, relatedAccount ?? null, activeConn?.account_identifier);
    return [
      { value: ALL_ACCOUNTS, label: "All Accounts" },
      ...(accountFilter === UNKNOWN_ACCOUNT
        ? [{ value: UNKNOWN_ACCOUNT, label: "Conta não identificada" }]
        : []),
      ...list.map((n) => ({ value: n, label: n })),
    ];
  })();
  const accountSelectValue =
    accountEditable && accountOptions.some((o) => o.value === accountFilter)
      ? accountFilter
      : accountOptions.find((o) => sameAccount(o.value, accountFilter))?.value ??
        accountOptions[0]?.value ??
        "";

  const connectionPair = activeConn ? (
    <>
      <span className="account-chip">
        <select
          className="account-chip-select"
          value={String(connectionId)}
          onChange={(e) => selectConnection(Number(e.target.value))}
          aria-label="Connection"
        >
          {connections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </span>
      <span
        className={`account-chip account-chip-all${
          accountFilter === PENDING_ACCOUNT ||
          accountFilter === UNKNOWN_ACCOUNT ||
          (!accountEditable && relatedAccount === null)
            ? " is-unresolved"
            : ""
        }`}
        title={[accountHint, tab === "Consumption" ? orgAccountsNote : null]
          .filter(Boolean)
          .join("\n")}
      >
        <select
          className="account-chip-select"
          value={accountSelectValue}
          onChange={(e) => setAccountPick({ connId: connectionId, value: e.target.value })}
          disabled={!accountEditable || accountFilter === PENDING_ACCOUNT}
          aria-label="Account"
        >
          {accountOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </span>
    </>
  ) : null;

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
                {connectionPair}
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
                  options={serviceOptions}
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
                {connectionPair}
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
              <RefreshIconButton disabled={loading} />
            ) : null}
          </div>

          {refreshError ? (
            <div className="warn-box refresh-error-box">{refreshError}</div>
          ) : null}
          {err ? <ErrorBanner message={err} connectionId={connectionId} /> : null}

          {loading && !err && !hasTabData ? <CostSkeleton /> : null}

          {tab === "Consumption" && data ? (
            <div className={`cost-tab-body${loading ? " is-refreshing" : ""}`}>
              {orgAccountsNote && stackBy === "resource" ? (
                <div className="info-box">{orgAccountsNote}</div>
              ) : null}
              {chartData?.rows.length ? (
                <StackedConsumptionChart
                  rows={chartData.rows}
                  resources={chartData.resources}
                  grain={grain}
                  onGrain={setGrain}
                  viewByLabel={STACK_LABELS[stackBy].view}
                  sourceHint={
                    // Only when both views exist; without ORGANIZATION_USAGE there is nothing to compare.
                    serviceType === DEFAULT_SERVICE_TYPE && !orgAccountsNote
                      ? WAREHOUSE_SOURCE_HINTS[stackBy]
                      : null
                  }
                />
              ) : (
                <div className="info-box">Nenhum consumo no período.</div>
              )}
              <CreditsTable
                rows={summaryRows}
                nameHeader={STACK_LABELS[stackBy].header}
                typeHeader="TYPE"
              />
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
                  <span className="muted">Storage (approx)</span>
                  <strong>{formatStorage(overview)}</strong>
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
                loading={loading}
              />
            </div>
          ) : null}

          {tab === "Budgets" && budgets ? (
            <div className={`cost-tab-body${loading ? " is-refreshing" : ""}`}>
              {budgets.supported === false ? (
                <div className="cost-empty-state" role="status">
                  <strong className="cost-empty-state-title">
                    {budgets.reason === "privileges"
                      ? "Sem acesso aos Budgets"
                      : "Budgets não disponível nesta conta"}
                  </strong>
                  {budgets.message ? <p>{budgets.message}</p> : null}
                  {budgets.help ? <p className="muted">{budgets.help}</p> : null}
                  {budgets.detail ? (
                    <details className="cost-empty-state-detail">
                      <summary>Detalhe técnico</summary>
                      <code>{budgets.detail}</code>
                    </details>
                  ) : null}
                </div>
              ) : null}
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
              ) : !budgets.note && budgets.supported !== false ? (
                <div className="info-box">Nenhum budget configurado nesta conta.</div>
              ) : null}
            </div>
          ) : null}

          {tab === "Organization Overview" && org ? (
            <div className={`cost-tab-body${loading ? " is-refreshing" : ""}`}>
              {org.note ? <div className="info-box">{org.note}</div> : null}
              {org.items.length && !orgItems.length ? (
                <div className="info-box">Nenhum consumo desta conta no período.</div>
              ) : null}
              {orgItems.length ? (
                <div className="table cost-table cost-table-org">
                  <div className="table-head">
                    <span>DATE</span>
                    <span>ACCOUNT</span>
                    <span>CREDITS</span>
                  </div>
                  {orgItems.map((r, i) => (
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
