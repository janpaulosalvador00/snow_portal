import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
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
/** Keep tooltip clear of the plot top; horizontally clamp inside chart. */
const TIP_TOP = 8;
const TIP_WIDTH_FALLBACK = 280;
/** Delay day switches so a diagonal move toward the scrollbar does not steal focus. */
const TIP_SWITCH_STICKY_MS = 180;

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

function clampTooltipX(barX: number, chartWidth: number, tipWidth: number): number {
  if (chartWidth <= 0) return Math.max(0, barX - tipWidth / 2);
  const maxX = Math.max(0, chartWidth - tipWidth);
  return Math.min(Math.max(0, barX - tipWidth / 2), maxX);
}

type TipPayloadItem = { name: string; value: number; color: string };

type TipSnapshot = {
  label: string;
  payload: TipPayloadItem[];
  coordinate?: { x?: number; y?: number };
};

type Props = {
  rows: Record<string, string | number>[];
  resources: string[];
  grain: string;
  onGrain: (g: string) => void;
};

type TipProps = {
  active?: boolean;
  label?: string;
  payload?: TipPayloadItem[];
  grain: string;
  coordinate?: { x?: number; y?: number };
  chartWidth: number;
  tipHovering: boolean;
  frozenTip: TipSnapshot | null;
  onFrozenTip: (tip: TipSnapshot | null) => void;
  onTipHover: (hovering: boolean) => void;
  onPosition: (pos: { x: number; y: number } | undefined) => void;
};

