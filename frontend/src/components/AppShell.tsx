import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type WheelEvent,
} from "react";
import { createPortal } from "react-dom";
import { NavLink, Outlet, useLocation } from "react-router-dom";
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
  const location = useLocation();
  const [alertsCount, setAlertsCount] = useState(0);
  const [adminMenuOpen, setAdminMenuOpen] = useState(false);
  const [adminMenuPosition, setAdminMenuPosition] = useState({ top: 0, left: 0 });
  const adminTriggerRef = useRef<HTMLButtonElement>(null);
  const closeTimerRef = useRef<number | null>(null);
  const adminActive = location.pathname === "/admin" || location.pathname === "/canais";

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

  useEffect(() => {
    setAdminMenuOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!adminMenuOpen) return;
    function placeAdminMenu() {
      const rect = adminTriggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      setAdminMenuPosition({
        top: Math.round(rect.top),
        left: Math.round(rect.right + 8),
      });
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setAdminMenuOpen(false);
        adminTriggerRef.current?.focus();
      }
    }
    placeAdminMenu();
    window.addEventListener("resize", placeAdminMenu);
    window.addEventListener("scroll", placeAdminMenu, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("resize", placeAdminMenu);
      window.removeEventListener("scroll", placeAdminMenu, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [adminMenuOpen]);

  function openAdminMenu() {
    if (closeTimerRef.current != null) window.clearTimeout(closeTimerRef.current);
    const rect = adminTriggerRef.current?.getBoundingClientRect();
    if (rect) {
      setAdminMenuPosition({
        top: Math.round(rect.top),
        left: Math.round(rect.right + 8),
      });
    }
    setAdminMenuOpen(true);
  }

  function scheduleAdminMenuClose() {
    if (closeTimerRef.current != null) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = window.setTimeout(() => setAdminMenuOpen(false), 140);
  }

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
            <div
              className={`sidebar-nav-group${adminActive ? " has-active" : ""}`}
              onMouseEnter={openAdminMenu}
              onMouseLeave={scheduleAdminMenuClose}
            >
              <button
                ref={adminTriggerRef}
                type="button"
                className="sidebar-nav-group-trigger"
                aria-expanded={adminMenuOpen}
                aria-haspopup="menu"
                aria-controls="admin-nav-flyout"
                onFocus={openAdminMenu}
                onClick={openAdminMenu}
              >
                <NavIcon>
                  <circle cx="12" cy="8" r="3.5" />
                  <path d="M5 20a7 7 0 0 1 14 0" />
                  <path d="M19 4v4" />
                  <path d="M17 6h4" />
                </NavIcon>
                Administração
              </button>
            </div>
          ) : null}
        </nav>
        {user?.role === "admin" && adminMenuOpen
          ? createPortal(
              <div
                id="admin-nav-flyout"
                className="sidebar-nav-flyout"
                role="menu"
                aria-label="Administração"
                style={{ top: adminMenuPosition.top, left: adminMenuPosition.left }}
                onMouseEnter={openAdminMenu}
                onMouseLeave={scheduleAdminMenuClose}
              >
                <NavLink to="/admin" role="menuitem">
                  <NavIcon>
                    <circle cx="12" cy="8" r="3.5" />
                    <path d="M5 20a7 7 0 0 1 14 0" />
                  </NavIcon>
                  Administração
                </NavLink>
                <NavLink to="/canais" role="menuitem">
                  <NavIcon>
                    <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z" />
                  </NavIcon>
                  Canais
                </NavLink>
              </div>,
              document.body,
            )
          : null}
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
