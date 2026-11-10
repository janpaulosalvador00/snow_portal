import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api, ApiError, getActiveConnectionId } from "../api/client";

type RefreshResult = {
  ok: boolean;
  refreshed_at: string;
  total: number;
  failed: number;
  warehouse_auto_saved: string | null;
};

type RefreshContextValue = {
  /** Re-query Snowflake for every screen/tab of a connection (default: active), then notify pages. */
  refreshAll: (connectionId?: number) => Promise<void>;
  /** Bumps after each global refresh; pages add it to their load effects. */
  refreshToken: number;
  refreshing: boolean;
  lastRefreshedAt: string | null;
  refreshError: string | null;
};

const RefreshContext = createContext<RefreshContextValue | null>(null);

export function RefreshProvider({ children }: { children: ReactNode }) {
  const [refreshToken, setRefreshToken] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);

  const refreshAll = useCallback((connectionId?: number) => {
    if (inFlight.current) return inFlight.current;
    const id = connectionId ?? getActiveConnectionId();
    if (!id) {
      setRefreshToken((n) => n + 1);
      return Promise.resolve();
    }
    setRefreshing(true);
    setRefreshError(null);
    const run = api<RefreshResult>(`/api/connections/${id}/refresh`, { method: "POST" })
      .then((res) => {
        setLastRefreshedAt(res.refreshed_at);
        if (res.failed > 0) {
          setRefreshError(`${res.failed} de ${res.total} consultas não atualizaram.`);
        }
      })
      .catch((e) => {
        setRefreshError(e instanceof ApiError ? e.message : "Falha ao atualizar os dados.");
      })
      .finally(() => {
        inFlight.current = null;
        setRefreshing(false);
        setRefreshToken((n) => n + 1);
      });
    inFlight.current = run;
    return run;
  }, []);

  const value = useMemo(
    () => ({ refreshAll, refreshToken, refreshing, lastRefreshedAt, refreshError }),
    [refreshAll, refreshToken, refreshing, lastRefreshedAt, refreshError],
  );
  return <RefreshContext.Provider value={value}>{children}</RefreshContext.Provider>;
}

export function useRefresh(): RefreshContextValue {
  const ctx = useContext(RefreshContext);
  if (!ctx) throw new Error("useRefresh must be used inside RefreshProvider");
  return ctx;
}
