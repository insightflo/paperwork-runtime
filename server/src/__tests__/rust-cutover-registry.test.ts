import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  applyUnifiedRustCoreCutoverEnv,
  getRustCoreCutoverStatus,
  RUST_CORE_CUTOVER_ENV_KEYS,
} from "../services/rust-cutover-registry.js";

const servicesDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../services",
);
const cutoverKeyPattern = /PAPERWORK_(?:ENGINE|RUST)_[A-Z0-9_]+_CUTOVER/g;

function scannedServiceCutoverKeys(): string[] {
  const keys = new Set<string>();
  for (const entry of readdirSync(servicesDir, { withFileTypes: true })) {
    if (
      !entry.isFile()
      || !entry.name.endsWith(".ts")
      || !entry.name.includes("cutover")
      || entry.name === "rust-cutover-registry.ts"
    ) {
      continue;
    }
    const source = readFileSync(path.join(servicesDir, entry.name), "utf8");
    for (const match of source.matchAll(cutoverKeyPattern)) {
      keys.add(match[0]);
    }
  }
  return [...keys].sort();
}

describe("RUST_CORE_CUTOVER_ENV_KEYS", () => {
  it("covers every cutover env key read by server service modules", () => {
    expect(scannedServiceCutoverKeys()).toEqual([...RUST_CORE_CUTOVER_ENV_KEYS]);
  });
});

describe("applyUnifiedRustCoreCutoverEnv", () => {
  it("enables every key when PAPERWORK_RUST_CORE_ALL is 1 and keys are unset", () => {
    const env: NodeJS.ProcessEnv = { PAPERWORK_RUST_CORE_ALL: "1" };

    const result = applyUnifiedRustCoreCutoverEnv(env);

    expect(result.masterEnabled).toBe(true);
    expect(result.optedOutKeys).toEqual([]);
    expect(result.enabledKeys).toEqual([...RUST_CORE_CUTOVER_ENV_KEYS]);
    for (const key of RUST_CORE_CUTOVER_ENV_KEYS) {
      expect(env[key]).toBe("1");
    }
  });

  it("treats an empty value as unset when the master switch is enabled", () => {
    const key = RUST_CORE_CUTOVER_ENV_KEYS[0];
    const env: NodeJS.ProcessEnv = { PAPERWORK_RUST_CORE_ALL: "1", [key]: "" };

    const result = applyUnifiedRustCoreCutoverEnv(env);

    expect(env[key]).toBe("1");
    expect(result.enabledKeys).toContain(key);
  });

  it("preserves an explicit 0 as a surgical rollback opt-out", () => {
    const key = RUST_CORE_CUTOVER_ENV_KEYS[0];
    const env: NodeJS.ProcessEnv = { PAPERWORK_RUST_CORE_ALL: "1", [key]: "0" };

    const result = applyUnifiedRustCoreCutoverEnv(env);

    expect(env[key]).toBe("0");
    expect(result.optedOutKeys).toEqual([key]);
    expect(result.enabledKeys).not.toContain(key);
    expect(result.enabledKeys).toHaveLength(RUST_CORE_CUTOVER_ENV_KEYS.length - 1);
  });

  it("does not mutate env when the master switch is unset or 0", () => {
    const enabledKey = RUST_CORE_CUTOVER_ENV_KEYS[0];
    const emptyKey = RUST_CORE_CUTOVER_ENV_KEYS[1];

    for (const masterValue of [undefined, "0"] as const) {
      const env: NodeJS.ProcessEnv = { [enabledKey]: "1", [emptyKey]: "" };
      if (masterValue !== undefined) env.PAPERWORK_RUST_CORE_ALL = masterValue;
      const before = { ...env };

      const result = applyUnifiedRustCoreCutoverEnv(env);

      expect(result.masterEnabled).toBe(false);
      expect(result.enabledKeys).toEqual([enabledKey]);
      expect(env).toEqual(before);
    }
  });
});

describe("getRustCoreCutoverStatus", () => {
  it("reports enabled and disabled keys without mutating env", () => {
    const enabledKey = RUST_CORE_CUTOVER_ENV_KEYS[0];
    const disabledKey = RUST_CORE_CUTOVER_ENV_KEYS[1];
    const env: NodeJS.ProcessEnv = {
      PAPERWORK_RUST_CORE_ALL: "0",
      [enabledKey]: "1",
    };

    const status = getRustCoreCutoverStatus(env);

    expect(status).toMatchObject({
      masterEnabled: false,
      total: RUST_CORE_CUTOVER_ENV_KEYS.length,
      enabled: [enabledKey],
    });
    expect(status.disabled).toContain(disabledKey);
    expect(status.disabled).not.toContain(enabledKey);
    expect(env[disabledKey]).toBeUndefined();
  });
});
