import { useEffect, useId, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { FilterPill } from "./FilterPill";
import { classifyQueryKind } from "./queryKind";
import { ariaSort, levelRank, queueLabelRank, sortIndicator, toggleSort, type SortDir } from "./tableSort";

export type PerformanceRec = {
  level: "ok" | "warn" | "bad" | "neutral" | string;
  code: string;
  text: string;
};

export type PerformanceResp = {
  available: boolean;
  days: number;
  start_date?: string;
  end_date?: string;
  note?: string | null;
  /** When the performance snapshot was last fetched (cache or Snowflake). */
  fetched_at?: string | null;
  cached?: boolean;
  warehouse_filter?: string | null;
  warehouse_options?: string[];
  warehouses: {
    warehouse_name: string;
    size?: string | null;
    mean_running: number;
    mean_queued: number;
    queue_label: string;
    days_with_queue: number;
    recommendation: PerformanceRec;
  }[];
  load_series: { date: string; avg_running: number; avg_queued_load: number }[];
  /** Per warehouse × day load — used to filter Diagnóstico when a chart day is selected. */
  warehouse_daily?: {
    date: string;
    warehouse_name: string;
    avg_running: number;
    avg_queued_load: number;
  }[];
  queries: {
    pattern_key: string;
    query_preview: string;
    /** Snowflake ACCOUNT_USAGE.QUERY_HISTORY.QUERY_TYPE (SELECT, CALL, EXECUTE_STREAMLIT, …). */
    query_type?: string | null;
    sample_query_id: string;
    user_name: string;
    warehouse_name: string;
    executions: number;
    total_elapsed_ms: number;
    total_elapsed_label: string;
    /** Última execução do padrão no período (QUERY_HISTORY end_time / start_time). */
    last_end_time?: string | null;
    spill_label: string;
    recommendation: PerformanceRec;
  }[];
  duration_buckets?: { bucket: string; label: string; query_count: number }[];
};

const QUERY_LIMIT_OPTIONS = [
  { value: "10", label: "10" },
  { value: "20", label: "20" },
  { value: "50", label: "50" },
  { value: "all", label: "Todos" },
] as const;

function badgeClass(level: string): string {
  if (level === "ok") return "perf-badge ok";
  if (level === "warn") return "perf-badge warn";
  if (level === "bad") return "perf-badge bad";
  return "perf-badge neutral";
}

const STATUS_LEVEL_LABEL: Record<string, string> = {
  ok: "ok",
  warn: "atenção",
  bad: "crítico",
  neutral: "neutro",
};

function normalizeStatusLevel(level?: string | null): "ok" | "warn" | "bad" | "neutral" {
  const v = (level || "").toLowerCase();
  if (v === "ok" || v === "warn" || v === "bad") return v;
  return "neutral";
}

function StatusIcon({ level }: { level: "ok" | "warn" | "bad" | "neutral" }) {
  if (level === "neutral") {
    return (
      <span className="perf-status-dash" aria-hidden="true">
        —
      </span>
    );
  }
  return (
    <svg
      className="perf-status-glyph"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {level === "ok" ? (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M8.5 12.5 11 15l4.5-5.5" />
        </>
      ) : null}
      {level === "warn" ? (
        <>
          <path d="M12 3.5 21 19H3L12 3.5z" />
          <path d="M12 9v4.5" />
          <path d="M12 16.5h.01" />
        </>
      ) : null}
      {level === "bad" ? (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="m9 9 6 6" />
          <path d="m15 9-6 6" />
        </>
      ) : null}
    </svg>
  );
}

type StatusDetail = {
  warehouse: string;
  level: "ok" | "warn" | "bad" | "neutral";
  text: string;
};

function WarehouseStatusButton({
  warehouse,
  recommendation,
  onOpen,
}: {
  warehouse: string;
  recommendation?: PerformanceRec | null;
  onOpen: (detail: StatusDetail) => void;
}) {
  const level = normalizeStatusLevel(recommendation?.level);
  const text = (recommendation?.text || "").trim() || "Sem recomendação clara";
  const levelLabel = STATUS_LEVEL_LABEL[level];
  const ariaLabel = `Status ${levelLabel} para ${warehouse}. Abrir recomendação.`;

  return (
    <button
      type="button"
      className={`perf-status-btn ${level}`}
      aria-label={ariaLabel}
      onClick={() => onOpen({ warehouse, level, text })}
    >
      <StatusIcon level={level} />
    </button>
  );
}

function RecommendationModal({
  detail,
  onClose,
}: {
  detail: StatusDetail;
  onClose: () => void;
}) {
  const titleId = useId();
  const levelLabel = STATUS_LEVEL_LABEL[detail.level];

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="admin-modal-backdrop perf-status-backdrop" role="presentation" onClick={onClose}>
      <div
        className="admin-modal perf-status-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="admin-modal-head">
          <div>
            <h2 id={titleId}>WAREHOUSE · {detail.warehouse}</h2>
            <p className="admin-modal-lead">Status: {levelLabel}</p>
          </div>
          <button type="button" className="btn admin-modal-close" onClick={onClose} aria-label="Fechar">
            ×
          </button>
        </div>
        <p className="perf-status-modal-body">{detail.text}</p>
      </div>
    </div>
  );
}


