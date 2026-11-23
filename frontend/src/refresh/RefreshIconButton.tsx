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

/** Small ↻ that refreshes every accessible connection and notifies all screens. */
export function RefreshIconButton({ disabled }: { disabled?: boolean }) {
  const { refreshAll, refreshing, refreshProgress, lastRefreshedAt } = useRefresh();
  const stamp = refreshTimeLabel(lastRefreshedAt);
  const progressLabel =
    refreshProgress && refreshProgress.total > 0
      ? ` (${refreshProgress.done}/${refreshProgress.total})`
      : "";
  const title = refreshing
    ? `Atualizando todas as conexões e telas…${progressLabel}`
    : stamp
      ? `Atualizar todas as conexões e telas — atualizado em ${stamp}`
      : "Atualizar todas as conexões e telas";

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
