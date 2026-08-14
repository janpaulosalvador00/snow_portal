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

const COLORS = [
  "#E88B8B",
  "#29B5E8",
  "#C4A5E7",
  "#7AD3A0",
  "#F0C674",
  "#8AB4F8",
  "#E8A87C",
  "#85C1E9",
];

type Props = {
  rows: Record<string, string | number>[];
  resources: string[];
  grain: string;
  onGrain: (g: string) => void;
};

export function StackedConsumptionChart({ rows, resources, grain, onGrain }: Props) {
  return (
    <div className="chart-wrap cost-chart">
      <div className="chart-toolbar">
        <span className="muted">View by</span>
        <select
          className="chart-view-by"
          value={grain}
          onChange={(e) => onGrain(e.target.value)}
          aria-label="View by"
        >
          <option value="day">Day</option>
          <option value="month">Month</option>
        </select>
      </div>
      <ResponsiveContainer width="100%" height={360}>
        <BarChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#2A2F36" vertical={false} />
          <XAxis dataKey="period" stroke="#8B939E" tick={{ fontSize: 12 }} />
          <YAxis stroke="#8B939E" tick={{ fontSize: 12 }} />
          <Tooltip
            contentStyle={{
              background: "#1A1D21",
              border: "1px solid #2A2F36",
              borderRadius: 8,
            }}
          />
          <Legend wrapperStyle={{ paddingTop: 12 }} />
          {resources.map((r, i) => (
            <Bar key={r} dataKey={r} stackId="a" fill={COLORS[i % COLORS.length]} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