/** Short actionable labels for query hotspot signals. */
const QUERY_REC_SHORT: Record<string, string> = {
  remote_spill: "Spill remoto",
  repeated_heavy: "Muito repetida",
  long_running: "Tempo alto",
};

/** Only warn/bad get a badge; neutral/ok/generic → em dash. */
function querySignal(rec?: PerformanceRec | null): { level: string; text: string } | null {
  if (!rec) return null;
  const level = (rec.level || "").toLowerCase();
  if (level !== "warn" && level !== "bad") return null;
  const short = QUERY_REC_SHORT[rec.code] || rec.text?.trim();
  if (!short) return null;
  return { level, text: short };
}

function shortHash(key: string, n = 8): string {
  if (!key) return "";
  return key.length > n ? `${key.slice(0, n)}…` : key;
}

function queryMeta(userName: string, patternKey: string): string {
  const user = (userName || "").trim() || "—";
  const hash = shortHash(patternKey || "");
  return hash ? `${user} · ${hash}` : user;
}

/** YYYY-MM-DD → DD/MM (pt-BR, never MM/DD). */
function shortDate(iso: string): string {
  if (iso.length >= 10) return `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
  return iso;
}

/** UTC calendar day (YYYY-MM-DD) from an ISO timestamp or date-only string. */
function utcDay(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const trimmed = iso.trim();
  // Date-only → already a UTC calendar day from the API.
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const d = new Date(trimmed);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/** Format API `fetched_at` as pt-BR "dd/mm/aaaa hh:mm". */
function formatFetchedAt(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Format hotspot last_end_time as pt-BR "dd/mm/yyyy hh:mm". */
function formatLastExec(iso: string | null | undefined): string | null {
  return formatFetchedAt(iso);
}

type WarehouseRow = PerformanceResp["warehouses"][number];
type QueryRow = PerformanceResp["queries"][number];
type WarehouseDailyRow = NonNullable<PerformanceResp["warehouse_daily"]>[number];

const QUEUE_RATIO_HIGH = 0.15;
const LOW_LOAD_MAX = 0.45;

function queueLabel(meanQueued: number, queueShare: number): string {
  if (meanQueued >= 0.1 || queueShare >= QUEUE_RATIO_HIGH) return "alta";
  if (meanQueued >= 0.02 || queueShare >= 0.05) return "média";
  return "baixa";
}

function recommendWarehouse(
  meanRunning: number,
  meanQueued: number,
  daysWithQueue: number,
  days: number,
): PerformanceRec {
  const total = meanRunning + meanQueued;
  const queueShare = total > 1e-9 ? meanQueued / total : 0;
  if (meanQueued > 0.05 && (queueShare >= QUEUE_RATIO_HIGH || daysWithQueue >= Math.max(2, Math.floor(days / 3)))) {
    return {
      level: "warn",
      code: "upsize_or_multicluster",
      text: "Fila recorrente — considerar aumentar o tamanho ou multi-cluster / separar workload",
    };
  }
  if (total > 0 && total < LOW_LOAD_MAX && meanQueued < 0.02 && daysWithQueue <= 1) {
    return {
      level: "ok",
      code: "downsize_candidate",
      text: "Carga baixa e pouca fila — candidato a reduzir tamanho ou clusters",
    };
  }
  return { level: "neutral", code: "none", text: "Sem recomendação clara" };
}

/** Build Diagnóstico rows for a single UTC day from warehouse_daily. */
function warehousesForDay(
  daily: WarehouseDailyRow[],
  day: string,
  sizeByName: Map<string, string | null | undefined>,
): WarehouseRow[] {
  const rows: WarehouseRow[] = [];
  for (const r of daily) {
    if (r.date !== day) continue;
    const meanRunning = r.avg_running ?? 0;
    const meanQueued = r.avg_queued_load ?? 0;
    const total = meanRunning + meanQueued;
    const share = total > 1e-9 ? meanQueued / total : 0;
    const daysWithQueue = meanQueued > 0.02 ? 1 : 0;
    rows.push({
      warehouse_name: r.warehouse_name,
      size: sizeByName.get(r.warehouse_name.toUpperCase()) ?? null,
      mean_running: meanRunning,
      mean_queued: meanQueued,
      queue_label: queueLabel(meanQueued, share),
      days_with_queue: daysWithQueue,
      recommendation: recommendWarehouse(meanRunning, meanQueued, daysWithQueue, 1),
    });
  }
  rows.sort((a, b) => b.mean_queued - a.mean_queued || b.mean_running - a.mean_running);
  return rows;
}

function sliceQueries<T>(rows: T[], limit: string): T[] {
  if (limit === "all") return rows;
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return rows.slice(0, 10);
  return rows.slice(0, n);
}

/** "Diagnóstico por warehouse" sortable columns. */
type WhSortKey = "warehouse" | "fila" | "status";

const WH_COLUMNS: { key: WhSortKey; label: string }[] = [
  { key: "warehouse", label: "WAREHOUSE" },
  { key: "fila", label: "FILA" },
  { key: "status", label: "STATUS" },
];

/** FILA and STATUS default to worst-first (desc); WAREHOUSE defaults to A→Z. */
function whDefaultDir(key: WhSortKey): SortDir {
  return key === "warehouse" ? 1 : -1;
}

function compareWarehouses(a: WarehouseRow, b: WarehouseRow, key: WhSortKey, dir: SortDir): number {
  const mul = dir;
  switch (key) {
    case "warehouse":
      return mul * a.warehouse_name.localeCompare(b.warehouse_name);
    case "fila": {
      // Prefer the numeric mean_queued (more precise); fall back to the
      // baixa/média/alta label rank if it's ever missing.
      const av = Number.isFinite(a.mean_queued) ? a.mean_queued : queueLabelRank(a.queue_label);
      const bv = Number.isFinite(b.mean_queued) ? b.mean_queued : queueLabelRank(b.queue_label);
      return mul * (av - bv);
    }
    case "status":
      return mul * (levelRank(a.recommendation?.level) - levelRank(b.recommendation?.level));
    default:
      return 0;
  }
}

/** "Top queries do período" sortable columns. */
type QuerySortKey = "tipo" | "query" | "warehouse" | "exec" | "tempo" | "datetime" | "sinal";

const QUERY_COLUMNS: { key: QuerySortKey; label: string; numeric?: boolean }[] = [
  { key: "tipo", label: "TIPO" },
  { key: "query", label: "QUERY" },
  { key: "warehouse", label: "WAREHOUSE" },
  { key: "exec", label: "EXEC.", numeric: true },
  { key: "tempo", label: "TEMPO", numeric: true },
  { key: "datetime", label: "DATA/HORA", numeric: true },
  { key: "sinal", label: "SINAL" },
];

/** EXEC./TEMPO/SINAL default to highest/worst-first (desc); the rest default ascending. */
function queryDefaultDir(key: QuerySortKey): SortDir {
  return key === "exec" || key === "tempo" || key === "sinal" ? -1 : 1;
}

function compareQueries(a: QueryRow, b: QueryRow, key: QuerySortKey, dir: SortDir): number {
  const mul = dir;
  switch (key) {
    case "tipo": {
      const av = classifyQueryKind(a.query_type, a.query_preview);
      const bv = classifyQueryKind(b.query_type, b.query_preview);
      return mul * av.localeCompare(bv);
    }
    case "query":
      return mul * (a.query_preview || "").localeCompare(b.query_preview || "");
    case "warehouse":
      return mul * (a.warehouse_name || "").localeCompare(b.warehouse_name || "");
    case "exec":
      return mul * ((a.executions ?? 0) - (b.executions ?? 0));
    case "tempo":
      return mul * ((a.total_elapsed_ms ?? 0) - (b.total_elapsed_ms ?? 0));
    case "datetime": {
      // Rows without a last execution (display "—") sort to the start of
      // the ascending order.
      const at = a.last_end_time ? new Date(a.last_end_time).getTime() : 0;
      const bt = b.last_end_time ? new Date(b.last_end_time).getTime() : 0;
      const av = Number.isFinite(at) ? at : 0;
      const bv = Number.isFinite(bt) ? bt : 0;
      return mul * (av - bv);
    }
    case "sinal":
      return mul * (levelRank(a.recommendation?.level) - levelRank(b.recommendation?.level));
    default:
      return 0;
  }
}

export function PerformancePanel({
  data,
  loading,
}: {
  data: PerformanceResp;
  loading?: boolean;
}) {
  const [queryLimit, setQueryLimit] = useState("10");
  const [statusDetail, setStatusDetail] = useState<StatusDetail | null>(null);
  /** Selected chart day (UTC ISO YYYY-MM-DD); null = full Time Range. */
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  // Drop day filter when the loaded window / warehouse scope changes.
  useEffect(() => {
    setSelectedDay(null);
  }, [data.start_date, data.end_date, data.warehouse_filter, data.days]);

  const chartRows = useMemo(
    () =>
      (data.load_series ?? []).map((r) => ({
        dateIso: r.date,
        date: shortDate(r.date),
        running: r.avg_running,
        queued: r.avg_queued_load,
      })),
    [data.load_series],
  );

  function toggleDay(dayIso: string) {
    setSelectedDay((prev) => (prev === dayIso ? null : dayIso));
  }

  const sizeByName = useMemo(() => {
    const map = new Map<string, string | null | undefined>();
    for (const w of data.warehouses ?? []) {
      map.set(w.warehouse_name.toUpperCase(), w.size);
    }
    return map;
  }, [data.warehouses]);

  const filteredWarehouses = useMemo(() => {
    if (!selectedDay) return data.warehouses ?? [];
    const daily = data.warehouse_daily ?? [];
    if (!daily.length) return [];
    return warehousesForDay(daily, selectedDay, sizeByName);
  }, [selectedDay, data.warehouses, data.warehouse_daily, sizeByName]);

  const allQueries = useMemo(() => {
    const rows = data.queries ?? [];
    if (!selectedDay) return rows;
    return rows.filter((q) => utcDay(q.last_end_time) === selectedDay);
  }, [data.queries, selectedDay]);

  // Diagnóstico por warehouse: default matches the API's own worst-queue-first order.
  const [whSortKey, setWhSortKey] = useState<WhSortKey>("fila");
  const [whSortDir, setWhSortDir] = useState<SortDir>(-1);
  function toggleWhSort(key: WhSortKey) {
    toggleSort(key, whSortKey, setWhSortKey, setWhSortDir, whDefaultDir);
  }
  const sortedWarehouses = useMemo(() => {
    const copy = [...filteredWarehouses];
    copy.sort((a, b) => compareWarehouses(a, b, whSortKey, whSortDir));
    return copy;
  }, [filteredWarehouses, whSortKey, whSortDir]);

  // Top queries do período: default matches the API's own slowest-first order.
  const [querySortKey, setQuerySortKey] = useState<QuerySortKey>("tempo");
  const [querySortDir, setQuerySortDir] = useState<SortDir>(-1);
  function toggleQuerySort(key: QuerySortKey) {
    toggleSort(key, querySortKey, setQuerySortKey, setQuerySortDir, queryDefaultDir);
  }
  const sortedQueries = useMemo(() => {
    const copy = [...allQueries];
    copy.sort((a, b) => compareQueries(a, b, querySortKey, querySortDir));
    return copy;
  }, [allQueries, querySortKey, querySortDir]);
  const visibleQueries = sliceQueries(sortedQueries, queryLimit);

  const queriesTitle = selectedDay
    ? `Top queries do dia ${shortDate(selectedDay)}`
    : "Top queries do período";

  return (
    <div className={`cost-tab-body perf-panel${loading ? " is-refreshing" : ""}`}>
      {data.note ? <div className="info-box">{data.note}</div> : null}
      {!data.available && !data.note ? (
        <div className="cost-empty-state" role="status">
          <strong className="cost-empty-state-title">Performance indisponível</strong>
          <p>Não foi possível ler ACCOUNT_USAGE para esta conexão.</p>
        </div>
      ) : null}

      <h3 className="perf-section-title">
        Warehouses <small>carga, fila e sugestões</small>
      </h3>
      <div className="perf-grid">
        <div className="perf-card">
          <div className="perf-card-head">
            <div>
              <h4>Carga e fila (por dia)</h4>
              <p className="muted perf-card-desc">
                Running = queries em execução · Queued = fila por sobrecarga · clique no dia para
                filtrar
              </p>
            </div>
            {selectedDay ? (
              <button
                type="button"
                className="perf-day-chip"
                onClick={() => setSelectedDay(null)}
                aria-label={`Limpar filtro do dia ${shortDate(selectedDay)}`}
              >
                Dia: {shortDate(selectedDay)}
                <span aria-hidden="true">×</span>
              </button>
            ) : null}
          </div>
          {chartRows.length ? (
            <div className="chart-wrap cost-chart perf-load-chart">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={chartRows}
                  style={{ cursor: "pointer" }}
                  onClick={(state) => {
                    const iso =
                      (state?.activePayload?.[0]?.payload as { dateIso?: string } | undefined)
                        ?.dateIso ??
                      (typeof state?.activeLabel === "string"
                        ? chartRows.find((r) => r.date === state.activeLabel)?.dateIso
                        : undefined);
                    if (iso) toggleDay(iso);
                  }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#2A2F36" vertical={false} />
                  <XAxis dataKey="date" stroke="#8B939E" tick={{ fontSize: 11 }} />
                  <YAxis stroke="#8B939E" tick={{ fontSize: 11 }} />
                  <Tooltip
                    contentStyle={{
                      background: "#1A1D21",
                      border: "1px solid #2A2F36",
                    }}
                    labelFormatter={(_, payload) => {
                      const iso = (payload?.[0]?.payload as { dateIso?: string } | undefined)?.dateIso;
                      return iso ? shortDate(iso) : "";
                    }}
                  />
                  <Legend />
                  <Bar dataKey="running" name="Running" fill="#29B5E8" stackId="a" cursor="pointer">
                    {chartRows.map((entry) => {
                      const active = selectedDay === entry.dateIso;
                      const dimmed = Boolean(selectedDay) && !active;
                      return (
                        <Cell
                          key={`run-${entry.dateIso}`}
                          fill={active ? "#5ec8f0" : "#29B5E8"}
                          fillOpacity={dimmed ? 0.35 : 1}
                        />
                      );
                    })}
                  </Bar>
                  <Bar dataKey="queued" name="Queued" fill="#f5a524" stackId="a" cursor="pointer">
                    {chartRows.map((entry) => {
                      const active = selectedDay === entry.dateIso;
                      const dimmed = Boolean(selectedDay) && !active;
                      return (
                        <Cell
                          key={`q-${entry.dateIso}`}
                          fill={active ? "#ffc15a" : "#f5a524"}
                          fillOpacity={dimmed ? 0.35 : 1}
                        />
                      );
                    })}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="info-box">Sem séries de carga no período.</div>
          )}
        </div>

        <div className="perf-card">
          <h4>
            Diagnóstico por warehouse
            {selectedDay ? (
              <small className="perf-day-hint"> · {shortDate(selectedDay)}</small>
            ) : null}
          </h4>
          {sortedWarehouses.length ? (
            <div
              className={
                sortedWarehouses.length > 5
                  ? "table cost-table perf-table perf-wh-table perf-wh-scroll"
                  : "table cost-table perf-table perf-wh-table"
              }
            >
              <div className="table-head" role="row">
                {WH_COLUMNS.map((col) => {
                  const active = whSortKey === col.key;
                  return (
                    <button
                      key={col.key}
                      type="button"
                      className={`perf-th${active ? " is-sorted" : ""}`}
                      onClick={() => toggleWhSort(col.key)}
                      aria-sort={ariaSort(active, whSortDir)}
                    >
                      <span>{col.label}</span>
                      <span className="perf-sort-ind" aria-hidden="true">
                        {sortIndicator(active, whSortDir)}
                      </span>
                    </button>
                  );
                })}
              </div>
              {sortedWarehouses.map((w) => (
                <div key={w.warehouse_name} className="table-row">
                  <span className="perf-wh-name" title={w.warehouse_name}>
                    {w.warehouse_name}
                  </span>
                  <span className="perf-wh-fila">{w.queue_label}</span>
                  <span className="perf-wh-status">
                    <WarehouseStatusButton
                      warehouse={w.warehouse_name}
                      recommendation={w.recommendation}
                      onOpen={setStatusDetail}
                    />
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="info-box">
              {selectedDay
                ? "Nenhum warehouse com carga neste dia."
                : "Nenhum warehouse com carga no período."}
            </div>
          )}
        </div>
      </div>

      <h3 className="perf-section-title">Queries</h3>
      <div className="perf-card">
        <div className="perf-queries-header">
          <div className="perf-queries-heading">
            <h4>{queriesTitle}</h4>
            <p className="muted perf-card-desc">
              Fonte: ACCOUNT_USAGE.QUERY_HISTORY · agrupamento por query_hash quando repetida
              {selectedDay
                ? " · filtro pelo dia da última execução (UTC)"
                : ""}
            </p>
          </div>
          <div className="perf-queries-header-right">
            {!selectedDay &&
            data.duration_buckets &&
            data.duration_buckets.some((b) => b.query_count > 0) ? (
              <div className="perf-buckets" aria-label="Distribuição por duração">
                {data.duration_buckets.map((b) => (
                  <div key={b.bucket} className="perf-bucket">
                    <span className="muted">{b.label}</span>
                    <strong>{b.query_count.toLocaleString("pt-BR")}</strong>
                  </div>
                ))}
              </div>
            ) : null}
            {allQueries.length ? (
              <FilterPill
                label="Top"
                value={queryLimit}
                onChange={setQueryLimit}
                options={[...QUERY_LIMIT_OPTIONS]}
                disabled={loading}
              />
            ) : null}
          </div>
        </div>
        {allQueries.length ? (
          <div className="perf-queries-scroll" role="region" aria-label={queriesTitle}>
            <div className="table cost-table perf-table perf-queries">
              <div className="table-head" role="row">
                {QUERY_COLUMNS.map((col) => {
                  const active = querySortKey === col.key;
                  return (
                    <button
                      key={col.key}
                      type="button"
                      className={`perf-th${col.numeric ? " perf-num" : ""}${active ? " is-sorted" : ""}`}
                      onClick={() => toggleQuerySort(col.key)}
                      aria-sort={ariaSort(active, querySortDir)}
                    >
                      <span>{col.label}</span>
                      <span className="perf-sort-ind" aria-hidden="true">
                        {sortIndicator(active, querySortDir)}
                      </span>
                    </button>
                  );
                })}
              </div>
              {visibleQueries.map((q) => {
                const signal = querySignal(q.recommendation);
                const warehouse = q.warehouse_name || "—";
                const lastExec = formatLastExec(q.last_end_time);
                const kind = classifyQueryKind(q.query_type, q.query_preview);
                return (
                  <div key={q.pattern_key || q.sample_query_id} className="table-row">
                    <span className="perf-kind-cell">
                      <span
                        className={`perf-kind-badge kind-${kind.replace(/\s+/g, "-").toLowerCase()}`}
                        title={q.query_type ? `QUERY_TYPE: ${q.query_type}` : undefined}
                      >
                        {kind}
                      </span>
                    </span>
                    <span className="perf-query-cell">
                      <div className="perf-preview" title={q.query_preview || undefined}>
                        {q.query_preview || "—"}
                      </div>
                      <div className="muted mono perf-meta">
                        {queryMeta(q.user_name, q.pattern_key)}
                      </div>
                    </span>
                    <span className="perf-wh-cell" title={warehouse !== "—" ? warehouse : undefined}>
                      {warehouse}
                    </span>
                    <span className="perf-num">{q.executions}</span>
                    <span className="perf-num">{q.total_elapsed_label}</span>
                    <span className="perf-num perf-datetime" title={q.last_end_time || undefined}>
                      {lastExec ?? "—"}
                    </span>
                    <span className="perf-signal-cell">
                      {signal ? (
                        <span className={badgeClass(signal.level)} title={q.recommendation?.text}>
                          {signal.text}
                        </span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="info-box">
            {selectedDay
              ? "Nenhuma query com última execução neste dia."
              : "Nenhuma query relevante no período."}
          </div>
        )}
      </div>

      {statusDetail ? (
        <RecommendationModal detail={statusDetail} onClose={() => setStatusDetail(null)} />
      ) : null}
    </div>
  );
}
