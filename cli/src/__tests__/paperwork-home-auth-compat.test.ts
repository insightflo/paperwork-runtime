import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveDefaultCliAuthPath,
  resolveLegacyCliAuthPath,
  resolvePaperclipHomeDir,
  resolvePaperworkHomeDir,
} from "../config/home.js";

const ORIGINAL_ENV = { ...process.env };
const tempRoots: string[] = [];

function restoreEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function clearHomeEnv(): void {
  delete process.env.PAPERWORK_HOME;
  delete process.env.PAPERCLIP_HOME;
}

function createMockHome(): string {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperwork-home-auth-"));
  tempRoots.push(tempRoot);
  const home = path.join(tempRoot, "home");
  fs.mkdirSync(home, { recursive: true });
  vi.spyOn(os, "homedir").mockReturnValue(home);
  return home;
}

function writeAuthFile(homeDir: string): string {
  fs.mkdirSync(homeDir, { recursive: true });
  const authPath = path.resolve(homeDir, "auth.json");
  fs.writeFileSync(authPath, "{}\n", "utf8");
  return authPath;
}

describe("paperwork cli auth home compatibility", () => {
  beforeEach(() => {
    restoreEnv();
    clearHomeEnv();
  });

  afterEach(() => {
    restoreEnv();
    vi.restoreAllMocks();
    while (tempRoots.length > 0) {
      const tempRoot = tempRoots.pop();
      if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("defaults a fresh home directory to ~/.paperwork/auth.json", () => {
    const home = createMockHome();

    expect(resolveDefaultCliAuthPath()).toBe(path.resolve(home, ".paperwork", "auth.json"));
    expect(resolvePaperworkHomeDir()).toBe(path.resolve(home, ".paperwork"));
    expect(resolvePaperclipHomeDir()).toBe(path.resolve(home, ".paperclip"));
  });

  it("falls back to an existing legacy ~/.paperclip/auth.json", () => {
    const home = createMockHome();
    const legacyAuthPath = writeAuthFile(path.resolve(home, ".paperclip"));

    expect(resolveDefaultCliAuthPath()).toBe(legacyAuthPath);
    expect(resolveLegacyCliAuthPath()).toBe(legacyAuthPath);
  });

  it("prefers ~/.paperwork/auth.json when both auth files exist", () => {
    const home = createMockHome();
    const paperworkAuthPath = writeAuthFile(path.resolve(home, ".paperwork"));
    writeAuthFile(path.resolve(home, ".paperclip"));

    expect(resolveDefaultCliAuthPath()).toBe(paperworkAuthPath);
  });

  it("uses PAPERWORK_HOME before PAPERCLIP_HOME for the auth path", () => {
    const home = createMockHome();
    process.env.PAPERWORK_HOME = "~/paperwork-custom";
    process.env.PAPERCLIP_HOME = "~/paperclip-custom";

    expect(resolveDefaultCliAuthPath()).toBe(path.resolve(home, "paperwork-custom", "auth.json"));
    expect(resolvePaperworkHomeDir()).toBe(path.resolve(home, "paperwork-custom"));
    expect(resolvePaperclipHomeDir()).toBe(path.resolve(home, "paperwork-custom"));
  });

  it("uses PAPERCLIP_HOME for the auth path when PAPERWORK_HOME is absent", () => {
    const home = createMockHome();
    process.env.PAPERCLIP_HOME = "~/paperclip-custom";

    expect(resolveDefaultCliAuthPath()).toBe(path.resolve(home, "paperclip-custom", "auth.json"));
    expect(resolvePaperworkHomeDir()).toBe(path.resolve(home, "paperclip-custom"));
    expect(resolvePaperclipHomeDir()).toBe(path.resolve(home, "paperclip-custom"));
  });
});
