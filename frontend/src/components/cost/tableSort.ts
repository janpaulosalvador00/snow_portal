/**
 * Small shared helpers for clickable asc/desc sortable table headers.
 * Mirrors the pattern used by `MonitorsTable` (sortKey/sortDir state +
 * toggleSort + ▲/▼/↕ indicators) so other tables (e.g. `PerformancePanel`)
 * don't have to re-implement it.
 */

export type SortDir = 1 | -1;

/** Status / signal severity order: ok < neutral < warn < bad. */
export const LEVEL_RANK: Record<string, number> = {
  ok: 0,
  neutral: 1,
  warn: 2,
  bad: 3,
};

/** Rank a recommendation/status level, defaulting unknown values to "neutral". */
export function levelRank(level?: string | null): number {
  const v = (level || "").trim().toLowerCase();
  return v in LEVEL_RANK ? LEVEL_RANK[v] : LEVEL_RANK.neutral;
}

/** Queue label severity order: baixa < média/media < alta (accents tolerated). */
const QUEUE_LABEL_RANK: Record<string, number> = {
  baixa: 0,
  media: 1,
  "média": 1,
  alta: 2,
};

/** Rank a queue label (pt-BR, with or without accent). Unknown labels sort lowest. */
export function queueLabelRank(label?: string | null): number {
  const v = (label || "").trim().toLowerCase();
  return v in QUEUE_LABEL_RANK ? QUEUE_LABEL_RANK[v] : -1;
}

/**
 * Click-to-toggle sort: clicking the active column flips asc/desc; clicking
 * a new column selects it with `defaultDir(key)` (ascending unless provided).
 */
export function toggleSort<K>(
  key: K,
  sortKey: K,
  setSortKey: (key: K) => void,
  setSortDir: (updater: (dir: SortDir) => SortDir) => void,
  defaultDir: (key: K) => SortDir = () => 1,
): void {
  if (sortKey === key) {
    setSortDir((d) => (d === 1 ? -1 : 1));
  } else {
    setSortKey(key);
    setSortDir(() => defaultDir(key));
  }
}

/** ▲ when ascending, ▼ when descending, ↕ when the column isn't the active sort. */
export function sortIndicator(active: boolean, dir: SortDir): string {
  if (!active) return "↕";
  return dir === 1 ? "▲" : "▼";
}

/** `aria-sort` value for a header button. */
export function ariaSort(active: boolean, dir: SortDir): "ascending" | "descending" | "none" {
  if (!active) return "none";
  return dir === 1 ? "ascending" : "descending";
}
