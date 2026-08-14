import { useEffect, useMemo, useState, type FormEvent } from "react";
import { api, ApiError } from "../api/client";

type UserRow = {
  id: number;
  username: string;
  role: string;
  team_name?: string;
  is_active: boolean;
};

type Team = { id: number; name: string };

type RoleDef = {
  id: string;
  name: string;
  access: string;
};

const FIXED_ROLES: RoleDef[] = [
  { id: "admin", name: "admin", access: "Acesso total" },
  { id: "suporte", name: "suporte", access: "Somente visualização" },
];

type ModalKind = "user" | "team" | null;

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

export function AdminPage() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [userQuery, setUserQuery] = useState("");
  const [teamQuery, setTeamQuery] = useState("");
  const [roleQuery, setRoleQuery] = useState("");
  const [modal, setModal] = useState<ModalKind>(null);
  const [editingUserId, setEditingUserId] = useState<number | null>(null);
  const [editingTeamId, setEditingTeamId] = useState<number | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("suporte");
  const [teamId, setTeamId] = useState<number | "">("");
  const [isActive, setIsActive] = useState(true);
  const [teamName, setTeamName] = useState("");
  const [flash, setFlash] = useState<{ kind: "success" | "error"; text: string } | null>(
    null,
  );
  const [loading, setLoading] = useState(true);

  function showFlash(kind: "success" | "error", text: string) {
    setFlash({ kind, text });
  }

  useEffect(() => {
    if (!flash) return;
    const timer = window.setTimeout(() => setFlash(null), 3000);
    return () => window.clearTimeout(timer);
  }, [flash]);

  async function reload() {
    const [u, t] = await Promise.all([
      api<UserRow[]>("/api/users"),
      api<Team[]>("/api/teams"),
    ]);
    setUsers(u);
    setTeams(t);
    setTeamId((current) => {
      if (current !== "" && t.some((team) => team.id === current)) return current;
      return t.length ? t[0].id : "";
    });
  }

  useEffect(() => {
    void reload()
      .catch((e) => showFlash("error", e instanceof ApiError ? e.message : "Erro ao carregar"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    document.body.classList.toggle("modal-open", modal !== null);
    return () => document.body.classList.remove("modal-open");
  }, [modal]);

  const activeUsers = users.filter((u) => u.is_active).length;
  const adminCount = users.filter((u) => u.role === "admin").length;
  const supportCount = users.filter((u) => u.role === "suporte").length;

  const filteredUsers = useMemo(() => {
    const q = userQuery.trim().toLowerCase();
    if (!q) return users;
    return users.filter(
      (u) =>
        u.username.toLowerCase().includes(q) ||
        u.role.toLowerCase().includes(q) ||
        (u.team_name || "").toLowerCase().includes(q),
    );
  }, [users, userQuery]);

  const filteredTeams = useMemo(() => {
    const q = teamQuery.trim().toLowerCase();
    if (!q) return teams;
    return teams.filter((t) => t.name.toLowerCase().includes(q));
  }, [teams, teamQuery]);

  const filteredRoles = useMemo(() => {
    const q = roleQuery.trim().toLowerCase();
    if (!q) return FIXED_ROLES;
    return FIXED_ROLES.filter(
      (r) => r.name.includes(q) || r.access.toLowerCase().includes(q),
    );
  }, [roleQuery]);

  function openCreateUser() {
    setEditingUserId(null);
    setUsername("");
    setPassword("");
    setRole("suporte");
    setIsActive(true);
    setTeamId(teams[0]?.id ?? "");
    setModal("user");
  }

  function openEditUser(user: UserRow) {
    setEditingUserId(user.id);
    setUsername(user.username);
    setPassword("");
    setRole(user.role === "admin" ? "admin" : "suporte");
    setIsActive(user.is_active);
    const match = teams.find((t) => t.name === user.team_name);
    setTeamId(match?.id ?? "");
    setModal("user");
  }

  function openCreateTeam() {
    setEditingTeamId(null);
    setTeamName("");
    setModal("team");
  }

  function openEditTeam(team: Team) {
    setEditingTeamId(team.id);
    setTeamName(team.name);
    setModal("team");
  }

  function closeModal() {
    setModal(null);
  }

  async function saveUser(e: FormEvent) {
    e.preventDefault();
    try {
      if (editingUserId == null) {
        await api("/api/users", {
          method: "POST",
          body: JSON.stringify({
            username,
            password,
            role,
            team_id: teamId === "" ? null : Number(teamId),
          }),
        });
        showFlash("success", `Usuário ${username} salvo. Permissões do papel ${role} aplicadas.`);
      } else {
        await api(`/api/users/${editingUserId}`, {
          method: "PATCH",
          body: JSON.stringify({
            username,
            password: password || null,
            role,
            team_id: teamId === "" ? null : Number(teamId),
            clear_team: teamId === "",
            is_active: isActive,
          }),
        });
        showFlash("success", `Usuário ${username} atualizado.`);
      }
      closeModal();
      await reload();
    } catch (ex) {
      showFlash("error", ex instanceof ApiError ? ex.message : "Falha ao salvar usuário.");
    }
  }

  async function saveTeam(e: FormEvent) {
    e.preventDefault();
    try {
      if (editingTeamId == null) {
        await api("/api/teams", {
          method: "POST",
          body: JSON.stringify({ name: teamName }),
        });
        showFlash("success", `Time ${teamName} salvo.`);
      } else {
        await api(`/api/teams/${editingTeamId}`, {
          method: "PATCH",
          body: JSON.stringify({ name: teamName }),
        });
        showFlash("success", `Time ${teamName} atualizado.`);
      }
      closeModal();
      await reload();
    } catch (ex) {
      showFlash("error", ex instanceof ApiError ? ex.message : "Falha ao salvar time.");
    }
  }

  function membersForTeam(name: string) {
    return users.filter((u) => u.team_name === name).length;
  }

  function membersForRole(roleName: string) {
    return users.filter((u) => u.role === roleName).length;
  }

  return (
    <div className="admin-page">
      {flash ? (
        <div className={`admin-flash is-${flash.kind}`} role="status" aria-live="polite">
          {flash.text}
        </div>
      ) : null}

      <div className="admin-overview">
        <div className="admin-page-header">
          <h1>Administração</h1>
        </div>

        <div className="admin-kpis" aria-label="Resumo de usuários e times">
          <article className="admin-kpi is-ok">
            <div className="admin-kpi-label">Usuários ativos</div>
            <div className="admin-kpi-value">
              <strong>{activeUsers}</strong>
              <small>de {users.length}</small>
            </div>
          </article>
          <article className="admin-kpi is-attention">
            <div className="admin-kpi-label">Admins</div>
            <div className="admin-kpi-value">
              <strong>{adminCount}</strong>
              <small>papel admin</small>
            </div>
          </article>
          <article className="admin-kpi is-alert">
            <div className="admin-kpi-label">Suporte</div>
            <div className="admin-kpi-value">
              <strong>{supportCount}</strong>
              <small>papel suporte</small>
            </div>
          </article>
          <article className="admin-kpi is-neutral">
            <div className="admin-kpi-label">Times</div>
            <div className="admin-kpi-value">
              <strong>{teams.length}</strong>
              <small>cadastrados</small>
            </div>
          </article>
        </div>
        <hr className="admin-kpi-divider" aria-hidden="true" />
      </div>

      <div className="admin-content">
        {loading ? <p className="muted">Carregando…</p> : null}

        <section className="admin-panel" aria-labelledby="users-title">
          <div className="admin-panel-head">
            <h2 id="users-title">Usuários</h2>
            <div className="admin-panel-actions">
              <label className="admin-search">
                <span className="sr-only">Buscar usuário</span>
                <input
                  type="search"
                  placeholder="Buscar usuário..."
                  value={userQuery}
                  onChange={(e) => setUserQuery(e.target.value)}
                />
              </label>
              <button type="button" className="btn primary" onClick={openCreateUser}>
                + Novo usuário
              </button>
            </div>
          </div>
          <div className="admin-table users-table" role="table" aria-label="Lista de usuários">
            <div className="admin-table-head" role="row">
              <span role="columnheader">Username</span>
              <span role="columnheader">Papel</span>
              <span role="columnheader">Time</span>
              <span role="columnheader">Ativo</span>
            </div>
            {filteredUsers.map((u) => (
              <button
                key={u.id}
                type="button"
                className="admin-table-row is-editable"
                role="row"
                onClick={() => openEditUser(u)}
              >
                <span className="mono">{u.username}</span>
                <span>
                  <span className={`admin-badge ${u.role === "admin" ? "is-admin" : "is-support"}`}>
                    {u.role}
                  </span>
                </span>
                <span>{u.team_name || "—"}</span>
                <span>
                  <span className={`admin-badge ${u.is_active ? "is-active" : "is-inactive"}`}>
                    {u.is_active ? "sim" : "não"}
                  </span>
                </span>
              </button>
            ))}
            {!filteredUsers.length ? (
              <div className="admin-table-empty">Nenhum usuário encontrado.</div>
            ) : null}
          </div>
        </section>

        <div className="admin-split">
          <section className="admin-panel" aria-labelledby="teams-title">
            <div className="admin-panel-head">
              <h2 id="teams-title">Times</h2>
              <div className="admin-panel-actions">
                <label className="admin-search">
                  <span className="sr-only">Buscar time</span>
                  <input
                    type="search"
                    placeholder="Buscar time..."
                    value={teamQuery}
                    onChange={(e) => setTeamQuery(e.target.value)}
                  />
                </label>
                <button type="button" className="btn primary" onClick={openCreateTeam}>
                  + Novo time
                </button>
              </div>
            </div>
            <div className="admin-table team-table" role="table" aria-label="Lista de times">
              <div className="admin-table-head" role="row">
                <span role="columnheader">Nome</span>
                <span role="columnheader">Usuários</span>
              </div>
              {filteredTeams.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className="admin-table-row is-editable"
                  role="row"
                  onClick={() => openEditTeam(t)}
                >
                  <span>{t.name}</span>
                  <span className="mono">{membersForTeam(t.name)}</span>
                </button>
              ))}
              {!filteredTeams.length ? (
                <div className="admin-table-empty">Nenhum time encontrado.</div>
              ) : null}
            </div>
          </section>

          <section className="admin-panel" aria-labelledby="roles-title">
            <div className="admin-panel-head">
              <h2 id="roles-title">Papéis</h2>
              <div className="admin-panel-actions">
                <label className="admin-search">
                  <span className="sr-only">Buscar papel</span>
                  <input
                    type="search"
                    placeholder="Buscar papel..."
                    value={roleQuery}
                    onChange={(e) => setRoleQuery(e.target.value)}
                  />
                </label>
              </div>
            </div>
            <div className="admin-table role-table" role="table" aria-label="Lista de papéis">
              <div className="admin-table-head" role="row">
                <span role="columnheader">Nome</span>
                <span role="columnheader">Nível de acesso</span>
                <span role="columnheader">Usuários</span>
                <span role="columnheader">Status</span>
              </div>
              {filteredRoles.map((r) => (
                <div key={r.id} className="admin-table-row" role="row">
                  <span>
                    <span className={`admin-badge ${r.name === "admin" ? "is-admin" : "is-support"}`}>
                      {r.name}
                    </span>
                  </span>
                  <span>{r.access}</span>
                  <span className="mono">{membersForRole(r.name)}</span>
                  <span>
                    <span className="admin-badge is-active">Ativo</span>
                  </span>
                </div>
              ))}
              {!filteredRoles.length ? (
                <div className="admin-table-empty">Nenhum papel encontrado.</div>
              ) : null}
            </div>
          </section>
        </div>
      </div>

      {modal === "user" ? (
        <div className="admin-modal-backdrop" role="presentation" onClick={closeModal}>
          <div
            className="admin-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="user-modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="admin-modal-head">
              <div>
                <h2 id="user-modal-title">
                  {editingUserId == null ? "Novo usuário" : "Editar usuário"}
                </h2>
                <p className="admin-modal-lead">
                  Defina credenciais, papel e time. As permissões seguem o papel escolhido.
                </p>
              </div>
              <button type="button" className="btn admin-modal-close" onClick={closeModal} aria-label="Fechar">
                ×
              </button>
            </div>
            <form className="admin-form" onSubmit={saveUser}>
              <label>
                Username
                <input value={username} onChange={(e) => setUsername(e.target.value)} required />
              </label>
              <label>
                {editingUserId == null ? "Senha temporária" : "Nova senha (opcional)"}
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required={editingUserId == null}
                  autoComplete="new-password"
                />
              </label>
              <label>
                Papel
                <select value={role} onChange={(e) => setRole(e.target.value)}>
                  <option value="suporte">suporte</option>
                  <option value="admin">admin</option>
                </select>
              </label>
              <label>
                Time
                <select
                  value={teamId}
                  onChange={(e) => setTeamId(e.target.value ? Number(e.target.value) : "")}
                >
                  <option value="">—</option>
                  {teams.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
              {editingUserId != null ? (
                <label>
                  Ativo
                  <select
                    value={isActive ? "sim" : "nao"}
                    onChange={(e) => setIsActive(e.target.value === "sim")}
                  >
                    <option value="sim">sim</option>
                    <option value="nao">não</option>
                  </select>
                </label>
              ) : null}
              <div className="admin-modal-actions">
                <button type="button" className="btn" onClick={closeModal}>
                  Cancelar
                </button>
                <button type="submit" className="btn primary">
                  Salvar usuário
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {modal === "team" ? (
        <div className="admin-modal-backdrop" role="presentation" onClick={closeModal}>
          <div
            className="admin-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="team-modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="admin-modal-head">
              <div>
                <h2 id="team-modal-title">{editingTeamId == null ? "Novo time" : "Editar time"}</h2>
                <p className="admin-modal-lead">
                  Cadastre um time para associar aos usuários do portal.
                </p>
              </div>
              <button type="button" className="btn admin-modal-close" onClick={closeModal} aria-label="Fechar">
                ×
              </button>
            </div>
            <form className="admin-form" onSubmit={saveTeam}>
              <label>
                Nome do time
                <input value={teamName} onChange={(e) => setTeamName(e.target.value)} required />
              </label>
              {editingTeamId != null ? (
                <p className="muted">
                  Usuários neste time: {plural(membersForTeam(teamName), "usuário", "usuários")}{" "}
                  (somente leitura)
                </p>
              ) : null}
              <div className="admin-modal-actions">
                <button type="button" className="btn" onClick={closeModal}>
                  Cancelar
                </button>
                <button type="submit" className="btn primary">
                  Salvar time
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}
