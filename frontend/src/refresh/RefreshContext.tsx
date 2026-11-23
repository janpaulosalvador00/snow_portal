import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api, ApiError } from "../api/client";
import { operationalConnections } from "../connections/lifecycle";
import {
  CONNECTIONS_GLOBAL_INTERVAL_KEY,
  CONNECTIONS_LAST_REFRESHED_KEY,
  REFRESH_DUE_WATCHDOG_MS,
  computeNextRefreshAt,
  isRefreshDue,
  loadGlobalInterval,
  loadLastRefreshedAt,
} from "../connections/refreshIntervals";

type RefreshResult = {
  ok: boolean;
  refreshed_at: string;
  total: number;
  failed: number;
  warehouse_auto_saved: string | null;
};

type ConnRow = { id: number; refresh_interval?: number | null; is_active?: boolean | null };

type RefreshProgress = { done: number; total: number } | null;

type RefreshContextValue = {
  /**
   * Without connectionId: refresh every in-use connection the user can see.
   * With connectionId: refresh only that connection (e.g. Alerts per-card).
   * With number[]: refresh those connections (inactive ids are dropped).
   */
  refreshAll: (connectionId?: number | number[]) => Promise<void>;
  /** Bumps after each global refresh; pages add it to their load effects. */
  refreshToken: number;
  refreshing: boolean;
  /** Progress while refreshing multiple connections (null when idle / single). */
  refreshProgress: RefreshProgress;
  lastRefreshedAt: string | null;
  /** Next Contas salvas global auto-refresh (null when Desligada or never started). */
  nextGlobalRefreshAt: string | null;
  refreshError: string | null;
  /** Contas salvas global interval (seconds as string; "0" = off). */
  globalInterval: string;
  setGlobalInterval: (value: string) => void;
  /** Re-read connection schedules (after create/update/delete). */
  reloadSchedules: () => void;
  /** Seed schedules from a page that already loaded `/api/connections`. */
  syncSchedules: (list: ConnRow[]) => void;
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
  const [lastRefreshedAt, setLastRefreshedAtState] = useState<string | null>(loadLastRefreshedAt);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [globalInterval, setGlobalIntervalState] = useState(loadGlobalInterval);
  const [schedules, setSchedules] = useState<ConnRow[]>([]);
  const [scheduleTick, setScheduleTick] = useState(0);
  const inFlight = useRef<Promise<void> | null>(null);
  const lastRefreshedAtRef = useRef(lastRefreshedAt);
  const schedulesRef = useRef(schedules);
  /** Per-connection last auto-fire (ms); Global cohort uses lastRefreshedAt instead. */
  const connLastFireRef = useRef<Record<number, number>>({});
  const lastEmptyRetryMs = useRef(0);

  useEffect(() => {
    lastRefreshedAtRef.current = lastRefreshedAt;
  }, [lastRefreshedAt]);

  useEffect(() => {
    schedulesRef.current = schedules;
  }, [schedules]);

  const setLastRefreshedAt = useCallback((iso: string) => {
    setLastRefreshedAtState(iso);
    localStorage.setItem(CONNECTIONS_LAST_REFRESHED_KEY, iso);
  }, []);

  const setGlobalInterval = useCallback((value: string) => {
    setGlobalIntervalState(value);
    localStorage.setItem(CONNECTIONS_GLOBAL_INTERVAL_KEY, value);
  }, []);

  const reloadSchedules = useCallback(() => {
    setScheduleTick((n) => n + 1);
  }, []);

  const syncSchedules = useCallback((list: ConnRow[]) => {
    setSchedules(operationalConnections(list));
  }, []);

  useEffect(() => {
    let cancelled = false;
    void api<ConnRow[]>("/api/connections")
      .then((list) => {
        // Auto-refresh schedules: never include archived (is_active=false) connections.
        if (!cancelled) setSchedules(operationalConnections(list));
      })
      .catch(() => {
        // Keep prior schedules on error — clearing to [] dismantles timers while
        // Contas salvas can still show cards from its own successful fetch.
      });
    return () => {
      cancelled = true;
    };
  }, [scheduleTick, refreshToken]);

  const refreshAll = useCallback((connectionId?: number | number[]) => {
    if (inFlight.current) return inFlight.current;

    setRefreshing(true);
    setRefreshError(null);
    setRefreshProgress(null);

    const run = (async () => {
      try {
        if (typeof connectionId === "number") {
          const res = await refreshOneConnection(connectionId);
          setLastRefreshedAt(res.refreshed_at);
          if (res.failed > 0) {
            setRefreshError(`${res.failed} de ${res.total} consultas não atualizaram.`);
          }
          return;
        }

        // Resolve against a live catalog so archived connections never refresh,
        // including when callers pass an explicit id list (Global cohort timers).
        const catalog = operationalConnections(await api<ConnRow[]>("/api/connections"));
        // Keep timer schedules aligned with the live catalog.
        setSchedules(catalog);
        const activeIds = new Set(catalog.map((c) => c.id));
        const ids = (
          Array.isArray(connectionId) && connectionId.length
            ? connectionId.filter((id) => activeIds.has(id))
            : catalog.map((c) => c.id)
        ).filter((id) => Number.isFinite(id));
        if (ids.length === 0) {
          // Nothing refreshed — do not advance Última/Próxima (false tick).
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

  // Auto-refresh: wall-clock due check (not bare setInterval delays).
  // null = Global cohort; 0 = Desligada; 1..60 = own timer. schedules excludes is_active=false.
  // After Mac sleep / background tab, visibility/focus/pageshow + watchdog tick compare
  // Date.now() to last+interval and fire immediately when overdue.
  //
  // IMPORTANT: do not bail when schedules is empty — Contas salvas can show cards from its
  // own fetch while RefreshContext schedules stayed [] (cancelled fetch / error wipe). In
  // that case Próxima still renders from last+interval with no timer; keep retrying load.
  useEffect(() => {
    const globalSeconds = Number(globalInterval);
    // First fire with no last yet: wait one interval from this schedule start.
    const scheduleAnchorMs = Date.now();

    const checkDue = () => {
      if (document.visibilityState === "hidden") return;
      const now = Date.now();
      const current = schedulesRef.current;
      const globalIds = current
        .filter((c) => c.refresh_interval == null)
        .map((c) => c.id);

      if (!current.length) {
        // Schedules never landed — nudge a reload so we do not sit forever with a stale Próxima.
        if (now - lastEmptyRetryMs.current >= 15_000) {
          lastEmptyRetryMs.current = now;
          setScheduleTick((n) => n + 1);
        }
        return;
      }

      if (
        globalSeconds > 0 &&
        globalIds.length &&
        isRefreshDue(lastRefreshedAtRef.current, globalSeconds, now, scheduleAnchorMs)
      ) {
        void refreshAll(globalIds);
      }

      for (const conn of current) {
        const minutes = conn.refresh_interval;
        if (minutes == null || !Number.isFinite(minutes) || minutes <= 0) continue;
        const intervalSeconds = minutes * 60;
        const lastMs = connLastFireRef.current[conn.id];
        const lastIso = lastMs != null ? new Date(lastMs).toISOString() : null;
        if (isRefreshDue(lastIso, intervalSeconds, now, scheduleAnchorMs)) {
          connLastFireRef.current[conn.id] = now;
          void refreshAll(conn.id);
        }
      }
    };

    const tickId = window.setInterval(checkDue, REFRESH_DUE_WATCHDOG_MS);
    const onResume = () => {
      if (document.visibilityState === "hidden") return;
      checkDue();
    };
    document.addEventListener("visibilitychange", onResume);
    window.addEventListener("focus", onResume);
    window.addEventListener("pageshow", onResume);
    // Remount / wake: catch a Próxima already in the past.
    onResume();

    return () => {
      window.clearInterval(tickId);
      document.removeEventListener("visibilitychange", onResume);
      window.removeEventListener("focus", onResume);
      window.removeEventListener("pageshow", onResume);
    };
    // schedules via schedulesRef — avoid resetting the wall-clock anchor on every list update.
  }, [globalInterval, refreshAll]);

  // Same formula as AlertsPage: last && globalSeconds → last + interval.
  const nextGlobalRefreshAt = useMemo(
    () => computeNextRefreshAt(lastRefreshedAt, Number(globalInterval)),
    [globalInterval, lastRefreshedAt],
  );

  const value = useMemo(
    () => ({
      refreshAll,
      refreshToken,
      refreshing,
      refreshProgress,
      lastRefreshedAt,
      nextGlobalRefreshAt,
      refreshError,
      globalInterval,
      setGlobalInterval,
      reloadSchedules,
      syncSchedules,
    }),
    [
      refreshAll,
      refreshToken,
      refreshing,
      refreshProgress,
      lastRefreshedAt,
      nextGlobalRefreshAt,
      refreshError,
      globalInterval,
      setGlobalInterval,
      reloadSchedules,
      syncSchedules,
    ],
  );
  return <RefreshContext.Provider value={value}>{children}</RefreshContext.Provider>;
}

export function useRefresh(): RefreshContextValue {
  const ctx = useContext(RefreshContext);
  if (!ctx) throw new Error("useRefresh must be used inside RefreshProvider");
  return ctx;
}
