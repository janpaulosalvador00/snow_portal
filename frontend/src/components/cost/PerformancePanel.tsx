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
  latency_note?: string | null;
  note?: string | null;
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
    spill_label: string;
    recommendation: PerformanceRec;
  }[];
  duration_buckets?: { bucket: string; label: string; query_count: number }[];
};

function badgeClass(level: string): string {
  if (level === "ok") return "perf-badge ok";
  if (level === "warn") return "perf-badge warn";
  if (level === "bad") return "perf-badge bad";
  return "perf-badge neutral";
}

function shortDate(iso: string): string {
  // YYYY-MM-DD → MM/DD
  if (iso.length >= 10) return `${iso.slice(5, 7)}/${iso.slice(8, 10)}`;
  return iso;
}

export function PerformancePanel({
  data,
  loading,
}: {
  data: PerformanceResp;
  loading?: boolean;
}) {
  const chartRows = (data.load_series ?? []).map((r) => ({
    date: shortDate(r.date),
    running: r.avg_running,
    queued: r.avg_queued_load,
  }));

  return (
    <div className={`cost-tab-body perf-panel${loading ? " is-refreshing" : ""}`}>
      {data.latency_note ? <div className="info-box">{data.latency_note}</div> : null}
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
            <div className="chart-wrap cost-chart">
              <ResponsiveContainer width="100%" height={220}>
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
          <p className="muted perf-card-desc">
            Regras baseadas em WAREHOUSE_LOAD_HISTORY (docs Snowflake)
          </p>
          {data.warehouses?.length ? (
            <div className="table cost-table perf-table">
              <div className="table-head">
                <span>WAREHOUSE</span>
                <span>SIZE</span>
                <span>FILA</span>
                <span>RECOMENDAÇÃO</span>
              </div>
              {data.warehouses.map((w) => (
                <div key={w.warehouse_name} className="table-row">
                  <span>{w.warehouse_name}</span>
                  <span className="muted">{w.size || "—"}</span>
                  <span>{w.queue_label}</span>
                  <span>
                    <span className={badgeClass(w.recommendation?.level)}>
                      {w.recommendation?.text || "—"}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="info-box">Nenhum warehouse com carga no período.</div>
          )}
        </div>
      </div>

      <h3 className="perf-section-title">
        Queries <small>lentas, repetidas e spill remoto</small>
      </h3>
      <div className="perf-card">
        <h4>Top queries do período</h4>
        <p className="muted perf-card-desc">
          Fonte: ACCOUNT_USAGE.QUERY_HISTORY · agrupamento por query_hash quando repetida
        </p>
        {data.duration_buckets && data.duration_buckets.some((b) => b.query_count > 0) ? (
          <div className="perf-buckets" aria-label="Distribuição por duração">
            {data.duration_buckets.map((b) => (
              <div key={b.bucket} className="perf-bucket">
                <span className="muted">{b.label}</span>
                <strong>{b.query_count}</strong>
              </div>
            ))}
          </div>
        ) : null}
        {data.queries?.length ? (
          <div className="table cost-table perf-table perf-queries">
            <div className="table-head">
              <span>PADRÃO</span>
              <span>WAREHOUSE</span>
              <span>EXEC.</span>
              <span>TEMPO</span>
              <span>SPILL</span>
              <span>RECOMENDAÇÃO</span>
            </div>
            {data.queries.map((q) => (
              <div key={q.pattern_key || q.sample_query_id} className="table-row">
                <span>
                  <div className="perf-preview">{q.query_preview || "—"}</div>
                  <div className="muted mono perf-meta">
                    {(q.pattern_key || "").slice(0, 12)}
                    {q.pattern_key && q.pattern_key.length > 12 ? "…" : ""}
                    {q.user_name ? ` · ${q.user_name}` : ""}
                  </div>
                </span>
                <span>{q.warehouse_name || "—"}</span>
                <span>{q.executions}</span>
                <span>{q.total_elapsed_label}</span>
                <span>{q.spill_label}</span>
                <span>
                  <span className={badgeClass(q.recommendation?.level)}>
                    {q.recommendation?.text || "—"}
                  </span>
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="info-box">Nenhuma query relevante no período.</div>
        )}
      </div>
    </div>
  );
}
