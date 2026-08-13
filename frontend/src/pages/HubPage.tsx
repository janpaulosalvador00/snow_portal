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
  const activeId = getActiveConnectionId();

  useEffect(() => {
    void api<Conn[]>("/api/connections").then(setConnections).catch(() => setConnections([]));
  }, []);

  const active = connections.find((c) => c.id === activeId);

  return (
    <div>
      <h1>snow_portal</h1>
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
          <strong>{active ? active.name : "Não"}</strong>
        </div>
      </div>

      <h2>Próximos passos</h2>
      <ol>
        <li>
          Abra <Link to="/conexoes">Conexões</Link> e adicione uma conta Snowflake (PAT).
        </li>
        <li>Ative a conexão desejada.</li>
        <li>
          Vá em <Link to="/cost-management">Cost Management</Link> para ver o consumo de créditos.
        </li>
      </ol>

      {active ? (
        <div className="success-box">
          Conta ativa: <strong>{active.name}</strong> ({active.account_identifier})
        </div>
      ) : connections.length ? (
        <div className="info-box">Nenhuma conta ativa. Selecione uma em Conexões.</div>
      ) : (
        <div className="warn-box">Nenhuma conexão cadastrada ainda.</div>
      )}
    </div>
  );
}
