// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readMigratedStorageItem,
  removeMigratedStorageItem,
  writeMigratedStorageItem,
} from "./storage-keys";

const PRIMARY = "paperwork.test";
const LEGACY = "paperclip.test";
const storage = new Map<string, string>();
const fakeLocalStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
  clear: () => storage.clear(),
};

function withLocalStorage(value: unknown, run: () => void) {
  const original = window.localStorage;
  Object.defineProperty(window, "localStorage", { value, configurable: true });
  try {
    run();
  } finally {
    Object.defineProperty(window, "localStorage", { value: original, configurable: true });
  }
}

function denied() {
  throw new Error("storage denied");
}

Object.defineProperty(window, "localStorage", { value: fakeLocalStorage, configurable: true });

beforeEach(() => storage.clear());
afterEach(() => storage.clear());

describe("storage-keys migration helpers", () => {
  it("returns the primary value without disturbing legacy", () => {
    storage.set(PRIMARY, "primary-value");
    storage.set(LEGACY, "legacy-value");

    expect(readMigratedStorageItem(PRIMARY, LEGACY)).toBe("primary-value");
    expect(storage.get(LEGACY)).toBe("legacy-value");
  });

  it("falls back to legacy, copies it to primary, and returns it", () => {
    storage.set(LEGACY, "legacy-value");

    expect(readMigratedStorageItem(PRIMARY, LEGACY)).toBe("legacy-value");
    expect(storage.get(PRIMARY)).toBe("legacy-value");
  });

  it("returns null when neither key is stored", () => {
    expect(readMigratedStorageItem(PRIMARY, LEGACY)).toBeNull();
  });

  it("writes the primary key and cleans up the legacy key", () => {
    storage.set(LEGACY, "stale");

    writeMigratedStorageItem(PRIMARY, LEGACY, "fresh");

    expect(storage.get(PRIMARY)).toBe("fresh");
    expect(storage.has(LEGACY)).toBe(false);
  });

  it("removes both keys", () => {
    storage.set(PRIMARY, "a");
    storage.set(LEGACY, "b");

    removeMigratedStorageItem(PRIMARY, LEGACY);

    expect(storage.has(PRIMARY)).toBe(false);
    expect(storage.has(LEGACY)).toBe(false);
  });

  it("stays safe when localStorage throws", () => {
    withLocalStorage({ getItem: denied, setItem: denied, removeItem: denied }, () => {
      expect(readMigratedStorageItem(PRIMARY, LEGACY)).toBeNull();
      expect(() => writeMigratedStorageItem(PRIMARY, LEGACY, "v")).not.toThrow();
      expect(() => removeMigratedStorageItem(PRIMARY, LEGACY)).not.toThrow();
    });
  });

  it("stays safe when localStorage itself is unavailable", () => {
    withLocalStorage(undefined, () => {
      expect(readMigratedStorageItem(PRIMARY, LEGACY)).toBeNull();
      expect(() => writeMigratedStorageItem(PRIMARY, LEGACY, "v")).not.toThrow();
      expect(() => removeMigratedStorageItem(PRIMARY, LEGACY)).not.toThrow();
    });
  });
});
