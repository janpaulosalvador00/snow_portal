import { useEffect, useId, useState } from "react";
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
import { FilterPill } from "./FilterPill";

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
  queries: {
    pattern_key: string;
    query_preview: string;
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
            <h2 id={titleId}>Recomendação · {detail.warehouse}</h2>
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

function shortDate(iso: string): string {
  // YYYY-MM-DD → MM/DD
  if (iso.length >= 10) return `${iso.slice(5, 7)}/${iso.slice(8, 10)}`;
  return iso;
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

/** Split ISO timestamp into pt-BR date + time for Top queries columns. */
function formatLastExecParts(iso: string | null | undefined): { date: string; time: string } | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return {
    date: d.toLocaleDateString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    }),
    time: d.toLocaleTimeString("pt-BR", {
      hour: "2-digit",
      minute: "2-digit",
    }),
  };
}

function FetchedAtLabel({
  fetchedAt,
  cached,
}: {
  fetchedAt?: string | null;
  cached?: boolean;
}) {
  const label = formatFetchedAt(fetchedAt);
  if (!label) return null;
  return (
    <p
      className="muted perf-fetched-at"
      title={cached ? "Snapshot em cache" : "Atualizado agora"}
    >
      Executado em {label}
      {cached ? " (cache)" : ""}
    </p>
  );
}

function sliceQueries<T>(rows: T[], limit: string): T[] {
  if (limit === "all") return rows;
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return rows.slice(0, 10);
  return rows.slice(0, n);
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
  const chartRows = (data.load_series ?? []).map((r) => ({
    date: shortDate(r.date),
    running: r.avg_running,
    queued: r.avg_queued_load,
  }));
  const allQueries = data.queries ?? [];
  const visibleQueries = sliceQueries(allQueries, queryLimit);

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
          <h4>Carga e fila (por dia)</h4>
          <p className="muted perf-card-desc">
            Running = queries em execução · Queued = fila por sobrecarga
          </p>
          {chartRows.length ? (
            <div className="chart-wrap cost-chart perf-load-chart">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartRows}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#2A2F36" vertical={false} />
                  <XAxis dataKey="date" stroke="#8B939E" tick={{ fontSize: 11 }} />
                  <YAxis stroke="#8B939E" tick={{ fontSize: 11 }} />
                  <Tooltip
                    contentStyle={{
                      background: "#1A1D21",
                      border: "1px solid #2A2F36",
                    }}
                  />
                  <Legend />
                  <Bar dataKey="running" name="Running" fill="#29B5E8" stackId="a" />
                  <Bar dataKey="queued" name="Queued" fill="#f5a524" stackId="a" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="info-box">Sem séries de carga no período.</div>
          )}
        </div>

        <div className="perf-card">
          <h4>Diagnóstico por warehouse</h4>
          <FetchedAtLabel fetchedAt={data.fetched_at} cached={data.cached} />
          {data.warehouses?.length ? (
            <div
              className={
                data.warehouses.length > 5
                  ? "table cost-table perf-table perf-wh-table perf-wh-scroll"
                  : "table cost-table perf-table perf-wh-table"
              }
            >
              <div className="table-head">
                <span>WAREHOUSE</span>
                <span>FILA</span>
                <span>STATUS</span>
              </div>
              {data.warehouses.map((w) => (
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
            <div className="info-box">Nenhum warehouse com carga no período.</div>
          )}
        </div>
      </div>

      <h3 className="perf-section-title">Queries</h3>
      <div className="perf-card">
        <div className="perf-queries-header">
          <div className="perf-queries-heading">
            <h4>Top queries do período</h4>
            <p className="muted perf-card-desc">
              Fonte: ACCOUNT_USAGE.QUERY_HISTORY · agrupamento por query_hash quando repetida
            </p>
            <FetchedAtLabel fetchedAt={data.fetched_at} cached={data.cached} />
          </div>
          <div className="perf-queries-header-right">
            {data.duration_buckets && data.duration_buckets.some((b) => b.query_count > 0) ? (
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
          <div className="perf-queries-scroll" role="region" aria-label="Top queries do período">
            <div className="table cost-table perf-table perf-queries">
              <div className="table-head">
                <span>QUERY</span>
                <span>WAREHOUSE</span>
                <span className="perf-num">EXEC.</span>
                <span className="perf-num">TEMPO</span>
                <span className="perf-num">DATA</span>
                <span className="perf-num">HORA</span>
                <span>SINAL</span>
              </div>
              {visibleQueries.map((q) => {
                const signal = querySignal(q.recommendation);
                const warehouse = q.warehouse_name || "—";
                const lastExec = formatLastExecParts(q.last_end_time);
                return (
                  <div key={q.pattern_key || q.sample_query_id} className="table-row">
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
                      {lastExec?.date ?? "—"}
                    </span>
                    <span className="perf-num perf-datetime" title={q.last_end_time || undefined}>
                      {lastExec?.time ?? "—"}
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
          <div className="info-box">Nenhuma query relevante no período.</div>
        )}
      </div>

      {statusDetail ? (
        <RecommendationModal detail={statusDetail} onClose={() => setStatusDetail(null)} />
      ) : null}
    </div>
  );
}
