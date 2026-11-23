import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api, ApiError } from "../api/client";

type RefreshResult = {
  ok: boolean;
  refreshed_at: string;
  total: number;
  failed: number;
  warehouse_auto_saved: string | null;
};

type ConnRow = { id: number };

type RefreshProgress = { done: number; total: number } | null;

type RefreshContextValue = {
  /**
   * Without connectionId: refresh every connection the user can see.
   * With connectionId: refresh only that connection (e.g. Alerts per-card).
   */
  refreshAll: (connectionId?: number) => Promise<void>;
  /** Bumps after each global refresh; pages add it to their load effects. */
  refreshToken: number;
  refreshing: boolean;
  /** Progress while refreshing multiple connections (null when idle / single). */
  refreshProgress: RefreshProgress;
  lastRefreshedAt: string | null;
  refreshError: string | null;
};

const CONCURRENCY = 3;

const RefreshContext = createContext<RefreshContextValue | null>(null);

async function refreshOneConnection(id: number): Promise<RefreshResult> {
  return api<RefreshResult>(`/api/connections/${id}/refresh`, { method: "POST" });
}

/** Run async work over items with a fixed concurrency pool. */
async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  onEachDone?: (done: number, total: number) => void,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  let done = 0;
  const total = items.length;

  async function runWorker() {
    while (next < total) {
      const index = next++;
      results[index] = await worker(items[index], index);
      done += 1;
      onEachDone?.(done, total);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, total) }, () => runWorker());
  await Promise.all(workers);
  return results;
}

export function RefreshProvider({ children }: { children: ReactNode }) {
  const [refreshToken, setRefreshToken] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshProgress, setRefreshProgress] = useState<RefreshProgress>(null);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);

  const refreshAll = useCallback((connectionId?: number) => {
    if (inFlight.current) return inFlight.current;

    setRefreshing(true);
    setRefreshError(null);
    setRefreshProgress(null);

    const run = (async () => {
      try {
        if (connectionId != null) {
          const res = await refreshOneConnection(connectionId);
          setLastRefreshedAt(res.refreshed_at);
          if (res.failed > 0) {
            setRefreshError(`${res.failed} de ${res.total} consultas não atualizaram.`);
          }
          return;
        }

        const list = await api<ConnRow[]>("/api/connections");
        const ids = list.map((c) => c.id).filter((id) => Number.isFinite(id));
        if (ids.length === 0) {
          setLastRefreshedAt(new Date().toISOString());
          return;
        }

        setRefreshProgress({ done: 0, total: ids.length });

        type Outcome =
          | { id: number; ok: true; refreshed_at: string; queryFailed: number; queryTotal: number }
          | { id: number; ok: false; error: string };

        const outcomes = await mapPool(
          ids,
          CONCURRENCY,
          async (id): Promise<Outcome> => {
            try {
              const res = await refreshOneConnection(id);
              return {
                id,
                ok: true,
                refreshed_at: res.refreshed_at,
                queryFailed: res.failed,
                queryTotal: res.total,
              };
            } catch (e) {
              return {
                id,
                ok: false,
                error: e instanceof ApiError ? e.message : "Falha ao atualizar.",
              };
            }
          },
          (done, total) => setRefreshProgress({ done, total }),
        );

        const okOnes = outcomes.filter((o): o is Extract<Outcome, { ok: true }> => o.ok);
        const failedOnes = outcomes.filter((o): o is Extract<Outcome, { ok: false }> => !o.ok);
        const queryPartial = okOnes.filter((o) => o.queryFailed > 0);

        const latest = okOnes.reduce<string | null>((acc, o) => {
          if (!acc || o.refreshed_at > acc) return o.refreshed_at;
          return acc;
        }, null);
        setLastRefreshedAt(latest ?? new Date().toISOString());

        const parts: string[] = [];
        if (failedOnes.length > 0) {
          parts.push(
            `${failedOnes.length} de ${ids.length} conexões falharam` +
              (failedOnes.length <= 3
                ? ` (${failedOnes.map((f) => `#${f.id}: ${f.error}`).join("; ")})`
                : ""),
          );
        }
        if (queryPartial.length > 0) {
          const sumFailed = queryPartial.reduce((s, o) => s + o.queryFailed, 0);
          parts.push(
            `${queryPartial.length} conexão(ões) com consultas parciais (${sumFailed} falhas).`,
          );
        }
        if (parts.length) setRefreshError(parts.join(" "));
      } catch (e) {
        setRefreshError(e instanceof ApiError ? e.message : "Falha ao atualizar os dados.");
      } finally {
        inFlight.current = null;
        setRefreshing(false);
        setRefreshProgress(null);
        setRefreshToken((n) => n + 1);
      }
    })();

    inFlight.current = run;
    return run;
  }, []);

  const value = useMemo(
    () => ({
      refreshAll,
      refreshToken,
      refreshing,
      refreshProgress,
      lastRefreshedAt,
      refreshError,
    }),
    [refreshAll, refreshToken, refreshing, refreshProgress, lastRefreshedAt, refreshError],
  );
  return <RefreshContext.Provider value={value}>{children}</RefreshContext.Provider>;
}

export function useRefresh(): RefreshContextValue {
  const ctx = useContext(RefreshContext);
  if (!ctx) throw new Error("useRefresh must be used inside RefreshProvider");
  return ctx;
}
