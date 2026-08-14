import { useMemo, useState } from "react";
import { MonitorsTable, type Monitor } from "./MonitorsTable";
import { MonitorsToolbar } from "./MonitorsToolbar";

type Props = {
  items: Monitor[];
  note?: string | null;
  onRefresh: () => void;
  loading?: boolean;
};

export function MonitorsPanel({ items, note, onRefresh, loading }: Props) {
  const [search, setSearch] = useState("");
  const [level, setLevel] = useState("All");
  const [warehouse, setWarehouse] = useState("All");
  const [frequency, setFrequency] = useState("All");

  const levels = useMemo(() => {
    const s = new Set(items.map((m) => m.level).filter(Boolean));
    return ["All", ...Array.from(s).sort()];
  }, [items]);

  const frequencies = useMemo(() => {
    const s = new Set(items.map((m) => m.frequency).filter(Boolean));
    return ["All", ...Array.from(s).sort()];
  }, [items]);

  const warehouses = useMemo(() => {
    const s = new Set<string>();
    for (const m of items) {
      for (const w of m.warehouses || []) s.add(w);
    }
    return ["All", ...Array.from(s).sort()];
  }, [items]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((m) => {
      if (q && !m.name.toLowerCase().includes(q)) return false;
      if (level !== "All" && m.level !== level) return false;
      if (frequency !== "All" && m.frequency !== frequency) return false;
      if (warehouse !== "All" && !(m.warehouses || []).includes(warehouse)) {
        return false;
      }
      return true;
    });
  }, [items, search, level, warehouse, frequency]);

  return (
    <div className="monitors-panel">
      {note ? <div className="info-box">{note}</div> : null}
      <MonitorsToolbar
        count={filtered.length}
        search={search}
        onSearch={setSearch}
        level={level}
        onLevel={setLevel}
        levels={levels}
        warehouse={warehouse}
        onWarehouse={setWarehouse}
        warehouses={warehouses}
        frequency={frequency}
        onFrequency={setFrequency}
        frequencies={frequencies}
        onRefresh={onRefresh}
        loading={loading}
      />
      {filtered.length ? (
        <MonitorsTable items={filtered} />
      ) : (
        <div className="info-box">
          {items.length === 0
            ? "Nenhum resource monitor encontrado nesta conta."
            : "Nenhum monitor corresponde aos filtros."}
        </div>
      )}
    </div>
  );
}
