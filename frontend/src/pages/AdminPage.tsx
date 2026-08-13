import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "../api/client";

type UserRow = {
  id: number;
  username: string;
  role: string;
  team_name?: string;
  is_active: boolean;
};

type Team = { id: number; name: string };

export function AdminPage() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("analyst");
  const [teamId, setTeamId] = useState<number | "">("");
  const [teamName, setTeamName] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function reload() {
    const [u, t] = await Promise.all([
      api<UserRow[]>("/api/users"),
      api<Team[]>("/api/teams"),
    ]);
    setUsers(u);
    setTeams(t);
    if (t.length && teamId === "") setTeamId(t[0].id);
  }

  useEffect(() => {
    void reload().catch((e) => setErr(e instanceof ApiError ? e.message : "Erro"));
  }, []);

  async function createUser(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    setMsg(null);
    try {
      await api("/api/users", {
        method: "POST",
        body: JSON.stringify({
          username,
          password,
          role,
          team_id: teamId === "" ? null : Number(teamId),
        }),
      });
      setMsg(`Usuário ${username} criado.`);
      setUsername("");
      setPassword("");
      await reload();
    } catch (ex) {
      setErr(ex instanceof ApiError ? ex.message : "Falha ao criar usuário.");
    }
  }

  async function createTeam(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    setMsg(null);
    try {
      await api("/api/teams", {
        method: "POST",
        body: JSON.stringify({ name: teamName }),
      });
      setMsg("Time criado.");
      setTeamName("");
      await reload();
    } catch (ex) {
      setErr(ex instanceof ApiError ? ex.message : "Falha ao criar time.");
    }
  }

  return (
    <div>
      <h1>Administração</h1>
      <p className="muted">Gerencie usuários do portal (capacidade ≥ 20 operadores).</p>
      {err ? <div className="error-box">{err}</div> : null}
      {msg ? <div className="success-box">{msg}</div> : null}

      <h2>Usuários</h2>
      <div className="table">
        <div className="table-head">
          <span>Username</span>
          <span>Role</span>
          <span>Time</span>
          <span>Ativo</span>
        </div>
        {users.map((u) => (
          <div key={u.id} className="table-row">
            <span>{u.username}</span>
            <span>{u.role}</span>
            <span>{u.team_name || "—"}</span>
            <span>{u.is_active ? "sim" : "não"}</span>
          </div>
        ))}
      </div>

      <form className="form-stack" onSubmit={createUser}>
        <h3>Novo usuário</h3>
        <label>
          Username
          <input value={username} onChange={(e) => setUsername(e.target.value)} required />
        </label>
        <label>
          Senha temporária
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        <label>
          Papel
          <select value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="analyst">analyst</option>
            <option value="admin">admin</option>
          </select>
        </label>
        <label>
          Time
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
        <button type="submit" className="btn primary">
          Criar usuário
        </button>
      </form>

      <form className="form-stack" onSubmit={createTeam}>
        <h3>Novo time</h3>
        <ul>
          {teams.map((t) => (
            <li key={t.id}>
              {t.name} (id={t.id})
            </li>
          ))}
        </ul>
        <label>
          Nome do time
          <input value={teamName} onChange={(e) => setTeamName(e.target.value)} required />
        </label>
        <button type="submit" className="btn primary">
          Criar time
        </button>
      </form>
    </div>
  );
}
