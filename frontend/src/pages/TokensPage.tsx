import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, isAbortError } from "../api/client";
import {
  getTokenInventory,
  type InventoryToken,
  type InventoryTokenStatus,
  type InventoryTokenType,
  type TokenInventoryResponse,
} from "../api/tokenInventory";
import { useRefresh } from "../refresh/RefreshContext";
import "./TokensPage.css";

const TYPE_LABELS: Record<InventoryTokenType, string> = {
  oauth_access: "OAuth access",
  oauth_refresh: "OAuth refresh",
  pat: "PAT",
  password: "Senha",
  private_key: "Chave privada",
};

const STATUS_LABELS: Record<InventoryTokenStatus, string> = {
  active: "Ativo",
  expired: "Expirado",
  revoked: "Revogado",
};

const SOURCE_LABELS: Record<string, string> = {
  oauth: "OAuth",
  typed: "digitado",
  upload: "upload",
  folder: "pasta de tokens",
  saved_token: "token salvo",
};

const EXPIRING_SOON_MS = 7 * 24 * 60 * 60 * 1000;

const absoluteFormat = new Intl.DateTimeFormat("pt-BR", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
const relativeFormat = new Intl.RelativeTimeFormat("pt-BR", { numeric: "auto" });

function formatAbsolute(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : absoluteFormat.format(d);
}

function formatRelative(iso: string, now: number): string {
  const diffSec = (new Date(iso).getTime() - now) / 1000;
  const abs = Math.abs(diffSec);
  if (abs < 60) return relativeFormat.format(Math.round(diffSec), "second");
  if (abs < 3600) return relativeFormat.format(Math.round(diffSec / 60), "minute");
  if (abs < 86400) return relativeFormat.format(Math.round(diffSec / 3600), "hour");
  if (abs < 86400 * 60) return relativeFormat.format(Math.round(diffSec / 86400), "day");
  return relativeFormat.format(Math.round(diffSec / (86400 * 30)), "month");
}

function expiryTone(token: InventoryToken, now: number): "past" | "soon" | "ok" {
  if (!token.expires_at) return "ok";
  const ms = new Date(token.expires_at).getTime() - now;
  if (ms <= 0) return "past";
  return ms <= EXPIRING_SOON_MS ? "soon" : "ok";
}

function statusBadgeClass(status: InventoryTokenStatus): string {
  if (status === "active") return "is-active";
  if (status === "expired") return "is-token-expired";
  return "is-inactive";
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

  const reload = useCallback(() => setReloadKey((n) => n + 1), []);

  const tokens = useMemo(() => data?.tokens ?? [], [data]);

  const connectionOptions = useMemo(() => {
    const seen = new Map<number, string>();
    for (const t of tokens) {
      if (!seen.has(t.connection_id)) {
        seen.set(t.connection_id, t.connection_name || `Conexão #${t.connection_id}`);
      }
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
            exibido). O status é reavaliado automaticamente a cada{" "}
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
              <span role="columnheader">Conexão</span>
              <span role="columnheader">Conta</span>
              <span role="columnheader">Usuário</span>
              <span role="columnheader">Role</span>
              <span role="columnheader">Método</span>
              <span role="columnheader">Tipo</span>
              <span role="columnheader">Status</span>
              <span role="columnheader">Emitido em</span>
              <span role="columnheader">Expira em</span>
              <span role="columnheader">Última renovação</span>
              <span role="columnheader">Fingerprint</span>
              <span role="columnheader">Arquivo</span>
            </div>
            {filtered.map((t) => {
              const tone = expiryTone(t, now);
              return (
                <div key={t.id} className="admin-table-row" role="row">
                  <span className="channels-truncate" title={t.team_name || undefined}>
                    {t.connection_name || `Conexão #${t.connection_id}`}
                    {!t.connection_exists ? (
                      <span className="tokens-muted"> (removida)</span>
                    ) : null}
                  </span>
                  <span className="channels-truncate mono" title={t.account_identifier || ""}>
                    {t.account_identifier || "—"}
                  </span>
                  <span className="channels-truncate" title={t.username || ""}>
                    {t.username || "—"}
                  </span>
                  <span className="channels-truncate" title={t.role_name || ""}>
                    {t.role_name || "—"}
                  </span>
                  <span className="channels-truncate tokens-muted" title={t.auth_method || ""}>
                    {t.auth_method_label || t.auth_method || "—"}
                  </span>
                  <span>
                    <span className="admin-badge is-support">{TYPE_LABELS[t.token_type]}</span>
                  </span>
                  <span>
                    <span className={`admin-badge ${statusBadgeClass(t.status)}`}>
                      {STATUS_LABELS[t.status]}
                    </span>
                  </span>
                  <span className="tokens-muted">{formatAbsolute(t.issued_at)}</span>
                  <span className="tokens-expiry">
                    {t.expires_at ? (
                      <>
                        <span className={`tokens-expiry-rel is-${tone}`}>
                          {formatRelative(t.expires_at, now)}
                        </span>
                        <small className="tokens-muted">{formatAbsolute(t.expires_at)}</small>
                      </>
                    ) : (
                      <span className="tokens-muted tokens-note">{t.expiry_note || "—"}</span>
                    )}
                  </span>
                  <span className="tokens-muted">
                    {t.status === "revoked" && t.revoked_at
                      ? `Revogado ${formatAbsolute(t.revoked_at)}`
                      : formatAbsolute(t.last_refreshed_at)}
                  </span>
                  <span className="mono tokens-muted">{t.fingerprint_short || "—"}</span>
                  <span
                    className="channels-truncate mono tokens-muted"
                    title={[
                      t.file_name,
                      t.source ? `origem: ${SOURCE_LABELS[t.source] || t.source}` : null,
                      t.source_file,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  >
                    {t.file_name || "—"}
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
    </div>
  );
}