function ConsumptionTooltip({
  active,
  label,
  payload,
  grain,
  coordinate,
  chartWidth,
  tipHovering,
  frozenTip,
  onFrozenTip,
  onTipHover,
  onPosition,
}: TipProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const switchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const frozenTipRef = useRef(frozenTip);
  const tipHoveringLocalRef = useRef(tipHovering);
  frozenTipRef.current = frozenTip;
  tipHoveringLocalRef.current = tipHovering;

  // Keep a snapshot while the pointer is over the tooltip so adjacent bars
  // cannot replace the day when moving toward the scrollbar.
  useLayoutEffect(() => {
    if (tipHovering) {
      if (switchTimerRef.current) {
        clearTimeout(switchTimerRef.current);
        switchTimerRef.current = null;
      }
      return;
    }
    if (active && payload?.length && label) {
      const next: TipSnapshot = {
        label: String(label),
        payload,
        coordinate,
      };
      const prev = frozenTipRef.current;
      // Same day: refresh payload/coordinate immediately.
      if (!prev || prev.label === next.label) {
        if (switchTimerRef.current) {
          clearTimeout(switchTimerRef.current);
          switchTimerRef.current = null;
        }
        onFrozenTip(next);
        return;
      }
      // Different day: sticky delay so a pass toward the scrollbar does not switch.
      if (switchTimerRef.current) clearTimeout(switchTimerRef.current);
      switchTimerRef.current = setTimeout(() => {
        switchTimerRef.current = null;
        if (!tipHoveringLocalRef.current) onFrozenTip(next);
      }, TIP_SWITCH_STICKY_MS);
      return;
    }
    if (!active) {
      if (switchTimerRef.current) {
        clearTimeout(switchTimerRef.current);
        switchTimerRef.current = null;
      }
      onFrozenTip(null);
      onPosition(undefined);
    }
  }, [active, label, payload, coordinate, tipHovering, onFrozenTip, onPosition]);

  useLayoutEffect(() => {
    return () => {
      if (switchTimerRef.current) clearTimeout(switchTimerRef.current);
    };
  }, []);

  // Prefer frozen snapshot while hovering the tip, or during sticky day switches.
  const shownActive = tipHovering ? true : !!active || !!frozenTip;
  const shownLabel = (tipHovering || frozenTip) ? (frozenTip?.label ?? label) : label;
  const shownPayload = (tipHovering || frozenTip) ? (frozenTip?.payload ?? payload) : payload;
  const shownCoordinate = (tipHovering || frozenTip) ? (frozenTip?.coordinate ?? coordinate) : coordinate;

  useLayoutEffect(() => {
    if (!shownActive || shownCoordinate?.x == null || !Number.isFinite(shownCoordinate.x)) return;
    const tipW = rootRef.current?.offsetWidth || TIP_WIDTH_FALLBACK;
    const x = clampTooltipX(shownCoordinate.x, chartWidth, tipW);
    onPosition({ x, y: TIP_TOP });
  }, [shownActive, shownCoordinate?.x, shownLabel, shownPayload, chartWidth, onPosition]);

  if (!shownActive || !shownPayload?.length || !shownLabel) return null;
  const items = shownPayload
    .filter((p) => Number(p.value) > 0)
    .sort((a, b) => Number(b.value) - Number(a.value));
  const total = shownPayload.reduce((s, p) => s + Number(p.value || 0), 0);
  return (
    <div
      ref={rootRef}
      className="consumption-tooltip"
      onMouseEnter={() => onTipHover(true)}
      onMouseLeave={() => onTipHover(false)}
      onWheel={(e) => e.stopPropagation()}
    >
      <div className="ct-title">{formatTooltipDate(String(shownLabel))}</div>
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
  const [tipPos, setTipPos] = useState<{ x: number; y: number } | undefined>();
  const [chartWidth, setChartWidth] = useState(0);
  const [tipHovering, setTipHovering] = useState(false);
  const [frozenTip, setFrozenTip] = useState<TipSnapshot | null>(null);
  const tipHoveringRef = useRef(false);
  const wrapRef = useRef<HTMLDivElement>(null);
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

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => {
      const wrapper = el.querySelector(".recharts-wrapper") as HTMLElement | null;
      setChartWidth(wrapper?.clientWidth ?? el.clientWidth);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const handleTipPos = useCallback((pos: { x: number; y: number } | undefined) => {
    setTipPos((prev) => {
      if (!pos) return undefined;
      if (prev && prev.x === pos.x && prev.y === pos.y) return prev;
      return pos;
    });
  }, []);

  const handleFrozenTip = useCallback((tip: TipSnapshot | null) => {
    setFrozenTip(tip);
  }, []);

  const handleTipHover = useCallback((hovering: boolean) => {
    tipHoveringRef.current = hovering;
    setTipHovering(hovering);
    if (!hovering) {
      // Leaving the tooltip: if the chart is no longer hovered, drop the pin.
      // Chart mousemove will re-sync if the cursor is still over a bar.
      const wrap = wrapRef.current;
      const overChart = wrap?.matches(":hover") ?? false;
      if (!overChart) {
        setFrozenTip(null);
        setTipPos(undefined);
      }
    }
  }, []);

  return (
    <div className="chart-wrap cost-chart" ref={wrapRef}>
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
        <BarChart
          data={chartRows}
          margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
          onMouseLeave={() => {
            // Don't clear while the pointer is on the interactive tooltip.
            if (tipHoveringRef.current) return;
            setFrozenTip(null);
            setTipPos(undefined);
          }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="#2A2F36" vertical={false} />
          <XAxis dataKey="periodRaw" stroke="#8B939E" tick={{ fontSize: 12 }} tickFormatter={(v) => formatAxis(String(v), grain)} />
          <YAxis stroke="#8B939E" tick={{ fontSize: 12 }} />
          <Tooltip
            // Keep tooltip mounted while pointer is over it (chart hover ends when entering tooltip).
            active={tipHovering ? true : undefined}
            content={
              <ConsumptionTooltip
                grain={grain}
                chartWidth={chartWidth}
                tipHovering={tipHovering}
                frozenTip={frozenTip}
                onFrozenTip={handleFrozenTip}
                onTipHover={handleTipHover}
                onPosition={handleTipPos}
              />
            }
            cursor={{ fill: "rgba(255,255,255,0.04)" }}
            position={tipPos ?? { y: TIP_TOP }}
            offset={0}
            allowEscapeViewBox={{ x: false, y: true }}
            wrapperStyle={{ pointerEvents: "auto", outline: "none", zIndex: 20 }}
          />
          {resources.map((r) => (
            <Bar
              key={r}
              dataKey={r}
              stackId="a"
              fill={colorForResource(r)}
              minPointSize={2}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
