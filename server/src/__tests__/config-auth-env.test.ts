import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";

const ORIGINAL_ENV = { ...process.env };

const AUTH_ENV_KEYS = [
  "PAPERWORK_AUTH_BASE_URL_MODE",
  "PAPERCLIP_AUTH_BASE_URL_MODE",
  "PAPERWORK_AUTH_PUBLIC_BASE_URL",
  "PAPERCLIP_AUTH_PUBLIC_BASE_URL",
  "PAPERWORK_AUTH_DISABLE_SIGN_UP",
  "PAPERCLIP_AUTH_DISABLE_SIGN_UP",
  "BETTER_AUTH_URL",
  "BETTER_AUTH_BASE_URL",
  "PAPERCLIP_PUBLIC_URL",
];

function resetAuthEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    process.env[key] = value;
  }
  for (const key of AUTH_ENV_KEYS) delete process.env[key];
  process.env.PAPERCLIP_CONFIG = path.join(
    os.tmpdir(),
    "paperclip-config-auth-env-test-nonexistent",
    "config.json",
  );
}

beforeEach(resetAuthEnv);

describe("auth environment variable parity", () => {
  it("prefers PAPERWORK_AUTH_BASE_URL_MODE over the PAPERCLIP legacy value", () => {
    process.env.PAPERWORK_AUTH_BASE_URL_MODE = "explicit";
    process.env.PAPERCLIP_AUTH_BASE_URL_MODE = "auto";
    process.env.PAPERWORK_AUTH_PUBLIC_BASE_URL = "https://auth.example.com";

    expect(loadConfig().authBaseUrlMode).toBe("explicit");
  });

  it("falls back to PAPERCLIP_AUTH_BASE_URL_MODE when PAPERWORK is unset or blank", () => {
    process.env.PAPERCLIP_AUTH_BASE_URL_MODE = "explicit";
    process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL = "https://legacy.example.com";
    expect(loadConfig().authBaseUrlMode).toBe("explicit");

    process.env.PAPERWORK_AUTH_BASE_URL_MODE = "   ";
    expect(loadConfig().authBaseUrlMode).toBe("explicit");
  });

  it("treats a non-empty invalid PAPERWORK mode as winning and ignores the valid legacy mode", () => {
    process.env.PAPERWORK_AUTH_BASE_URL_MODE = "not-a-mode";
    process.env.PAPERCLIP_AUTH_BASE_URL_MODE = "explicit";

    expect(loadConfig().authBaseUrlMode).toBe("auto");
  });

  it("prefers PAPERWORK_AUTH_PUBLIC_BASE_URL over every fallback", () => {
    process.env.PAPERWORK_AUTH_PUBLIC_BASE_URL = " https://work.example.com ";
    process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL = "https://legacy.example.com";
    process.env.BETTER_AUTH_URL = "https://better-auth.example.com";

    expect(loadConfig().authPublicBaseUrl).toBe("https://work.example.com");
  });

  it("falls back to PAPERCLIP then BETTER_AUTH_URL for the public base url", () => {
    process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL = "https://legacy.example.com";
    process.env.BETTER_AUTH_URL = "https://better-auth.example.com";
    expect(loadConfig().authPublicBaseUrl).toBe("https://legacy.example.com");

    delete process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL;
    expect(loadConfig().authPublicBaseUrl).toBe("https://better-auth.example.com");
  });

  it("lets a blank PAPERWORK public base url fall through to the legacy value", () => {
    process.env.PAPERWORK_AUTH_PUBLIC_BASE_URL = "  ";
    process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL = "https://legacy.example.com";

    expect(loadConfig().authPublicBaseUrl).toBe("https://legacy.example.com");
  });

  it("prefers PAPERWORK_AUTH_DISABLE_SIGN_UP even when it disables the restriction", () => {
    process.env.PAPERWORK_AUTH_DISABLE_SIGN_UP = "false";
    process.env.PAPERCLIP_AUTH_DISABLE_SIGN_UP = "true";
    expect(loadConfig().authDisableSignUp).toBe(false);

    process.env.PAPERWORK_AUTH_DISABLE_SIGN_UP = "true";
    expect(loadConfig().authDisableSignUp).toBe(true);
  });

  it("falls back to PAPERCLIP_AUTH_DISABLE_SIGN_UP when PAPERWORK is unset or blank", () => {
    process.env.PAPERCLIP_AUTH_DISABLE_SIGN_UP = "true";
    expect(loadConfig().authDisableSignUp).toBe(true);

    process.env.PAPERWORK_AUTH_DISABLE_SIGN_UP = "";
    expect(loadConfig().authDisableSignUp).toBe(true);
  });

  it("defaults to sign-up enabled when no disable override is configured", () => {
    expect(loadConfig().authDisableSignUp).toBe(false);
  });
});
