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
