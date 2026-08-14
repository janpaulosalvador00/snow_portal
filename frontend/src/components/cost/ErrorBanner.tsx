import { Link } from "react-router-dom";

type Props = {
  message: string;
  connectionId?: number | "";
};

export function ErrorBanner({ message, connectionId }: Props) {
  const lower = message.toLowerCase();
  const isQuota =
    lower.includes("090073") ||
    lower.includes("resource monitor") ||
    lower.includes("monitoramento_empresa") ||
    lower.includes("credit_quota") ||
    lower.includes("cota");
  const isWhMissing =
    lower.includes("002043") ||
    lower.includes("compute_wh") ||
    (lower.includes("warehouse") && lower.includes("não existe"));

  return (
    <div className="error-box cost-error" role="alert">
      <div className="cost-error-body">{message}</div>
      {isQuota ? (
        <p className="cost-error-hint">
          Monitor de <strong>conta</strong> com cota estourada — trocar o warehouse da conexão{" "}
          <strong>não</strong> resolve. Na worksheet (ACCOUNTADMIN):{" "}
          <code>ALTER RESOURCE MONITOR MONITORAMENTO_EMPRESA SET CREDIT_QUOTA = 50;</code>
        </p>
      ) : null}
      {isWhMissing && !isQuota ? (
        <p className="cost-error-hint">
          Warehouse da conexão pode não existir nesta conta. Em Editar, escolha um WH da lista
          (ex.: WH_CON_EXT) ou deixe vazio para auto.
        </p>
      ) : null}
      <div className="cost-error-actions">
        <Link to={connectionId ? `/conexoes?edit=${connectionId}` : "/conexoes"}>
          Editar conexão (revalidar auth / warehouse / role)
        </Link>
      </div>
    </div>
  );
}
