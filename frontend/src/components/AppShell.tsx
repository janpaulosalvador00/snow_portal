import { useRef, type WheelEvent } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";

export function AppShell() {
  const { user, logout } = useAuth();
  const mainRef = useRef<HTMLElement>(null);

  // Wheel over the sidebar must scroll the main pane (otherwise the page feels stuck).
  function onSidebarWheel(e: WheelEvent<HTMLElement>) {
    const main = mainRef.current;
    if (!main) return;
    main.scrollTop += e.deltaY;
  }

  return (
    <div className="app-shell">
      <aside className="sidebar" onWheel={onSidebarWheel}>
        <div className="brand">Snow Portal</div>
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
      <main className="main" ref={mainRef}>
        <Outlet />
      </main>
    </div>
  );
}
