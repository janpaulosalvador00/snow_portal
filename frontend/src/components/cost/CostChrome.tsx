import type { ReactNode } from "react";

const TABS = [
  "Organization Overview",
  "Account Overview",
  "Consumption",
  "Anomalies",
  "Budgets",
  "Resource Monitors",
] as const;

export type CostTab = (typeof TABS)[number];

export { TABS };

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

export function CostPageHeader({
  contextLabel,
  creditsUsed,
  actions,
}: {
  contextLabel?: string | null;
  /** When set, shows e.g. "16.0 credits used" before the warehouse pill. */
  creditsUsed?: number | null;
  actions?: ReactNode;
}) {
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
