/** Durable connection lifecycle (`is_active`), not "ambiente atual" selection. */

export type ConnectionLifecycle = {
  id: number;
  is_active?: boolean | null;
};

/** In use / available. Missing field → treat as active (pre-migration payloads). */
export function isConnectionInUse(c: { is_active?: boolean | null }): boolean {
  return c.is_active !== false;
}

/** Operational consumers (refresh, Cost, Hub switch): only in-use connections. */
export function operationalConnections<T extends { is_active?: boolean | null }>(
  list: T[],
): T[] {
  return list.filter(isConnectionInUse);
}
