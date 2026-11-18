const dbConnectionUrls = new WeakMap<object, string>();

/** Associates a root Drizzle handle with its connection URL; transactions are never registered. */
export function registerDbConnectionUrl<T extends object>(db: T, url: string): T {
  dbConnectionUrls.set(db, url);
  return db;
}

/** Returns the PostgreSQL connection URL for a registered root DB handle, or null for transactions/mocks. */
export function getDbConnectionUrl(db: unknown): string | null {
  if (!db || typeof db !== "object") return null;
  return dbConnectionUrls.get(db) ?? null;
}
