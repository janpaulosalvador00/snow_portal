import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export type AnomalySeriesPoint = {
  date: string;
  credits: number;
  expected_low: number;
  expected_high: number;
  is_anomaly: boolean;
  anomaly_y?: number | null;
};

type Props = {
  series: AnomalySeriesPoint[];
};

export function AnomalyLineChart({ series }: Props) {
  const data = series.map((p) => ({
    ...p,
    anomaly_y: p.is_anomaly ? p.credits : null,
  }));

  return (
    <div className="chart-wrap cost-chart">
      <ResponsiveContainer width="100%" height={360}>
        <ComposedChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#2A2F36" vertical={false} />
          <XAxis dataKey="date" stroke="#8B939E" tick={{ fontSize: 11 }} minTickGap={28} />
          <YAxis stroke="#8B939E" tick={{ fontSize: 12 }} />
          <Tooltip
            contentStyle={{
              background: "#1A1D21",
              border: "1px solid #2A2F36",
              borderRadius: 8,
            }}
            formatter={(value, name) => {
              const n = typeof value === "number" ? value.toFixed(2) : String(value ?? "");
              const label =
                name === "credits"
                  ? "Consumption (credits)"
                  : name === "expected_high"
                    ? "Expected high"
                    : name === "expected_low"
                      ? "Expected low"
                      : String(name);
              return [n, label];
            }}
          />
          <Legend />
          <Area
            type="monotone"
            dataKey="expected_high"
            stroke="none"
            fill="#3a414c"
            fillOpacity={0.45}
            name="Expected Range"
            legendType="square"
          />
          <Area
            type="monotone"
            dataKey="expected_low"
            stroke="none"
            fill="#1a1d21"
            fillOpacity={1}
            legendType="none"
          />
          <Line
            type="monotone"
            dataKey="credits"
            stroke="#29B5E8"
            strokeWidth={2}
            dot={false}
            name="Consumption (credits)"
          />
          <Scatter dataKey="anomaly_y" fill="#E74C3C" name="Anomaly" />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
