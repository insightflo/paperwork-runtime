// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ThemeProvider, useTheme } from "./ThemeContext";

const THEME_STORAGE_KEY = "paperwork.theme";
const LEGACY_THEME_STORAGE_KEY = "paperclip.theme";
const storage = new Map<string, string>();

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(window, "localStorage", {
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: (key: string) => {
      storage.delete(key);
    },
    clear: () => {
      storage.clear();
    },
  },
  configurable: true,
});

let host: HTMLDivElement;
let root: Root;
let observedTheme: "light" | "dark" | null = null;
let toggleTheme: (() => void) | null = null;

function ThemeProbe() {
  const theme = useTheme();
  observedTheme = theme.theme;
  toggleTheme = theme.toggleTheme;
  return null;
}

async function renderProvider() {
  await act(async () => {
    root.render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>,
    );
  });
}

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.classList.remove("dark");
  document.documentElement.style.colorScheme = "";
  observedTheme = null;
  toggleTheme = null;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  window.localStorage.clear();
  document.documentElement.classList.remove("dark");
  document.documentElement.style.colorScheme = "";
});

describe("ThemeContext", () => {
  it("boots into the dark cockpit theme when no preference is stored", async () => {
    await renderProvider();

    expect(observedTheme).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(window.localStorage.getItem(LEGACY_THEME_STORAGE_KEY)).toBeNull();
  });

  it("restores an explicit light preference", async () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "light");

    await renderProvider();

    expect(observedTheme).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(document.documentElement.style.colorScheme).toBe("light");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(window.localStorage.getItem(LEGACY_THEME_STORAGE_KEY)).toBeNull();
  });

  it("persists toggled theme preferences", async () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    await renderProvider();

    await act(async () => toggleTheme?.());
    expect(observedTheme).toBe("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(window.localStorage.getItem(LEGACY_THEME_STORAGE_KEY)).toBeNull();
    expect(document.documentElement.classList.contains("dark")).toBe(true);

    await act(async () => toggleTheme?.());
    expect(observedTheme).toBe("light");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(window.localStorage.getItem(LEGACY_THEME_STORAGE_KEY)).toBeNull();
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("hydrates a legacy paperclip.theme preference and migrates it", async () => {
    window.localStorage.setItem(LEGACY_THEME_STORAGE_KEY, "light");

    await renderProvider();

    expect(observedTheme).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(document.documentElement.style.colorScheme).toBe("light");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(window.localStorage.getItem(LEGACY_THEME_STORAGE_KEY)).toBeNull();
  });

  it("keeps the legacy key cleared while persisting toggles from a migrated preference", async () => {
    window.localStorage.setItem(LEGACY_THEME_STORAGE_KEY, "dark");
    await renderProvider();
    expect(observedTheme).toBe("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(window.localStorage.getItem(LEGACY_THEME_STORAGE_KEY)).toBeNull();

    await act(async () => toggleTheme?.());
    expect(observedTheme).toBe("light");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(window.localStorage.getItem(LEGACY_THEME_STORAGE_KEY)).toBeNull();
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });
});
