import { useEffect, useRef, useState, type FormEvent } from "react";
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

type MethodDef = {
  key: string;
  label: string;
  desc: string;
};

/** Browser OAuth first (like Cortex); PAT/password as fallback. */
const METHODS_RECOMMENDED: MethodDef[] = [
  {
    key: "browser_oauth",
    label: "Browser OAuth (como Cortex)",
    desc:
      "Abre o login Snowflake no seu browser (OAuth local / SNOWFLAKE$LOCAL_APPLICATION). " +
      "Não precisa de PAT. Mesma ideia do Local OAuth do Cortex Desktop.",
  },
  {
    key: "pat",
    label: "Programmatic Access Token (PAT)",
    desc: "Token criptografado em repouso. Alternativa se o OAuth via browser falhar.",
  },
  {
    key: "password",
    label: "Password",
    desc: "Senha do usuário Snowflake, criptografada em repouso.",
  },
];

const ALL_METHODS = METHODS_RECOMMENDED;

const METHOD_LABELS: Record<string, string> = {
  ...Object.fromEntries(ALL_METHODS.map((m) => [m.key, m.label])),
  oauth: "Browser OAuth (como Cortex)",
  local_oauth: "Browser OAuth (como Cortex)",
  sso: "External Browser (SSO)",
};

export function ConnectionsPage() {
  const { user } = useAuth();
  const secretRef = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState<"hub" | "signin">("hub");
  const [connections, setConnections] = useState<Conn[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [activeId, setActiveId] = useState<number | null>(getActiveConnectionId());
  const [method, setMethod] = useState("browser_oauth");
  const [account, setAccount] = useState("");
  const [name, setName] = useState("");
  const [sfUser, setSfUser] = useState("");
  const [secret, setSecret] = useState("");
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

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const oauth = params.get("oauth");
    if (!oauth) return;
    if (oauth === "ok") {
      const id = Number(params.get("connection_id") || "");
      setTab("hub");
      setMsg("Login Snowflake via browser concluído. Conexão salva.");
      setErr(null);
      void reload().then(() => {
        if (id) {
          setActiveConnectionId(id);
          setActiveId(id);
        }
      });
    } else if (oauth === "error") {
      setTab("signin");
      setMethod("browser_oauth");
      setErr(params.get("detail") || "Falha no OAuth via browser.");
    }
    window.history.replaceState({}, "", "/conexoes");
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

  async function startBrowserOAuth() {
    setErr(null);
    setMsg(null);
    if (!account.trim() || !sfUser.trim()) {
      setErr("Preencha Account Identifier e Username antes do login via browser.");
      return;
    }
    setBusy(true);
    try {
      const res = await api<{ authorize_url: string }>("/api/connections/oauth/start", {
        method: "POST",
        body: JSON.stringify({
          account_identifier: account.trim(),
          username: sfUser.trim(),
          name: name || null,
          warehouse: warehouse || null,
          role_name: roleName || null,
          team_id: teamId === "" ? null : Number(teamId),
        }),
      });
      setMsg("Redirecionando para o login Snowflake no browser…");
      window.location.href = res.authorize_url;
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Falha ao iniciar OAuth.");
      setBusy(false);
    }
  }

  async function submit(testOnly: boolean) {
    setErr(null);
    setMsg(null);
    if (method === "browser_oauth") {
      await startBrowserOAuth();
      return;
    }
    setBusy(true);
    const resolvedSecret = (secret || secretRef.current?.value || "").trim();
    if (!resolvedSecret) {
      setErr(
        method === "pat"
          ? "Cole o PAT, ou use Browser OAuth (como Cortex) sem token."
          : "Informe a senha do usuário Snowflake.",
      );
      setBusy(false);
      secretRef.current?.focus();
      return;
    }
    const payload = {
      account_identifier: account,
      username: sfUser,
      auth_method: method,
      secret: resolvedSecret,
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

  const methodMeta = ALL_METHODS.find((m) => m.key === method)!;

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
            <div className="info-box">
              Nenhuma conexão ainda. Use <strong>Browser OAuth (como Cortex)</strong> — login no
              browser, sem PAT.
            </div>
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
          <div className="info-box">
            <strong>Login via browser (recomendado)</strong>
            <p style={{ marginBottom: 0 }}>
              Igual ao Local OAuth do Cortex: você autentica no Snowflake no browser; o portal
              guarda o token OAuth. Não usa PAT nem usuário de serviço.
            </p>
          </div>

          <label>
            Method
            <select value={method} onChange={(e) => setMethod(e.target.value)}>
              {METHODS_RECOMMENDED.map((m) => (
                <option key={m.key} value={m.key}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <div className="info-box">{methodMeta.desc}</div>

          <label>
            Account Identifier *
            <input
              value={account}
              onChange={(e) => setAccount(e.target.value)}
              placeholder="A8614549778771-PONCETECH_PARTNER"
              required
            />
          </label>
          <label>
            Connection Name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="PONCETECH"
            />
          </label>
          <label>
            Username *
            <input
              value={sfUser}
              onChange={(e) => setSfUser(e.target.value)}
              placeholder="JANSALVADOR"
              required
            />
          </label>

          {method === "pat" || method === "password" ? (
            <label>
              {method === "pat" ? "Programmatic Access Token *" : "Password *"}
              <input
                ref={secretRef}
                type="password"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                required
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
            {method === "browser_oauth" ? (
              <button type="submit" className="btn primary" disabled={busy}>
                Conectar via browser
              </button>
            ) : (
              <>
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
              </>
            )}
          </div>
        </form>
      )}
    </div>
  );
}
