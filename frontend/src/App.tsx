import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import { AppShell } from "./components/AppShell";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { AdminPage } from "./pages/AdminPage";
import { AlertsPage } from "./pages/AlertsPage";
import { ConnectionsPage } from "./pages/ConnectionsPage";
import { CostManagementPage } from "./pages/CostManagementPage";
import { HubPage } from "./pages/HubPage";
import { LoginPage } from "./pages/LoginPage";

function AdminGate() {
  const { user } = useAuth();
  if (user?.role !== "admin") return <Navigate to="/" replace />;
  return <AdminPage />;
}

function RootRedirect() {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="login-screen">
        <p className="muted">Carregando…</p>
      </div>
    );
  }
  return <Navigate to={user ? "/" : "/login"} replace />;
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route element={<ProtectedRoute />}>
            <Route element={<AppShell />}>
              <Route path="/" element={<HubPage />} />
              <Route path="/conexoes" element={<ConnectionsPage />} />
              <Route path="/cost-management" element={<CostManagementPage />} />
              <Route path="/alerts" element={<AlertsPage />} />
              <Route path="/admin" element={<AdminGate />} />
            </Route>
          </Route>
          <Route path="*" element={<RootRedirect />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
