import type { ReactNode } from "react";

const TABS = [
  "Account Overview",
  "Consumption",
  "Anomalies",
  "Performance",
  "Budgets",
  "Resource Monitors",
] as const;

export type CostTab = (typeof TABS)[number];

export { TABS };

/** Default when `?tab=` is missing or unknown. */
export const DEFAULT_COST_TAB: CostTab = "Consumption";

/** URL slug for a Cost tab (`Performance` → `performance`). */
export function tabToSlug(tab: CostTab): string {
  return tab.toLowerCase().replace(/\s+/g, "-");
}

/** Resolve `?tab=` (or path segment) back to a Cost tab. */
export function tabFromSlug(slug: string | null | undefined): CostTab | null {
  if (!slug) return null;
  const normalized = slug.trim().toLowerCase();
  return TABS.find((t) => tabToSlug(t) === normalized) ?? null;
}

type Props = {
  tab: CostTab;
  onTab: (t: CostTab) => void;
  contextLabel?: string | null;
  children?: ReactNode;
};

export function CostTabs({ tab, onTab }: Pick<Props, "tab" | "onTab">) {
  return (
    <div className="cost-tabs" role="tablist" aria-label="Cost Management">
      {TABS.map((t) => (
        <button
          key={t}
          type="button"
          role="tab"
          aria-selected={tab === t}
          className={tab === t ? "active" : ""}
          onClick={() => onTab(t)}
        >
          {t}
        </button>
      ))}
    </div>
  );
}

/** Format API `fetched_at` as pt-BR "dd/mm/aaaa, hh:mm". */
function formatUpdatedAt(iso: string | null | undefined): string | null {
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

export function CostPageHeader({
  contextLabel,
  creditsUsed,
  updatedAt,
  actions,
}: {
  contextLabel?: string | null;
  /** When set, shows e.g. "16.0 credits used" before the warehouse pill. */
  creditsUsed?: number | null;
  /** Backend `fetched_at` — last real data refresh, left of the warehouse pill. */
  updatedAt?: string | null;
  actions?: ReactNode;
}) {
  const updatedLabel = formatUpdatedAt(updatedAt);
  return (
    <div className="cost-page-header">
      <h1>Cost Management</h1>
      <div className="cost-page-header-right">
        {creditsUsed != null && Number.isFinite(creditsUsed) ? (
          <div className="cost-header-kpi" aria-live="polite">
            <strong>{creditsUsed.toFixed(1)}</strong>
            <span className="kpi-suffix"> credits used</span>
          </div>
        ) : null}
        {updatedLabel ? (
          <span
            className="cost-header-updated muted"
            title={updatedAt ?? undefined}
            aria-live="polite"
          >
            Atualizado · {updatedLabel}
          </span>
        ) : null}
        {contextLabel ? (
          <span className="cost-context-pill" title="Warehouse da conexão ativa">
            {contextLabel}
          </span>
        ) : null}
        {actions}
      </div>
    </div>
  );
}

export function CostSkeleton() {
  return (
    <div className="cost-skeleton" aria-busy="true" aria-label="Carregando">
      <div className="skel skel-kpi" />
      <div className="skel skel-chart" />
      <div className="skel skel-table" />
    </div>
  );
}
