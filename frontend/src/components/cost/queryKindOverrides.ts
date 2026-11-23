/**
 * Per-connection overrides for Top queries TIPO badges.
 * Keyed by connectionId → pattern_key (query_hash) → kind label.
 * localStorage only — no backend prefs API yet.
 */

const STORAGE_KEY = "snow_portal_perf_query_kind_overrides";

export type QueryKindOverrideMap = Record<string, string>;

type Store = Record<string, QueryKindOverrideMap>;

function readStore(): Store {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Store;
  } catch {
    return {};
  }
}

function writeStore(store: Store): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

export function loadQueryKindOverrides(connectionId: number): QueryKindOverrideMap {
  const entry = readStore()[String(connectionId)];
  if (!entry || typeof entry !== "object") return {};
  return { ...entry };
}

export function saveQueryKindOverride(
  connectionId: number,
  patternKey: string,
  kind: string | null,
): QueryKindOverrideMap {
  const key = String(connectionId);
  const store = readStore();
  const next: QueryKindOverrideMap = { ...(store[key] || {}) };
  const trimmed = (kind || "").trim();
  if (!trimmed || !patternKey) {
    delete next[patternKey];
  } else {
    next[patternKey] = trimmed;
  }
  if (Object.keys(next).length === 0) delete store[key];
  else store[key] = next;
  writeStore(store);
  return next;
}
