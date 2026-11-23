/**
 * Compact kinds for Top queries badges.
 *
 * Classification prefers Snowflake ACCOUNT_USAGE.QUERY_HISTORY.QUERY_TYPE when
 * present; otherwise (or when type is too generic like DESCRIBE / LIST_FILES)
 * falls back to prefixes / tokens in the query preview text.
 *
 * Rules (first match wins):
 *
 * | Kind         | Snowflake QUERY_TYPE                         | Text heuristic                                      |
 * |--------------|----------------------------------------------|-----------------------------------------------------|
 * | STREAMLIT    | *STREAMLIT* (e.g. EXECUTE_STREAMLIT)         | `execute|describe streamlit`, `snow://streamlit`    |
 * | CODE BUNDLE  | *CODE_BUNDLE*                                | `code bundle`, `snow://workspace`                   |
 * | SERVICE      | *SERVICE* (CREATE/ALTER/DROP/DESCRIBE/…)     | `(create|alter|drop|describe|show) service`         |
 * | COMPUTE_POOL | *COMPUTE_POOL*                               | `compute pool` / `compute_pool`                     |
 * | CALL         | CALL                                         | leading `CALL`                                      |
 * | QUERY        | SELECT / DML / SYSTEM$ / other / unknown     | default                                             |
 *
 * QUERY_TAG is ignored (app-specific, not a reliable kind signal).
 */

export type QueryKind =
  | "QUERY"
  | "CALL"
  | "STREAMLIT"
  | "SERVICE"
  | "CODE BUNDLE"
  | "COMPUTE_POOL";

/** Known kinds offered in the editable TIPO select (order = UI order). */
export const QUERY_KIND_OPTIONS: readonly QueryKind[] = [
  "STREAMLIT",
  "CALL",
  "QUERY",
  "CODE BUNDLE",
  "SERVICE",
  "COMPUTE_POOL",
] as const;

/** Max length for custom ("Outro") labels. */
export const QUERY_KIND_CUSTOM_MAX = 24;

/** Default accent colors for known kinds (badge text / border tint). */
export const QUERY_KIND_DEFAULT_COLORS: Record<QueryKind, string> = {
  STREAMLIT: "#29b5e8",
  CALL: "#c4a0f0",
  QUERY: "#8b939e",
  "CODE BUNDLE": "#f5a524",
  SERVICE: "#f5a524",
  COMPUTE_POOL: "#f5a524",
};

export const QUERY_KIND_CUSTOM_DEFAULT_COLOR = "#9ec9b0";

/** Swatches offered in the TIPO edit modal. */
export const QUERY_KIND_COLOR_SWATCHES: readonly string[] = [
  "#29b5e8",
  "#c4a0f0",
  "#f5a524",
  "#8b939e",
  "#9ec9b0",
  "#e86b6b",
  "#7ad3a0",
  "#f0c14a",
  "#6cb6ff",
  "#d4a5ff",
] as const;

/** CSS modifier from a kind label (`CODE BUNDLE` → `kind-code-bundle`). */
export function queryKindCssClass(kind: string): string {
  const slug = kind
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const known = new Set(
    QUERY_KIND_OPTIONS.map((k) => k.replace(/\s+/g, "-").toLowerCase()),
  );
  if (slug && known.has(slug)) return `kind-${slug}`;
  return "kind-custom";
}

/** Default accent for a kind label (known or custom). */
export function defaultColorForQueryKind(kind: string): string {
  const k = kind.replace(/\s+/g, " ").trim().toUpperCase();
  for (const opt of QUERY_KIND_OPTIONS) {
    if (opt.toUpperCase() === k) return QUERY_KIND_DEFAULT_COLORS[opt];
  }
  return QUERY_KIND_CUSTOM_DEFAULT_COLOR;
}

/** Normalize #RRGGBB / #RGB; invalid → null. */
export function normalizeQueryKindColor(raw: string | null | undefined): string | null {
  const v = (raw || "").trim();
  if (!v) return null;
  const short = /^#([0-9a-f]{3})$/i.exec(v);
  if (short) {
    const [r, g, b] = short[1].split("");
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
  return null;
}

/** Effective accent: override color when set, else kind default. */
export function resolveQueryKindColor(kind: string, colorOverride?: string | null): string {
  return normalizeQueryKindColor(colorOverride) || defaultColorForQueryKind(kind);
}

/** Normalize a custom label; empty → null. */
export function normalizeCustomQueryKind(raw: string): string | null {
  const v = raw.replace(/\s+/g, " ").trim().toUpperCase().slice(0, QUERY_KIND_CUSTOM_MAX);
  return v || null;
}

const STREAMLIT_TYPE = /STREAMLIT/i;
const CODE_BUNDLE_TYPE = /CODE[_ ]?BUNDLE/i;
const SERVICE_TYPE = /SERVICE/i;
const COMPUTE_POOL_TYPE = /COMPUTE[_ ]?POOL/i;

const STREAMLIT_TEXT =
  /^(?:execute|describe)\s+streamlit\b|snow:\/\/streamlit\b/i;
const CODE_BUNDLE_TEXT = /\bcode\s+bundle\b|snow:\/\/workspace\b/i;
const SERVICE_TEXT = /^(?:create|alter|drop|describe|show)\s+service\b/i;
const COMPUTE_POOL_TEXT = /\bcompute(?:\s+|_)pool\b/i;
const CALL_TEXT = /^call\b/i;

function normType(queryType?: string | null): string {
  return (queryType || "").trim().toUpperCase();
}

function normPreview(queryPreview?: string | null): string {
  return (queryPreview || "").replace(/\s+/g, " ").trim();
}

/** Pure classifier: Snowflake QUERY_TYPE first, then query text heuristics. */
export function classifyQueryKind(
  queryType?: string | null,
  queryPreview?: string | null,
): QueryKind {
  const type = normType(queryType);
  const text = normPreview(queryPreview);

  if (type && STREAMLIT_TYPE.test(type)) return "STREAMLIT";
  if (type && CODE_BUNDLE_TYPE.test(type)) return "CODE BUNDLE";
  if (type && SERVICE_TYPE.test(type)) return "SERVICE";
  if (type && COMPUTE_POOL_TYPE.test(type)) return "COMPUTE_POOL";
  if (type === "CALL") return "CALL";

  if (text && STREAMLIT_TEXT.test(text)) return "STREAMLIT";
  if (text && CODE_BUNDLE_TEXT.test(text)) return "CODE BUNDLE";
  if (text && SERVICE_TEXT.test(text)) return "SERVICE";
  if (text && COMPUTE_POOL_TEXT.test(text)) return "COMPUTE_POOL";
  if (text && CALL_TEXT.test(text)) return "CALL";

  return "QUERY";
}

/** Effective display kind: override when present, else classifier. */
export function effectiveQueryKind(
  queryType: string | null | undefined,
  queryPreview: string | null | undefined,
  override?: string | null,
): string {
  const o = (override || "").trim();
  if (o) return o;
  return classifyQueryKind(queryType, queryPreview);
}
