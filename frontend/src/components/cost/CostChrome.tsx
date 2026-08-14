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
  actions,
}: {
  contextLabel?: string | null;
  actions?: ReactNode;
}) {
  return (
    <div className="cost-page-header">
      <h1>Cost Management</h1>
      <div className="cost-page-header-right">
        {contextLabel ? <span className="cost-context-pill">{contextLabel}</span> : null}
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
