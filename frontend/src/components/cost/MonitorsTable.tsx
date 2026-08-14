type Monitor = {
  name: string;
  credit_quota: number | null;
  used_credits: number | null;
  remaining_credits: number | null;
  quota_used_pct: number | null;
  level: string;
  frequency: string;
  warehouses: string[];
  start_time: string | null;
};

type Props = {
  items: Monitor[];
};

function formatStart(iso: string | null) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

export function MonitorsTable({ items }: Props) {
  return (
    <div className="table cost-table cost-table-monitors">
      <div className="table-head">
        <span>NAME</span>
        <span>QUOTA USED</span>
        <span>LEVEL</span>
        <span>WAREHOUSES</span>
        <span>FREQUENCY</span>
        <span>START TIME</span>
      </div>
      {items.map((r) => {
        const pct = r.quota_used_pct ?? 0;
        return (
          <div key={r.name} className="table-row">
            <span className="mono">{r.name}</span>
            <span className="quota-cell">
              <span className="quota-track">
                <span
                  className={`quota-fill${pct >= 100 ? " is-over" : pct >= 75 ? " is-warn" : ""}`}
                  style={{ width: `${Math.min(100, pct)}%` }}
                />
              </span>
              <em>{r.quota_used_pct != null ? `${r.quota_used_pct.toFixed(2)}%` : "—"}</em>
            </span>
            <span>{r.level}</span>
            <span className="muted">
              {r.warehouses?.length ? r.warehouses.join(", ") : "—"}
            </span>
            <span>{r.frequency}</span>
            <span className="muted">{formatStart(r.start_time)}</span>
          </div>
        );
      })}
    </div>
  );
}
