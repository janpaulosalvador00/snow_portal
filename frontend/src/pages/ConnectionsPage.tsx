import { useEffect, useState } from "react";
import {
  api,
  ApiError,
  setActiveConnectionId,
  getActiveConnectionId,
} from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { ConnectionCreateModal } from "../components/ConnectionCreateModal";
import {
  ConnectionEditModal,
  type Conn,
} from "../components/ConnectionEditModal";
import { isConnectionInUse } from "../connections/lifecycle";
import {
  connIntervalBadge,
  connIntervalBadgeClass,
  connIntervalTitle,
} from "../connections/refreshIntervals";
import { GlobalRefreshBar } from "../refresh/GlobalRefreshBar";
import { useRefresh } from "../refresh/RefreshContext";

type Team = { id: number; name: string };

const METHOD_LABELS: Record<string, string> = {
  browser_oauth: "Browser OAuth (como Cortex)",
  pat: "Programmatic Access Token (PAT)",
  password: "Password",
  keypair: "Key pair (RSA)",
  oauth: "Browser OAuth (como Cortex)",
  local_oauth: "Browser OAuth (como Cortex)",
  sso: "External Browser (SSO)",
};

export function ConnectionsPage() {
  const { user } = useAuth();
  const [connections, setConnections] = useState<Conn[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [currentEnvId, setCurrentEnvId] = useState<number | null>(
    getActiveConnectionId(),
  );
  const [editingConn, setEditingConn] = useState<Conn | null>(null);
  const [creating, setCreating] = useState(false);
  const [createInitialError, setCreateInitialError] = useState<string | null>(null);
  const [teamId, setTeamId] = useState<number | "">("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const { refreshToken, globalInterval, reloadSchedules } = useRefresh();
  const globalSeconds = Number(globalInterval);

  async function reload() {
    const list = await api<Conn[]>("/api/connections");
    setConnections(list);
    reloadSchedules?.();
  }

  useEffect(() => {
    if (refreshToken === 0) return;
    void reload().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on global refresh
  }, [refreshToken]);

  useEffect(() => {
    void reload().catch(() => setConnections([]));
    void api<Team[]>("/api/teams")
      .then((t) => setTeams(t))
      .catch(() => setTeams([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount once
  }, []);

  // Deep-link: /conexoes?edit=<id>
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const editRaw = params.get("edit");
    if (!editRaw || !connections.length) return;
    const editId = Number(editRaw);
    if (!editId) return;
    const target = connections.find((c) => c.id === editId);
    if (!target) return;
    setCreating(false);
    setEditingConn(target);
    window.history.replaceState({}, "", "/conexoes");
  }, [connections]);

  // OAuth callback: reopen edit (ok) or create modal (error)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const oauth = params.get("oauth");
    if (!oauth) return;
    if (oauth === "ok") {
      const id = Number(params.get("connection_id") || "");
      setCreating(false);
      setMsg(
        id
          ? "Login Snowflake via browser concluído. Conexão atualizada e autenticada."
          : "Login Snowflake via browser concluído. Conexão salva e pronta para uso.",
      );
      setErr(null);
      void reload().then(() => {
        if (id) {
          setActiveConnectionId(id);
          setCurrentEnvId(id);
          void api<Conn[]>("/api/connections").then((list) => {
            const target = list.find((c) => c.id === id);
            if (target) setEditingConn(target);
          });
        }
      });
    } else if (oauth === "error") {
      const detail = params.get("detail") || "Falha no OAuth via browser.";
      let decoded = detail;
      try {
        decoded = decodeURIComponent(detail);
      } catch {
        /* keep raw */
      }
      setCreateInitialError(decoded);
      setCreating(true);
      setEditingConn(null);
    }
    window.history.replaceState({}, "", "/conexoes");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- OAuth return once
  }, []);

  function selectCurrentEnv(id: number) {
    setActiveConnectionId(id);
    setCurrentEnvId(id);
    setMsg("Ambiente atual atualizado. Cost Management e Hub usam esta conta.");
    setErr(null);
  }

  function clearCurrentEnv() {
    setActiveConnectionId(null);
    setCurrentEnvId(null);
  }

  async function activateLifecycle(id: number) {
    setBusyId(id);
    setErr(null);
    try {
      const res = await api<{ message?: string }>(`/api/connections/${id}/activate`, {
        method: "POST",
      });
      setMsg(res.message || "Conexão ativada — voltamos a usá-la no portal.");
      await reload();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Falha ao ativar a conexão.");
    } finally {
      setBusyId(null);
    }
  }

  async function deactivateLifecycle(id: number) {
    setBusyId(id);
    setErr(null);
    try {
      const res = await api<{ message?: string }>(
        `/api/connections/${id}/deactivate`,
        { method: "POST" },
      );
      if (currentEnvId === id) clearCurrentEnv();
      setMsg(
        res.message ||
          "Conexão inativada — não usamos mais esta conta (ainda editável).",
      );
      await reload();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Falha ao inativar a conexão.");
    } finally {
      setBusyId(null);
    }
  }

  async function remove(id: number) {
    await api(`/api/connections/${id}`, { method: "DELETE" });
    if (currentEnvId === id) clearCurrentEnv();
    if (editingConn?.id === id) setEditingConn(null);
    await reload();
  }

  function openCreate() {
    setCreateInitialError(null);
    setEditingConn(null);
    setTeamId(""); // Todos
    setCreating(true);
    setErr(null);
  }

  function startEdit(c: Conn) {
    setCreating(false);
    setEditingConn(c);
    setTeamId(c.team_id ?? "");
    setErr(null);
    setMsg(null);
  }

  function teamLabel(c: Conn): string {
    return c.team_id == null ? "Todos" : c.team_name?.trim() || "—";
  }

  const editingLive =
    editingConn && connections.find((c) => c.id === editingConn.id)
      ? connections.find((c) => c.id === editingConn.id)!
      : editingConn;

  return (
    <div>
      <h1>Conexões Snowflake</h1>
      <p className="muted">
        Contas salvas: <strong>Ativo</strong> = estamos usando;{" "}
        <strong>Inativo</strong> = não vamos mais usar. O badge{" "}
        <em>Ambiente atual</em> indica só a conta selecionada no portal (Hub / Cost).
      </p>

      {err && !editingConn && !creating ? (
        <div className="error-box" role="alert">
          {err}
        </div>
      ) : null}
      {msg ? <div className="success-box">{msg}</div> : null}

      <div className="tabs-row">
        <div className="tabs">
          <button type="button" className="active">
            Contas salvas
          </button>
          <button type="button" className="" onClick={openCreate}>
            Sign in to Snowflake
          </button>
        </div>
        <button type="button" className="btn primary" onClick={openCreate}>
          + Nova conexão
        </button>
      </div>

      <GlobalRefreshBar />

      {!connections.length ? (
        <div className="info-box">
          Nenhuma conexão ainda. Clique em <strong>+ Nova conexão</strong> e use{" "}
          <strong>Browser OAuth (como Cortex)</strong> — login no browser, sem PAT.
        </div>
      ) : (
        <div className="connections-grid">
          {connections.map((c) => {
            const lifecycleOn = isConnectionInUse(c);
            const isCurrentEnv = currentEnvId === c.id;
            const busy = busyId === c.id;
            return (
              <article
                key={c.id}
                className={`row-card connection-card${lifecycleOn ? "" : " is-inactive"}`}
              >
                <div className="card-title-row">
                  <h3>{c.name}</h3>
                  <span
                    className={lifecycleOn ? "badge status-on" : "badge status-off"}
                    title={
                      lifecycleOn
                        ? "Em uso / disponível no portal"
                        : "Arquivada — não vamos mais usar"
                    }
                  >
                    {lifecycleOn ? "Ativo" : "Inativo"}
                  </span>
                  {isCurrentEnv ? (
                    <span
                      className="badge current-env"
                      title="Conta selecionada para Hub e Cost Management"
                    >
                      Ambiente atual
                    </span>
                  ) : null}
                  <span
                    className={connIntervalBadgeClass(c.refresh_interval)}
                    title={connIntervalTitle(c.refresh_interval)}
                  >
                    {connIntervalBadge(c.refresh_interval)}
                  </span>
                </div>
                <p className="card-meta">
                  {c.account_identifier} · {c.username} ·{" "}
                  {METHOD_LABELS[c.auth_method] || c.auth_method}
                  <br />
                  WH: {c.warehouse?.trim() || "(padrão da sessão / vazio)"} ·{" "}
                  {c.role_name?.trim() || "(padrão)"} · Time: {teamLabel(c)}
                </p>
                <div className="row-actions">
                  <button type="button" className="btn" onClick={() => startEdit(c)}>
                    Editar
                  </button>
                  {lifecycleOn ? (
                    <button
                      type="button"
                      className="btn"
                      disabled={busy}
                      title="Marca como fora de uso (ainda editável)"
                      onClick={() => void deactivateLifecycle(c.id)}
                    >
                      Inativar
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn"
                      disabled={busy}
                      title="Volta a marcar como em uso no portal"
                      onClick={() => void activateLifecycle(c.id)}
                    >
                      Ativar
                    </button>
                  )}
                  {lifecycleOn && !isCurrentEnv ? (
                    <button
                      type="button"
                      className="btn"
                      title="Seleciona esta conta para Hub e Cost Management"
                      onClick={() => selectCurrentEnv(c.id)}
                    >
                      Usar
                    </button>
                  ) : null}
                  {user?.role === "admin" ? (
                    <button
                      type="button"
                      className="btn danger-outline"
                      onClick={() => void remove(c.id)}
                    >
                      Remover
                    </button>
                  ) : null}
                </div>
              </article>
            );
          })}
        </div>
      )}

      {creating ? (
        <ConnectionCreateModal
          teams={teams}
          teamId={teamId}
          onTeamIdChange={setTeamId}
          globalIntervalSeconds={globalSeconds}
          initialError={createInitialError}
          onClose={() => {
            setCreating(false);
            setCreateInitialError(null);
          }}
          onCreated={(connection, message) => {
            setCreating(false);
            setCreateInitialError(null);
            setCurrentEnvId(connection.id);
            setMsg(message);
            void reload();
          }}
          onNotify={setMsg}
        />
      ) : null}

      {editingLive ? (
        <ConnectionEditModal
          key={editingLive.id}
          connection={editingLive}
          teams={teams}
          teamId={teamId}
          onTeamIdChange={setTeamId}
          globalIntervalSeconds={globalSeconds}
          onClose={() => setEditingConn(null)}
          onSaved={(message) => {
            setEditingConn(null);
            setMsg(message);
            void reload();
          }}
          onNotify={setMsg}
          onReload={reload}
        />
      ) : null}
    </div>
  );
}
