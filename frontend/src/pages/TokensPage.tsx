import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, isAbortError } from "../api/client";
import {
  getTokenInventory,
  type InventoryToken,
  type InventoryTokenStatus,
  type InventoryTokenType,
  type TokenInventoryResponse,
} from "../api/tokenInventory";
import { TokenEditDrawer } from "../components/TokenEditDrawer";
import { useRefresh } from "../refresh/RefreshContext";
import {
  connectionLabel,
  expiryTone,
  formatAbsolute,
  formatRelative,
  SOURCE_LABELS,
  STATUS_LABELS,
  statusBadgeClass,
  TYPE_LABELS,
} from "./tokensFormat";
import "./TokensPage.css";

type PageNotice = { kind: "ok" | "error"; text: string } | null;

/** Banner after returning from "Reconectar via browser" (/tokens?oauth=ok|error). */
function readOAuthReturn(): PageNotice {
  const params = new URLSearchParams(window.location.search);
  const oauth = params.get("oauth");
  if (!oauth) return null;
  window.history.replaceState({}, "", window.location.pathname);
  if (oauth === "ok") {
    return { kind: "ok", text: "Login Snowflake via browser concluído. Tokens OAuth atualizados." };
  }
  const detail = params.get("detail");
  return {
    kind: "error",
    text: `Falha no login Snowflake via browser${detail ? `: ${detail}` : "."}`,
  };
}

