import { useMemo, useState } from "react";

export type Monitor = {
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

type SortKey =
  | "name"
  | "quota_used_pct"
  | "level"
  | "warehouses"
  | "frequency"
  | "start_time";

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

function warehousesLabel(ws: string[] | undefined) {
  if (!ws?.length) return "—";
  return ws.join(", ");
}

function compareMonitors(a: Monitor, b: Monitor, key: SortKey, dir: 1 | -1): number {
  const mul = dir;
  switch (key) {
    case "name":
      return mul * a.name.localeCompare(b.name);
    case "quota_used_pct": {
      const av = a.quota_used_pct ?? -1;
      const bv = b.quota_used_pct ?? -1;
      return mul * (av - bv);
    }
    case "level":
      return mul * (a.level || "").localeCompare(b.level || "");
    case "warehouses":
      return mul * warehousesLabel(a.warehouses).localeCompare(warehousesLabel(b.warehouses));
    case "frequency":
      return mul * (a.frequency || "").localeCompare(b.frequency || "");
    case "start_time": {
      const at = a.start_time ? new Date(a.start_time).getTime() : 0;
      const bt = b.start_time ? new Date(b.start_time).getTime() : 0;
      const aOk = Number.isFinite(at) ? at : 0;
      const bOk = Number.isFinite(bt) ? bt : 0;
      return mul * (aOk - bOk);
    }
    default:
      return 0;
  }
}

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: "name", label: "NAME" },
  { key: "quota_used_pct", label: "QUOTA USED" },
  { key: "level", label: "LEVEL" },
  { key: "warehouses", label: "WAREHOUSES" },
  { key: "frequency", label: "FREQUENCY" },
  { key: "start_time", label: "START TIME" },
];

export function MonitorsTable({ items }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<1 | -1>(1);

  const sorted = useMemo(() => {
    const copy = [...items];
    copy.sort((a, b) => compareMonitors(a, b, sortKey, sortDir));
    return copy;
  }, [items, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === 1 ? -1 : 1));
    } else {
      setSortKey(key);
      setSortDir(1);
    }
  }

  return (
    <div className="table cost-table cost-table-monitors">
      <div className="table-head" role="row">
        {COLUMNS.map((col) => {
          const active = sortKey === col.key;
          return (
            <button
              key={col.key}
              type="button"
              className={`monitors-th${active ? " is-sorted" : ""}`}
              onClick={() => toggleSort(col.key)}
              aria-sort={active ? (sortDir === 1 ? "ascending" : "descending") : "none"}
            >
              <span>{col.label}</span>
              <span className="monitors-sort-ind" aria-hidden>
                {active ? (sortDir === 1 ? "▲" : "▼") : "↕"}
              </span>
            </button>
          );
        })}
      </div>
      {sorted.map((r) => {
        const pct = r.quota_used_pct ?? 0;
        const fillClass =
          pct >= 100 ? " is-over" : pct >= 75 ? " is-warn" : "";
        return (
          <div key={r.name} className="table-row" role="row">
            <span className="mono monitors-name" title={r.name}>
              {r.name}
            </span>
            <span className="quota-cell">
              <em>
                {r.quota_used_pct != null ? `${r.quota_used_pct.toFixed(2)}%` : "—"}
              </em>
              <span className="quota-track" title={`${pct.toFixed(2)}%`}>
                <span
                  className={`quota-fill${fillClass}`}
                  style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
                />
              </span>
            </span>
            <span>{r.level || "—"}</span>
            <span className="muted monitors-wh">{warehousesLabel(r.warehouses)}</span>
            <span>{r.frequency || "—"}</span>
            <span className="muted">{formatStart(r.start_time)}</span>
          </div>
        );
      })}
    </div>
  );
}
