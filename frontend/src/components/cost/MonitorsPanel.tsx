import { useMemo, useState } from "react";
import { MonitorsTable, type Monitor } from "./MonitorsTable";
import { MonitorsToolbar } from "./MonitorsToolbar";

type Props = {
  items: Monitor[];
  note?: string | null;
  /**
   * When provided (including `[]`), this is the authoritative Account filter list
   * (Hub: ORGANIZATION_USAGE via /api/cost/org-accounts for the active connection).
   * When omitted (Cost → Resource Monitors), options are derived from row account_name.
   */
  accountOptions?: string[];
  onRefresh: () => void;
  loading?: boolean;
};

export function MonitorsPanel({
  items,
  note,
  accountOptions,
  onRefresh,
  loading,
}: Props) {
  const [search, setSearch] = useState("");
  const [level, setLevel] = useState("All");
  const [warehouse, setWarehouse] = useState("All");
  const [account, setAccount] = useState("All");
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

  const accounts = useMemo(() => {
    // Hub: parent owns the list — do not merge portal connection names from rows.
    if (accountOptions !== undefined) {
      const names = [
        ...new Set(accountOptions.map((n) => n.trim()).filter(Boolean)),
      ].sort((a, b) => a.localeCompare(b));
      return ["All", ...names];
    }
    // Cost → Resource Monitors: derive from rows only.
    const s = new Set<string>();
    for (const m of items) {
      const n = (m.account_name || "").trim();
      if (n) s.add(n);
    }
    return ["All", ...Array.from(s).sort((a, b) => a.localeCompare(b))];
  }, [items, accountOptions]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((m) => {
      if (q && !m.name.toLowerCase().includes(q)) return false;
      if (level !== "All" && m.level !== level) return false;
      if (frequency !== "All" && m.frequency !== frequency) return false;
      if (warehouse !== "All" && !(m.warehouses || []).includes(warehouse)) {
        return false;
      }
      if (account !== "All") {
        const name = (m.account_name || "").trim();
        if (name !== account) return false;
      }
      return true;
    });
  }, [items, search, level, warehouse, account, frequency]);

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
        account={account}
        onAccount={setAccount}
        accounts={accounts}
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
