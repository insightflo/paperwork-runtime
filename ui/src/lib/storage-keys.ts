/**
 * Shared helpers for reading and writing localStorage keys that were migrated
 * from the legacy "paperclip.*" namespace to the "paperwork.*" namespace.
 *
 * Every helper is best-effort: storage can be unavailable in SSR contexts,
 * private browsing modes, or restricted environments, so all failures are
 * swallowed instead of breaking app bootstrap.
 */

function safeLocalStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Reads `primaryKey` first. When it is missing, falls back to `legacyKey` and
 * copies the legacy value into the primary key so old clients upgrade in
 * place. Returns null when neither key holds a value.
 */
export function readMigratedStorageItem(primaryKey: string, legacyKey: string): string | null {
  const storage = safeLocalStorage();
  if (!storage) return null;
  try {
    const primary = storage.getItem(primaryKey);
    if (primary !== null) return primary;
    const legacy = storage.getItem(legacyKey);
    if (legacy !== null) {
      try {
        storage.setItem(primaryKey, legacy);
      } catch {
        // Migration write is best-effort; the legacy value is still returned.
      }
    }
    return legacy;
  } catch {
    return null;
  }
}

/**
 * Writes `value` to `primaryKey` and removes the stale `legacyKey` entry so
 * migrated clients stop leaving data under the old namespace.
 */
export function writeMigratedStorageItem(primaryKey: string, legacyKey: string, value: string): void {
  const storage = safeLocalStorage();
  if (!storage) return;
  try {
    storage.setItem(primaryKey, value);
  } catch {
    // Ignore write failures in restricted environments.
  }
  try {
    storage.removeItem(legacyKey);
  } catch {
    // Legacy cleanup is best-effort.
  }
}

/**
 * Removes both the migrated `primaryKey` and the `legacyKey` entry.
 */
export function removeMigratedStorageItem(primaryKey: string, legacyKey: string): void {
  const storage = safeLocalStorage();
  if (!storage) return;
  try {
    storage.removeItem(primaryKey);
  } catch {
    // Ignore removal failures in restricted environments.
  }
  try {
    storage.removeItem(legacyKey);
  } catch {
    // Legacy cleanup is best-effort.
  }
}
