import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError, setActiveConnectionId, getActiveConnectionId } from "../api/client";
import { useAuth } from "../auth/AuthContext";

type Conn = {
  id: number;
  name: string;
  account_identifier: string;
  username: string;
  auth_method: string;
  team_name?: string;
};

type Team = { id: number; name: string };

const METHODS = [
  {
    key: "pat",
    label: "Programmatic Access Token (PAT)",
    desc: "Token criptografado em repouso. Recomendado para suporte no Docker.",
  },
  {
    key: "password",
    label: "Password",
    desc: "Senha do usuário Snowflake, criptografada em repouso.",
  },
  {
    key: "local_oauth",
    label: "Local OAuth",
    desc: "Abre o browser (SAML). Se falhar com 390190, use PAT.",
  },
  {
    key: "sso",
    label: "SSO",
    desc: "SSO via browser ou URL do IdP. Requer SAML2 na conta.",
  },
] as const;

const METHOD_LABELS: Record<string, string> = Object.fromEntries(
  METHODS.map((m) => [m.key, m.label]),
);

export function ConnectionsPage() {
  const { user } = useAuth();
  const [tab, setTab] = useState<"hub" | "signin">("hub");
  const [connections, setConnections] = useState<Conn[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [activeId, setActiveId] = useState<number | null>(getActiveConnectionId());
  const [method, setMethod] = useState("pat");
  const [account, setAccount] = useState("");
  const [name, setName] = useState("");
  const [sfUser, setSfUser] = useState("");
  const [secret, setSecret] = useState("");
  const [authenticatorUrl, setAuthenticatorUrl] = useState("");
  const [warehouse, setWarehouse] = useState("");
  const [roleName, setRoleName] = useState("");
  const [teamId, setTeamId] = useState<number | "">("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function reload() {
    const list = await api<Conn[]>("/api/connections");
    setConnections(list);
  }

  useEffect(() => {
    void reload().catch(() => setConnections([]));
    void api<Team[]>("/api/teams")
      .then((t) => {
        setTeams(t);
        if (t.length) setTeamId(t[0].id);
      })
      .catch(() => setTeams([]));
  }, []);

  async function activate(id: number) {
    await api(`/api/connections/${id}/activate`, { method: "POST" });
    setActiveConnectionId(id);
    setActiveId(id);
  }

  async function remove(id: number) {
    await api(`/api/connections/${id}`, { method: "DELETE" });
    if (activeId === id) {
      setActiveConnectionId(null);
      setActiveId(null);
    }
    await reload();
  }

  async function submit(testOnly: boolean) {
    setErr(null);
    setMsg(null);
    setBusy(true);
    const payload = {
      account_identifier: account,
      username: sfUser,
      auth_method: method,
      secret: method === "pat" || method === "password" ? secret : null,
      authenticator_url: method === "sso" ? authenticatorUrl || null : null,
      warehouse: warehouse || null,
      role_name: roleName || null,
      name: name || null,
      team_id: teamId === "" ? null : Number(teamId),
    };
    try {
      if (testOnly) {
        const res = await api<{ message: string }>("/api/connections/test", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        setMsg(res.message);
      } else {
        const res = await api<{ message: string; connection: Conn }>(
          "/api/connections",
          { method: "POST", body: JSON.stringify(payload) },
        );
        setMsg(res.message);
        setActiveConnectionId(res.connection.id);
        setActiveId(res.connection.id);
        setTab("hub");
        await reload();
      }
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Falha na conexão.");
    } finally {
      setBusy(false);
    }
  }

  const methodMeta = METHODS.find((m) => m.key === method)!;

  return (
    <div>
      <h1>Conexões Snowflake</h1>
      <p className="muted">Salve contas de clientes e alterne o ambiente ativo.</p>

      <div className="tabs">
        <button
          type="button"
          className={tab === "hub" ? "active" : ""}
          onClick={() => setTab("hub")}
        >
          Contas salvas
        </button>
        <button
          type="button"
          className={tab === "signin" ? "active" : ""}
          onClick={() => setTab("signin")}
        >
          Sign in to Snowflake
        </button>
      </div>

      {tab === "hub" ? (
        <div className="stack">
          {!connections.length ? (
            <div className="info-box">Nenhuma conexão ainda. Use Sign in to Snowflake.</div>
          ) : (
            connections.map((c) => (
              <div key={c.id} className="row-card">
                <div>
                  <strong>
                    {c.name}
                    {activeId === c.id ? " · ativa" : ""}
                  </strong>
                  <div className="muted">
                    {c.account_identifier} · {c.username} ·{" "}
                    {METHOD_LABELS[c.auth_method] || c.auth_method}
                  </div>
                </div>
                <div className="row-actions">
                  <button
                    type="button"
                    className="btn"
                    disabled={activeId === c.id}
                    onClick={() => void activate(c.id)}
                  >
                    Ativar
                  </button>
                  {user?.role === "admin" ? (
                    <button type="button" className="btn ghost" onClick={() => void remove(c.id)}>
                      Remover
                    </button>
                  ) : null}
                </div>
              </div>
            ))
          )}
        </div>
      ) : (
        <form
          className="form-stack"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void submit(false);
          }}
        >
          <div className="guide-box">
            <strong>Como obter account identifier e login name</strong>
            <ol>
              <li>
                Acesse{" "}
                <a href="https://app.snowflake.com" target="_blank" rel="noreferrer">
                  app.snowflake.com
                </a>{" "}
                e entre.
              </li>
              <li>Clique no avatar (canto inferior esquerdo).</li>
              <li>Selecione Account → View account details.</li>
              <li>Copie account identifier e login name.</li>
            </ol>
          </div>

          <label>
            Method
            <select value={method} onChange={(e) => setMethod(e.target.value)}>
              {METHODS.map((m) => (
                <option key={m.key} value={m.key}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <div className="info-box">{methodMeta.desc}</div>
          {(method === "local_oauth" || method === "sso") && (
            <div className="warn-box">
              Local OAuth / SSO exigem SAML2. Se aparecer 390190, use PAT ou Password.
            </div>
          )}

          <label>
            Account Identifier *
            <input
              value={account}
              onChange={(e) => setAccount(e.target.value)}
              placeholder="myorg-myaccount"
              required
            />
          </label>
          <label>
            Connection Name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="auto-generated from account"
            />
          </label>
          <label>
            Username *
            <input
              value={sfUser}
              onChange={(e) => setSfUser(e.target.value)}
              placeholder="your-username"
              required
            />
          </label>

          {method === "pat" || method === "password" ? (
            <label>
              {method === "pat" ? "Programmatic Access Token *" : "Password *"}
              <input
                type="password"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                required
              />
            </label>
          ) : null}

          {method === "sso" ? (
            <label>
              URL do IdP (SSO)
              <input
                value={authenticatorUrl}
                onChange={(e) => setAuthenticatorUrl(e.target.value)}
                placeholder="https://org.okta.com/..."
              />
            </label>
          ) : null}

          <details>
            <summary>Optional Settings</summary>
            <label>
              Warehouse
              <input value={warehouse} onChange={(e) => setWarehouse(e.target.value)} />
            </label>
            <label>
              Role
              <input value={roleName} onChange={(e) => setRoleName(e.target.value)} />
            </label>
          </details>

          <label>
            Time (ACL)
            <select
              value={teamId}
              onChange={(e) => setTeamId(e.target.value ? Number(e.target.value) : "")}
            >
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>

          {err ? <div className="error-box">{err}</div> : null}
          {msg ? <div className="success-box">{msg}</div> : null}

          <div className="row-actions">
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => void submit(true)}
            >
              Testar conexão
            </button>
            <button type="submit" className="btn primary" disabled={busy}>
              Sign In / Salvar
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
