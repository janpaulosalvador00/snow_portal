import type { DateRangeValue } from "./DateRangePicker";

/** Valid Top-N values for Performance queries. */
export const PERF_TOP_VALUES = ["10", "20", "50", "all"] as const;
export type PerfTopValue = (typeof PERF_TOP_VALUES)[number];

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDay(value: string | null | undefined): value is string {
  return !!value && ISO_DAY.test(value);
}

export function parseConnectionParam(raw: string | null): number | null {
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function parseDateRangeFromParams(params: URLSearchParams): DateRangeValue {
  const start = params.get("start");
  const end = params.get("end");
  if (isIsoDay(start) && isIsoDay(end) && start <= end) {
    return { mode: "custom", start, end };
  }
  const daysRaw = params.get("days") ?? params.get("range");
  const days = daysRaw ? Number(daysRaw) : NaN;
  if (days === 7 || days === 28) {
    return { mode: "preset", days };
  }
  return { mode: "preset", days: 28 };
}

export function parseTopParam(raw: string | null): PerfTopValue {
  const v = (raw || "").trim().toLowerCase();
  if ((PERF_TOP_VALUES as readonly string[]).includes(v)) return v as PerfTopValue;
  return "10";
}

export function parseDayParam(raw: string | null): string | null {
  return isIsoDay(raw) ? raw : null;
}

export type CostUrlState = {
  tabSlug: string;
  connectionId: number | "";
  dateRange: DateRangeValue;
  top: PerfTopValue;
  day: string | null;
  usageType: string;
  serviceType: string;
  resourceFilter: string;
  grain: string;
};

/** Build the canonical Cost Management query string (no leading `?`). */
export function buildCostSearch(state: CostUrlState): string {
  const p = new URLSearchParams();
  p.set("tab", state.tabSlug);

  if (state.connectionId !== "") {
    p.set("connection", String(state.connectionId));
  }

  if (state.dateRange.mode === "preset") {
    p.set("days", String(state.dateRange.days));
  } else {
    p.set("start", state.dateRange.start);
    p.set("end", state.dateRange.end);
  }

  if (state.top && state.top !== "10") {
    p.set("top", state.top);
  }

  if (state.day) {
    p.set("day", state.day);
  }

  if (state.usageType && state.usageType !== "Compute") {
    p.set("usage", state.usageType);
  }

  if (state.serviceType && state.serviceType !== "WAREHOUSE_METERING") {
    p.set("service", state.serviceType);
  }

  if (state.resourceFilter && state.resourceFilter !== "All") {
    p.set("resource", state.resourceFilter);
  }

  if (state.grain && state.grain !== "day") {
    p.set("grain", state.grain);
  }

  return p.toString();
}
