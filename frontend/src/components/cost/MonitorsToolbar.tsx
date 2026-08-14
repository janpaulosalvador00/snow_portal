import { FilterPill } from "./FilterPill";

type Props = {
  count: number;
  search: string;
  onSearch: (v: string) => void;
  level: string;
  onLevel: (v: string) => void;
  levels: string[];
  warehouse: string;
  onWarehouse: (v: string) => void;
  warehouses: string[];
  frequency: string;
  onFrequency: (v: string) => void;
  frequencies: string[];
  onRefresh: () => void;
  loading?: boolean;
};

export function MonitorsToolbar({
  count,
  search,
  onSearch,
  level,
  onLevel,
  levels,
  warehouse,
  onWarehouse,
  warehouses,
  frequency,
  onFrequency,
  frequencies,
  onRefresh,
  loading,
}: Props) {
  return (
    <div className="monitors-toolbar">
      <h2 className="monitors-count">
        {count} Resource Monitor{count === 1 ? "" : "s"}
      </h2>
      <div className="monitors-toolbar-right">
        <label className="monitors-search">
          <span className="monitors-search-icon" aria-hidden>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
              <path
                d="M20 20l-3.5-3.5"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </span>
          <input
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Search"
            aria-label="Search monitors"
          />
        </label>
        <FilterPill
          label="Level"
          value={level}
          onChange={onLevel}
          options={levels.map((l) => ({ value: l, label: l }))}
        />
        <FilterPill
          label="Warehouse"
          value={warehouse}
          onChange={onWarehouse}
          options={warehouses.map((w) => ({ value: w, label: w }))}
        />
        <FilterPill
          label="Frequency"
          value={frequency}
          onChange={onFrequency}
          options={frequencies.map((f) => ({ value: f, label: f }))}
        />
        <button
          type="button"
          className="btn icon-refresh"
          onClick={onRefresh}
          disabled={loading}
          title="Atualizar"
          aria-label="Atualizar"
        >
          ↻
        </button>
      </div>
    </div>
  );
}