export function TokensPage() {
  const { refreshToken } = useRefresh();
  const [data, setData] = useState<TokenInventoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [includeRevoked, setIncludeRevoked] = useState(false);
  const [connectionFilter, setConnectionFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState<"all" | InventoryTokenType>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | InventoryTokenStatus>("all");
  const [reloadKey, setReloadKey] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [editing, setEditing] = useState<InventoryToken | null>(null);
  const [notice, setNotice] = useState<PageNotice>(readOAuthReturn);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    getTokenInventory({ includeRevoked, signal: controller.signal })
      .then((response) => {
        setData(response);
        setNow(Date.now());
      })
      .catch((e) => {
        if (isAbortError(e)) return;
        setError(e instanceof ApiError ? e.message : "Falha ao carregar os tokens.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [includeRevoked, refreshToken, reloadKey]);

  // Keep an open drawer in sync with reloads (a revoked row hidden by the filter keeps its copy).
  useEffect(() => {
    if (!data) return;
    setEditing((cur) => (cur ? (data.tokens.find((t) => t.id === cur.id) ?? cur) : cur));
  }, [data]);

  const reload = useCallback(() => setReloadKey((n) => n + 1), []);
  const closeDrawer = useCallback(() => setEditing(null), []);

  const onTokenChanged = useCallback(
    (token: InventoryToken | null) => {
      if (token) setEditing(token);
      reload();
    },
    [reload],
  );

  const onTokenDeleted = useCallback(
    (message: string) => {
      setEditing(null);
      setNotice({ kind: "ok", text: message });
      reload();
    },
    [reload],
  );

  const tokens = useMemo(() => data?.tokens ?? [], [data]);

  const connectionOptions = useMemo(() => {
    const seen = new Map<number, string>();
    for (const t of tokens) {
      if (!seen.has(t.connection_id)) seen.set(t.connection_id, connectionLabel(t));
    }
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1], "pt-BR"));
  }, [tokens]);

  useEffect(() => {
    if (statusFilter === "revoked" && !includeRevoked) setStatusFilter("all");
  }, [includeRevoked, statusFilter]);

  const filtered = useMemo(
    () =>
      tokens.filter((t) => {
        if (connectionFilter !== "all" && String(t.connection_id) !== connectionFilter) {
          return false;
        }
        if (typeFilter !== "all" && t.token_type !== typeFilter) return false;
        if (statusFilter !== "all" && t.status !== statusFilter) return false;
        return true;
      }),
    [tokens, connectionFilter, typeFilter, statusFilter],
  );

  const summary = data?.summary;
  const hasFilters = connectionFilter !== "all" || typeFilter !== "all" || statusFilter !== "all";

  return (
    <div className="tokens-page">
      <div className="admin-overview">
        <div className="admin-page-header">
          <h1>Tokens</h1>
          <p className="tokens-lead">
            Credenciais salvas das conexões (somente metadados — o valor do token nunca é
            exibido). Use <strong>Editar</strong> para trocar o valor, ajustar a conexão, registrar
            a validade, renovar ou revogar. O status é reavaliado automaticamente a cada{" "}
            {Math.round((data?.sweep_interval_sec ?? 300) / 60)} min.
          </p>
        </div>
        <div className="admin-kpis" aria-label="Resumo dos tokens">
          <article className="admin-kpi is-ok">
            <div className="admin-kpi-label">Ativos</div>
            <div className="admin-kpi-value">
              <strong>{summary?.active ?? "—"}</strong>
              <small>tokens</small>
            </div>
          </article>
          <article className="admin-kpi is-alert">
            <div className="admin-kpi-label">Expiram em 7 dias</div>
            <div className="admin-kpi-value">
              <strong>{summary?.expiring_soon ?? "—"}</strong>
              <small>ativos</small>
            </div>
          </article>
          <article className="admin-kpi tokens-kpi-expired">
            <div className="admin-kpi-label">Expirados</div>
            <div className="admin-kpi-value">
              <strong>{summary?.expired ?? "—"}</strong>
              <small>precisam renovar</small>
            </div>
          </article>
          <article className="admin-kpi is-neutral">
            <div className="admin-kpi-label">Total listado</div>
            <div className="admin-kpi-value">
              <strong>{summary?.total ?? "—"}</strong>
              <small>{includeRevoked ? "inclui revogados" : "sem revogados"}</small>
            </div>
          </article>
        </div>
        <hr className="admin-kpi-divider" aria-hidden="true" />
      </div>

      <div className="admin-content">
        <section className="admin-panel" aria-labelledby="tokens-title">
          <div className="admin-panel-head">
            <h2 id="tokens-title">Inventário de tokens</h2>
            <div className="admin-panel-actions">
              <label className="sr-only" htmlFor="tokens-filter-connection">
                Filtrar conexão
              </label>
              <select
                id="tokens-filter-connection"
                className="channels-filter"
                value={connectionFilter}
                onChange={(e) => setConnectionFilter(e.target.value)}
              >
                <option value="all">Todas as conexões</option>
                {connectionOptions.map(([id, name]) => (
                  <option key={id} value={String(id)}>
                    {name}
                  </option>
                ))}
              </select>
              <label className="sr-only" htmlFor="tokens-filter-type">
                Filtrar tipo
              </label>
              <select
                id="tokens-filter-type"
                className="channels-filter"
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value as "all" | InventoryTokenType)}
              >
                <option value="all">Todos os tipos</option>
                {(Object.keys(TYPE_LABELS) as InventoryTokenType[]).map((type) => (
                  <option key={type} value={type}>
                    {TYPE_LABELS[type]}
                  </option>
                ))}
              </select>
              <label className="sr-only" htmlFor="tokens-filter-status">
                Filtrar status
              </label>
              <select
                id="tokens-filter-status"
                className="channels-filter"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as "all" | InventoryTokenStatus)}
              >
                <option value="all">Todos os status</option>
                <option value="active">Ativo</option>
                <option value="expired">Expirado</option>
                {includeRevoked ? <option value="revoked">Revogado</option> : null}
              </select>
              <label className="channels-inline-check tokens-revoked-toggle">
                <input
                  type="checkbox"
                  checked={includeRevoked}
                  onChange={(e) => setIncludeRevoked(e.target.checked)}
                />
                Mostrar revogados
              </label>
              <button type="button" className="btn" onClick={reload} disabled={loading}>
                {loading ? "Carregando…" : "Recarregar"}
              </button>
            </div>
          </div>

          {notice ? (
            <div
              className={`tokens-notice ${notice.kind === "ok" ? "is-ok" : "is-error"}`}
              role={notice.kind === "error" ? "alert" : "status"}
            >
              <span>{notice.text}</span>
              <button
                type="button"
                className="btn ghost btn-inline"
                onClick={() => setNotice(null)}
                aria-label="Dispensar aviso"
              >
                ×
              </button>
            </div>
          ) : null}

          {error ? (
            <div className="tokens-error" role="alert">
              <span>{error}</span>
              <button type="button" className="btn" onClick={reload}>
                Tentar novamente
              </button>
            </div>
          ) : null}

          <div
            className="admin-table tokens-table"
            role="table"
            aria-label="Lista de tokens"
            aria-busy={loading}
          >
            <div className="admin-table-head" role="row">
              <span role="columnheader">Conexão / conta</span>
              <span role="columnheader">Usuário / role</span>
              <span role="columnheader">Tipo / método</span>
              <span role="columnheader">Status</span>
              <span role="columnheader">Expira em</span>
              <span role="columnheader">Emitido / renovado</span>
              <span role="columnheader">Fingerprint / origem</span>
              <span role="columnheader" className="tokens-actions-cell">
                Ações
              </span>
            </div>
            {filtered.map((t) => {
              const tone = expiryTone(t, now);
              const name = connectionLabel(t);
              const selected = editing?.id === t.id;
              return (
                <div
                  key={t.id}
                  className={`admin-table-row${selected ? " is-selected" : ""}`}
                  role="row"
                >
                  <span className="tokens-cell-stack" role="cell">
                    <span className="channels-truncate" title={t.team_name ? `${name} · ${t.team_name}` : name}>
                      {name}
                      {!t.connection_exists ? <span className="tokens-muted"> (removida)</span> : null}
                    </span>
                    <small className="channels-truncate mono tokens-muted" title={t.account_identifier || ""}>
                      {t.account_identifier || "—"}
                    </small>
                  </span>
                  <span className="tokens-cell-stack" role="cell">
                    <span className="channels-truncate" title={t.username || ""}>
                      {t.username || "—"}
                    </span>
                    <small className="channels-truncate tokens-muted" title={t.role_name || ""}>
                      {t.role_name || "—"}
                    </small>
                  </span>
                  <span className="tokens-cell-stack" role="cell">
                    <span>
                      <span className="admin-badge is-support">{TYPE_LABELS[t.token_type]}</span>
                    </span>
                    <small className="channels-truncate tokens-muted" title={t.auth_method_label || t.auth_method || ""}>
                      {t.auth_method_label || t.auth_method || "—"}
                    </small>
                  </span>
                  <span role="cell">
                    <span className={`admin-badge ${statusBadgeClass(t.status)}`}>
                      {STATUS_LABELS[t.status]}
                    </span>
                  </span>
                  <span className="tokens-expiry" role="cell">
                    {t.expires_at ? (
                      <>
                        <span className={`tokens-expiry-rel is-${tone}`}>
                          {formatRelative(t.expires_at, now)}
                          {t.expires_at_source === "manual" ? (
                            <span className="tokens-manual-tag" title="Validade informada manualmente">
                              manual
                            </span>
                          ) : null}
                        </span>
                        <small className="tokens-muted">{formatAbsolute(t.expires_at)}</small>
                      </>
                    ) : (
                      <span className="tokens-muted tokens-note">{t.expiry_note || "—"}</span>
                    )}
                  </span>
                  <span className="tokens-cell-stack tokens-muted" role="cell">
                    <span>{formatAbsolute(t.issued_at)}</span>
                    <small>
                      {t.status === "revoked" && t.revoked_at
                        ? `Revogado ${formatAbsolute(t.revoked_at)}`
                        : t.last_refreshed_at
                          ? `Renovado ${formatAbsolute(t.last_refreshed_at)}`
                          : "Nunca renovado"}
                    </small>
                  </span>
                  <span className="tokens-cell-stack" role="cell">
                    <span className="mono tokens-muted">
                      {t.fingerprint_short ? `#${t.fingerprint_short}` : "—"}
                    </span>
                    <small
                      className="channels-truncate tokens-muted"
                      title={[
                        t.source ? `origem: ${SOURCE_LABELS[t.source] || t.source}` : null,
                        t.source_file,
                        t.file_name,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    >
                      {t.source_file || (t.source ? SOURCE_LABELS[t.source] || t.source : "—")}
                    </small>
                  </span>
                  <span className="tokens-actions-cell" role="cell">
                    <button
                      type="button"
                      className="btn tokens-edit-btn"
                      onClick={() => setEditing(t)}
                      aria-haspopup="dialog"
                      aria-label={`Editar ${TYPE_LABELS[t.token_type]} de ${name}`}
                    >
                      Editar
                    </button>
                  </span>
                </div>
              );
            })}
            {!loading && !error && !filtered.length ? (
              <div className="admin-table-empty">
                {tokens.length || hasFilters
                  ? "Nenhum token corresponde aos filtros."
                  : "Nenhum token salvo. Os tokens aparecem aqui quando uma conexão é criada ou autenticada."}
              </div>
            ) : null}
            {loading && !data ? <div className="admin-table-empty">Carregando tokens…</div> : null}
          </div>
        </section>
      </div>

      {editing ? (
        <TokenEditDrawer
          key={editing.id}
          token={editing}
          now={now}
          onClose={closeDrawer}
          onChanged={onTokenChanged}
          onDeleted={onTokenDeleted}
        />
      ) : null}
    </div>
  );
}
