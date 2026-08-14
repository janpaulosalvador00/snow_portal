import { useEffect, useState, type ReactNode, type WheelEvent } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { ALERTS_BADGE_EVENT, getAlerts } from "../api/alerts";
import { useAuth } from "../auth/AuthContext";

function NavIcon({ children }: { children: ReactNode }) {
  return (
    <svg
      className="nav-icon"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function AppShell() {
  const { user, logout } = useAuth();
  const [alertsCount, setAlertsCount] = useState(0);

  useEffect(() => {
    const onBadge = (event: Event) => {
      setAlertsCount(Number((event as CustomEvent<number>).detail) || 0);
    };
    window.addEventListener(ALERTS_BADGE_EVENT, onBadge);
    void getAlerts()
      .then((response) => setAlertsCount(response.critical_clients))
      .catch(() => setAlertsCount(0));
    return () => window.removeEventListener(ALERTS_BADGE_EVENT, onBadge);
  }, []);

  // Wheel over the sticky sidebar must scroll the page (otherwise it feels stuck).
  function onSidebarWheel(e: WheelEvent<HTMLElement>) {
    if (e.currentTarget.scrollHeight > e.currentTarget.clientHeight) return;
    window.scrollBy({ top: e.deltaY, left: 0, behavior: "auto" });
  }

  return (
    <div className="app-shell">
      <aside className="sidebar" onWheel={onSidebarWheel}>
        <div className="brand">Snow Portal</div>
        <div className="user-meta">Time: {user?.team_name || "Suporte"}</div>
        <nav>
          <NavLink to="/" end>
            <NavIcon>
              <path d="M3 10.5 12 3l9 7.5" />
              <path d="M5 10v10h14V10" />
              <path d="M10 20v-6h4v6" />
            </NavIcon>
            Início
          </NavLink>
          <NavLink to="/conexoes">
            <NavIcon>
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
            </NavIcon>
            Conexões
          </NavLink>
          <NavLink to="/cost-management">
            <NavIcon>
              <path d="M4 19V5" />
              <path d="M4 19h16" />
              <path d="M8 17V10" />
              <path d="M12 17V7" />
              <path d="M16 17v-4" />
            </NavIcon>
            Cost Management
          </NavLink>
          <NavLink to="/alerts">
            <NavIcon>
              <path d="M12 3a6 6 0 0 0-6 6c0 4-2 5-2 5h16s-2-1-2-5a6 6 0 0 0-6-6z" />
              <path d="M10.5 20a1.8 1.8 0 0 0 3 0" />
            </NavIcon>
            Alerts
            {alertsCount > 0 ? (
              <span
                className="nav-badge"
                aria-label={`${alertsCount} clientes exigem atenção`}
              >
                {alertsCount}
              </span>
            ) : null}
          </NavLink>
          {user?.role === "admin" ? (
            <NavLink to="/admin">
              <NavIcon>
                <circle cx="12" cy="8" r="3.5" />
                <path d="M5 20a7 7 0 0 1 14 0" />
                <path d="M19 4v4" />
                <path d="M17 6h4" />
              </NavIcon>
              Administração
            </NavLink>
          ) : null}
        </nav>
        <button type="button" className="btn ghost logout" onClick={() => void logout()}>
          <svg
            className="logout-icon"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
            <polyline points="16 17 21 12 16 7" />
            <line x1="21" y1="12" x2="9" y2="12" />
          </svg>
          Sair
        </button>
      </aside>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
