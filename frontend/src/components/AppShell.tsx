import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";

export function AppShell() {
  const { user, logout } = useAuth();

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">snow_portal</div>
        <div className="user-meta">
          {user?.username} · {user?.role}
          {user?.team_name ? <div className="muted">Time: {user.team_name}</div> : null}
        </div>
        <nav>
          <NavLink to="/" end>
            Início
          </NavLink>
          <NavLink to="/conexoes">Conexões</NavLink>
          <NavLink to="/cost-management">Cost Management</NavLink>
          {user?.role === "admin" ? (
            <NavLink to="/admin">Administração</NavLink>
          ) : null}
        </nav>
        <button type="button" className="btn ghost logout" onClick={() => void logout()}>
          Sair
        </button>
      </aside>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
