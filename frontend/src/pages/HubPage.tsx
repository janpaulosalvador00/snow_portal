import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, getActiveConnectionId } from "../api/client";
import { useAuth } from "../auth/AuthContext";

type Conn = {
  id: number;
  name: string;
  account_identifier: string;
};

export function HubPage() {
  const { user } = useAuth();
  const [connections, setConnections] = useState<Conn[]>([]);
  const [activeId, setActiveId] = useState<number | null>(getActiveConnectionId());

  useEffect(() => {
    void api<Conn[]>("/api/connections")
      .then(setConnections)
      .catch(() => setConnections([]));
    setActiveId(getActiveConnectionId());
  }, []);

  const active = connections.find((c) => c.id === activeId);

  return (
    <div>
      <h1>Snow Portal</h1>
      <p className="muted">Controle de créditos Snowflake para o time de suporte.</p>

      <div className="metrics">
        <div className="metric">
          <span className="muted">Conexões</span>
          <strong>{connections.length}</strong>
        </div>
        <div className="metric">
          <span className="muted">Papel</span>
          <strong>{user?.role}</strong>
        </div>
        <div className="metric">
          <span className="muted">Conta ativa</span>
          <strong>{active ? active.name : "Nenhuma"}</strong>
        </div>
      </div>

      <h2>Próximos passos</h2>
      <ol>
        <li>
          Abra <Link to="/conexoes">Conexões</Link> e use{" "}
          <strong>Browser OAuth (como Cortex)</strong> ou PAT.
        </li>
        <li>
          <strong>Ative</strong> a conta (ou <strong>Inative</strong> quando não for usar).{" "}
          <strong>Edite</strong> warehouse/role se Consumption falhar por cota de WH.
        </li>
        <li>
          Vá em <Link to="/cost-management">Cost Management</Link> (Consumption e demais abas).
        </li>
      </ol>

      {active ? (
        <div className="success-box">
          Conta ativa: <strong>{active.name}</strong> ({active.account_identifier})
        </div>
      ) : connections.length ? (
        <div className="info-box">
          Nenhuma conta ativa. Selecione <strong>Ativar</strong> em Conexões.
        </div>
      ) : (
        <div className="warn-box">Nenhuma conexão cadastrada ainda.</div>
      )}
    </div>
  );
}
