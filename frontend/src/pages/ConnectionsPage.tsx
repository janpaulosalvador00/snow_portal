import { useEffect, useState } from "react";
import { api, setActiveConnectionId, getActiveConnectionId } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { ConnectionCreateModal } from "../components/ConnectionCreateModal";
import {
  ConnectionEditModal,
  type Conn,
} from "../components/ConnectionEditModal";
import { connIntervalBadge } from "../connections/refreshIntervals";
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
  const [activeId, setActiveId] = useState<number | null>(getActiveConnectionId());
  const [editingConn, setEditingConn] = useState<Conn | null>(null);
  const [creating, setCreating] = useState(false);
  const [createInitialError, setCreateInitialError] = useState<string | null>(null);
  const [teamId, setTeamId] = useState<number | "">("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

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
      .then((t) => {
        setTeams(t);
        if (t.length) setTeamId(t[0].id);
      })
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
          setActiveId(id);
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

  async function activate(id: number) {
    await api(`/api/connections/${id}/activate`, { method: "POST" });
    setActiveConnectionId(id);
    setActiveId(id);
    setMsg("Conexão ativada.");
  }

  function inactivate() {
    setActiveConnectionId(null);
    setActiveId(null);
    setMsg("Conexão inativada. Cost Management exige uma conta ativa.");
  }

  async function remove(id: number) {
    await api(`/api/connections/${id}`, { method: "DELETE" });
    if (activeId === id) {
      setActiveConnectionId(null);
      setActiveId(null);
    }
    if (editingConn?.id === id) setEditingConn(null);
    await reload();
  }

  function openCreate() {
    setCreateInitialError(null);
    setEditingConn(null);
    setCreating(true);
    setErr(null);
  }

  function startEdit(c: Conn) {
    setCreating(false);
    setEditingConn(c);
    setErr(null);
    setMsg(null);
  }

  const editingLive =
    editingConn && connections.find((c) => c.id === editingConn.id)
      ? connections.find((c) => c.id === editingConn.id)!
      : editingConn;

  return (
    <div>
      <h1>Conexões Snowflake</h1>
      <p className="muted">Salve contas de clientes e alterne o ambiente ativo.</p>

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
            const isActive = activeId === c.id;
            return (
              <article key={c.id} className="row-card connection-card">
                <div className="card-title-row">
                  <h3>{c.name}</h3>
                  <span className={isActive ? "badge status-on" : "badge status-off"}>
                    {isActive ? "ativa" : "inativo"}
                  </span>
                  <span
                    className="badge interval"
                    title={
                      c.refresh_interval == null
                        ? "Usa o intervalo Global da lista"
                        : undefined
                    }
                  >
                    {connIntervalBadge(c.refresh_interval)}
                  </span>
                </div>
                <p className="card-meta">
                  {c.account_identifier} · {c.username} ·{" "}
                  {METHOD_LABELS[c.auth_method] || c.auth_method}
                  <br />
                  WH: {c.warehouse?.trim() || "(padrão da sessão / vazio)"} ·{" "}
                  {c.role_name?.trim() || "(padrão)"}
                </p>
                <div className="row-actions">
                  <button type="button" className="btn" onClick={() => startEdit(c)}>
                    Editar
                  </button>
                  {isActive ? (
                    <button type="button" className="btn" onClick={inactivate}>
                      Inativar
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn"
                      onClick={() => void activate(c.id)}
                    >
                      Ativar
                    </button>
                  )}
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
      <p className="hint-note">
        <strong>Intervalo por conexão:</strong> badge no card mostra o valor próprio (ex.{" "}
        <em>15 min</em>) ou <em>Global</em> — neste caso a conexão segue o controle acima. Com
        Global em <em>Desligada</em>, auto-refresh dessas conexões fica pausado.
      </p>

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
            setActiveId(connection.id);
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
          teamId={teamId}
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
