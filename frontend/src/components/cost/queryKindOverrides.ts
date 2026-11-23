/**
 * Per-connection overrides for Top queries TIPO badges.
 * Keyed by connectionId → pattern_key (query_hash) → { kind, color? }.
 * localStorage only — no backend prefs API yet.
 *
 * Legacy values were plain kind strings; load migrates them in memory.
 */

import { normalizeQueryKindColor } from "./queryKind";

const STORAGE_KEY = "snow_portal_perf_query_kind_overrides";

export type QueryKindOverride = {
  kind: string;
  /** Accent #RRGGBB; omit → use default for kind. */
  color?: string;
};

export type QueryKindOverrideMap = Record<string, QueryKindOverride>;

type Store = Record<string, QueryKindOverrideMap>;

function normalizeEntry(raw: unknown): QueryKindOverride | null {
  if (typeof raw === "string") {
    const kind = raw.trim();
    return kind ? { kind } : null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as { kind?: unknown; color?: unknown };
  const kind = typeof obj.kind === "string" ? obj.kind.trim() : "";
  if (!kind) return null;
  const color = normalizeQueryKindColor(typeof obj.color === "string" ? obj.color : null);
  return color ? { kind, color } : { kind };
}

function readStore(): Store {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Store = {};
    for (const [connId, map] of Object.entries(parsed as Record<string, unknown>)) {
      if (!map || typeof map !== "object" || Array.isArray(map)) continue;
      const next: QueryKindOverrideMap = {};
      for (const [patternKey, entry] of Object.entries(map as Record<string, unknown>)) {
        const normalized = normalizeEntry(entry);
        if (normalized) next[patternKey] = normalized;
      }
      if (Object.keys(next).length > 0) out[connId] = next;
    }
    return out;
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
  override: QueryKindOverride | null,
): QueryKindOverrideMap {
  const key = String(connectionId);
  const store = readStore();
  const next: QueryKindOverrideMap = { ...(store[key] || {}) };
  const kind = (override?.kind || "").trim();
  if (!kind || !patternKey) {
    delete next[patternKey];
  } else {
    const color = normalizeQueryKindColor(override?.color);
    next[patternKey] = color ? { kind, color } : { kind };
  }
  if (Object.keys(next).length === 0) delete store[key];
  else store[key] = next;
  writeStore(store);
  return next;
}
