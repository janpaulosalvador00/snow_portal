import { useRefresh } from "./RefreshContext";

export function refreshTimeLabel(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.toLocaleDateString("pt-BR")} ${d.toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

/** Small ↻ that refreshes every screen/tab of the active connection. */
export function RefreshIconButton({ disabled }: { disabled?: boolean }) {
  const { refreshAll, refreshing, lastRefreshedAt } = useRefresh();
  const stamp = refreshTimeLabel(lastRefreshedAt);
  const title = refreshing
    ? "Atualizando todas as telas…"
    : stamp
      ? `Atualizar todas as telas e guias — atualizado em ${stamp}`
      : "Atualizar todas as telas e guias";

  return (
    <button
      type="button"
      className={`btn icon-refresh${refreshing ? " is-spinning" : ""}`}
      onClick={() => void refreshAll()}
      disabled={disabled || refreshing}
      title={title}
      aria-label={title}
    >
      <span aria-hidden>↻</span>
    </button>
  );
}
