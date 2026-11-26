import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  SETTINGS_LOCAL_RELATIVE_PATH,
  ensureCommandCodeAdditionalDirectories,
  mergeAdditionalDirectories,
} from "./settings.js";

async function withWorkspace(fn: (root: string, workspace: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cmd-settings-"));
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  try {
    await fn(root, workspace);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function readSettings(workspace: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(path.join(workspace, SETTINGS_LOCAL_RELATIVE_PATH), "utf8"));
}

describe("mergeAdditionalDirectories", () => {
  it("creates the permissions block from an empty document", () => {
    const merged = mergeAdditionalDirectories(undefined, ["/srv/shared/refs"]);
    expect(merged.changed).toBe(true);
    expect(merged.settings).toEqual({ permissions: { additionalDirectories: ["/srv/shared/refs"] } });
  });

  it("preserves unrelated permission settings and existing directories", () => {
    const merged = mergeAdditionalDirectories(
      { permissions: { allow: ["read"], deny: ["rm"], defaultMode: "auto-accept", additionalDirectories: ["/a"] } },
      ["/b"],
    );
    expect(merged.changed).toBe(true);
    expect(merged.settings.permissions).toEqual({
      allow: ["read"],
      deny: ["rm"],
      defaultMode: "auto-accept",
      additionalDirectories: ["/a", "/b"],
    });
  });

  it("reports no change when every directory is already granted", () => {
    const merged = mergeAdditionalDirectories({ permissions: { additionalDirectories: ["/a"] } }, ["/a", "/a"]);
    expect(merged.changed).toBe(false);
    expect(merged.next).toEqual(["/a"]);
  });
});

describe("ensureCommandCodeAdditionalDirectories", () => {
  it("writes a project-local settings file when none exists", async () => {
    await withWorkspace(async (_root, workspace) => {
      const result = await ensureCommandCodeAdditionalDirectories({ cwd: workspace, directories: ["/srv/shared/refs"] });
      expect(result.applied).toBe(true);
      expect(result.changed).toBe(true);
      expect(await readSettings(workspace)).toEqual({ permissions: { additionalDirectories: ["/srv/shared/refs"] } });
    });
  });

  it("merges into an existing settings file without rewriting it", async () => {
    await withWorkspace(async (_root, workspace) => {
      const settingsPath = path.join(workspace, SETTINGS_LOCAL_RELATIVE_PATH);
      await fs.mkdir(path.dirname(settingsPath), { recursive: true });
      await fs.writeFile(
        settingsPath,
        JSON.stringify({ permissions: { deny: ["shell(rm)"], additionalDirectories: ["/a"] }, theme: "dark" }),
        "utf8",
      );
      await ensureCommandCodeAdditionalDirectories({ cwd: workspace, directories: ["/b"] });
      expect(await readSettings(workspace)).toEqual({
        theme: "dark",
        permissions: { deny: ["shell(rm)"], additionalDirectories: ["/a", "/b"] },
      });
    });
  });

  it("does not touch the file when the directory is already granted", async () => {
    await withWorkspace(async (_root, workspace) => {
      const settingsPath = path.join(workspace, SETTINGS_LOCAL_RELATIVE_PATH);
      await fs.mkdir(path.dirname(settingsPath), { recursive: true });
      const original = '{"permissions":{"additionalDirectories":["/a"]}}\n';
      await fs.writeFile(settingsPath, original, "utf8");
      const result = await ensureCommandCodeAdditionalDirectories({ cwd: workspace, directories: ["/a"] });
      expect(result).toMatchObject({ applied: true, changed: false });
      expect(await fs.readFile(settingsPath, "utf8")).toBe(original);
    });
  });

  it("refuses to overwrite an unparseable settings file", async () => {
    await withWorkspace(async (_root, workspace) => {
      const settingsPath = path.join(workspace, SETTINGS_LOCAL_RELATIVE_PATH);
      await fs.mkdir(path.dirname(settingsPath), { recursive: true });
      await fs.writeFile(settingsPath, "{ not json", "utf8");
      const result = await ensureCommandCodeAdditionalDirectories({ cwd: workspace, directories: ["/a"] });
      expect(result.applied).toBe(false);
      expect(result.skippedReason).toContain("could not read existing settings file");
      expect(await fs.readFile(settingsPath, "utf8")).toBe("{ not json");
    });
  });

  it("skips entirely when no directories are configured", async () => {
    await withWorkspace(async (_root, workspace) => {
      const result = await ensureCommandCodeAdditionalDirectories({ cwd: workspace, directories: [] });
      expect(result).toMatchObject({ applied: false, changed: false, skippedReason: "no additionalDirectories configured" });
      await expect(fs.stat(path.join(workspace, SETTINGS_LOCAL_RELATIVE_PATH))).rejects.toThrow();
    });
  });
});
