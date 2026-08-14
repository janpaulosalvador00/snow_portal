import { useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

const COLORS = [
  "#29B5E8",
  "#E88B8B",
  "#C4A5E7",
  "#7AD3A0",
  "#F0C674",
  "#8AB4F8",
  "#E8A87C",
  "#85C1E9",
  "#F5B7B1",
  "#A3E4D7",
  "#D7BDE2",
  "#F9E79F",
];

const LEGEND_VISIBLE = 8;

export function colorForResource(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return COLORS[h % COLORS.length];
}

function formatAxis(period: string, grain: string): string {
  // period may be YYYY-MM-DD or YYYY-MM
  const iso = period.length === 7 ? `${period}-01` : period.slice(0, 10);
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return period;
  if (grain === "month") {
    return d.toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" });
  }
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function formatTooltipDate(period: string): string {
  const iso = period.length === 7 ? `${period}-01` : period.slice(0, 10);
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return period;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

type Props = {
  rows: Record<string, string | number>[];
  resources: string[];
  grain: string;
  onGrain: (g: string) => void;
};

type TipProps = {
  active?: boolean;
  label?: string;
  payload?: { name: string; value: number; color: string }[];
  grain: string;
};

function ConsumptionTooltip({ active, label, payload, grain }: TipProps) {
  if (!active || !payload?.length || !label) return null;
  const items = payload
    .filter((p) => Number(p.value) > 0)
    .sort((a, b) => Number(b.value) - Number(a.value));
  const total = payload.reduce((s, p) => s + Number(p.value || 0), 0);
  return (
    <div
      className="consumption-tooltip"
      onWheel={(e) => e.stopPropagation()}
    >
      <div className="ct-title">{formatTooltipDate(String(label))}</div>
      <ul className="ct-list">
        {items.map((p) => (
          <li key={p.name}>
            <span className="ct-swatch" style={{ background: p.color || colorForResource(p.name) }} />
            <span className="ct-name" title={p.name}>
              {p.name}
            </span>
            <span className="ct-val">{Number(p.value).toFixed(1)}</span>
          </li>
        ))}
      </ul>
      <div className="ct-total">
        <span>Total</span>
        <span>{total.toFixed(1)}</span>
      </div>
      <span className="sr-only">{grain}</span>
    </div>
  );
}

export function StackedConsumptionChart({ rows, resources, grain, onGrain }: Props) {
  const [legendOpen, setLegendOpen] = useState(false);
  const visible = resources.slice(0, LEGEND_VISIBLE);
  const rest = resources.slice(LEGEND_VISIBLE);

  const chartRows = useMemo(
    () =>
      rows.map((r) => ({
        ...r,
        periodLabel: formatAxis(String(r.period), grain),
        periodRaw: String(r.period),
      })),
    [rows, grain],
  );

  return (
    <div className="chart-wrap cost-chart">
      <div className="chart-toolbar">
        <div className="chart-toolbar-left muted">View by Resource</div>
        <div className="chart-toolbar-right">
          <select
            className="chart-view-by"
            value={grain}
            onChange={(e) => onGrain(e.target.value)}
            aria-label="Group by"
          >
            <option value="day">By Day</option>
            <option value="month">By Month</option>
          </select>
        </div>
      </div>

      <div className="chart-legend-row">
        {visible.map((r) => (
          <span key={r} className="chart-legend-item">
            <span className="ct-swatch" style={{ background: colorForResource(r) }} />
            <span className="chart-legend-label" title={r}>
              {r.length > 28 ? `${r.slice(0, 26)}…` : r}
            </span>
          </span>
        ))}
        {rest.length ? (
          <div className="chart-legend-more-wrap">
            <button
              type="button"
              className="chart-legend-more"
              onClick={() => setLegendOpen((o) => !o)}
            >
              + {rest.length} more
            </button>
            {legendOpen ? (
              <div className="chart-legend-popover">
                {rest.map((r) => (
                  <div key={r} className="chart-legend-item">
                    <span className="ct-swatch" style={{ background: colorForResource(r) }} />
                    <span title={r}>{r}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      <ResponsiveContainer width="100%" height={360}>
        <BarChart data={chartRows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#2A2F36" vertical={false} />
          <XAxis dataKey="periodRaw" stroke="#8B939E" tick={{ fontSize: 12 }} tickFormatter={(v) => formatAxis(String(v), grain)} />
          <YAxis stroke="#8B939E" tick={{ fontSize: 12 }} />
          <Tooltip
            content={<ConsumptionTooltip grain={grain} />}
            cursor={{ fill: "rgba(255,255,255,0.04)" }}
            position={{ y: 8 }}
            offset={12}
            allowEscapeViewBox={{ x: true, y: true }}
            wrapperStyle={{ pointerEvents: "auto", outline: "none", zIndex: 20 }}
          />
          {resources.map((r) => (
            <Bar key={r} dataKey={r} stackId="a" fill={colorForResource(r)} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
