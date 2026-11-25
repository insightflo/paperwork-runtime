import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { createBetterAuthInstance } from "../auth/better-auth.js";
import {
  createPasswordResetSender,
  maskEmail,
  type PasswordResetDelivery,
  type PasswordResetLogger,
} from "../auth/password-reset.js";
import type { Config } from "../config.js";

const email = "user@example.com";
const rawToken = "raw-reset-token";
const resetUrl = `https://paperwork.example.com/api/auth/reset-password/${rawToken}?callbackURL=https%3A%2F%2Fpaperwork.example.com%2Freset`;

function input() {
  return {
    user: { email },
    url: resetUrl,
    token: rawToken,
  };
}

function captureLogger() {
  const calls: Array<[Record<string, unknown>, string]> = [];
  const logger: PasswordResetLogger = {
    warn(metadata, message) {
      calls.push([metadata, message]);
    },
  };
  return { calls, logger };
}

function serializedLogs(calls: Array<[Record<string, unknown>, string]>): string {
  return JSON.stringify(calls);
}

describe("maskEmail", () => {
  it("redacts local and domain identity without retaining the raw email", () => {
    expect(maskEmail(email)).toBe("u***@e***.com");
    expect(maskEmail("a@b.co")).toBe("*@*.co");
    expect(maskEmail("not-an-email")).toBe("***");
    expect(maskEmail(email)).not.toContain(email);
  });
});

describe("createPasswordResetSender", () => {
  it("passes the reset URL and token to an injectable delivery callback without logging them", async () => {
    const received: PasswordResetDelivery[] = [];
    const { calls, logger } = captureLogger();
    const sendResetPassword = createPasswordResetSender({
      deliver(delivery) {
        received.push(delivery);
        throw new Error(`adapter failure mentioning ${rawToken}`);
      },
      logger,
    });

    await expect(sendResetPassword(input())).rejects.toThrow("Password reset delivery failed");

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ email, url: resetUrl, token: rawToken });
    expect(received[0].expiresAt).toBeInstanceOf(Date);
    expect(calls).toHaveLength(1);
    expect(serializedLogs(calls)).not.toContain(rawToken);
    expect(serializedLogs(calls)).not.toContain(resetUrl);
    expect(serializedLogs(calls)).toContain("u***@e***.com");
  });

  it("posts the expected webhook JSON payload with a bounded abort signal", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const { logger } = captureLogger();
    const sendResetPassword = createPasswordResetSender({
      webhookUrl: "https://webhook.example.com/reset",
      fetchImpl,
      logger,
    });

    await expect(sendResetPassword(input())).resolves.toBeUndefined();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [endpoint, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(endpoint).toBe("https://webhook.example.com/reset");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "content-type": "application/json" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(payload).toEqual({
      email,
      url: resetUrl,
      expiresAt: expect.any(String),
    });
    expect(payload).not.toHaveProperty("token");
    expect(Number.isNaN(Date.parse(String(payload.expiresAt)))).toBe(false);
  });

  it("uses PAPERCLIP webhook env fallback and prefers PAPERWORK when both are configured", async () => {
    vi.stubEnv("PAPERWORK_AUTH_RESET_WEBHOOK_URL", "");
    vi.stubEnv("PAPERCLIP_AUTH_RESET_WEBHOOK_URL", "https://clip-env-webhook.example.com/reset");
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const sendResetPassword = createPasswordResetSender({
      fetchImpl,
      logger: captureLogger().logger,
    });

    await sendResetPassword(input());
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://clip-env-webhook.example.com/reset");

    vi.stubEnv("PAPERWORK_AUTH_RESET_WEBHOOK_URL", "https://work-env-webhook.example.com/reset");
    await sendResetPassword(input());
    expect(fetchImpl.mock.calls[1]?.[0]).toBe("https://work-env-webhook.example.com/reset");
    vi.unstubAllEnvs();
  });

  it("fails closed with sanitized errors for non-2xx webhook responses", async () => {
    const fetchImpl = vi.fn(async () => new Response("upstream failure", { status: 503 }));
    const { calls, logger } = captureLogger();
    const sendResetPassword = createPasswordResetSender({
      webhookUrl: "https://webhook.example.com/reset",
      fetchImpl,
      logger,
    });

    await expect(sendResetPassword(input())).rejects.toThrow("Password reset delivery failed");

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
    expect(serializedLogs(calls)).not.toContain(rawToken);
    expect(serializedLogs(calls)).not.toContain(resetUrl);
  });

  it("fails closed with sanitized errors for webhook network failures", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError(`network failure for ${rawToken}`);
    });
    const { calls, logger } = captureLogger();
    const sendResetPassword = createPasswordResetSender({
      webhookUrl: "https://webhook.example.com/reset",
      fetchImpl,
      logger,
    });

    await expect(sendResetPassword(input())).rejects.toThrow("Password reset delivery failed");

    expect(serializedLogs(calls)).not.toContain(rawToken);
  });

  it("does not call fetch and fails closed for an invalid webhook URL", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const { calls, logger } = captureLogger();
    const sendResetPassword = createPasswordResetSender({
      webhookUrl: "file:///tmp/password-reset-webhook",
      fetchImpl,
      logger,
    });

    await expect(sendResetPassword(input())).rejects.toThrow("Password reset delivery is not configured");

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(serializedLogs(calls)).not.toContain(rawToken);
  });

  it("returns without delivery when unconfigured and logs only masked metadata", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const { calls, logger } = captureLogger();
    const sendResetPassword = createPasswordResetSender({
      webhookUrl: null,
      fetchImpl,
      logger,
    });

    await expect(sendResetPassword(input())).resolves.toBeUndefined();

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toEqual({
      email: "u***@e***.com",
      expiresAt: expect.any(String),
    });
    expect(serializedLogs(calls)).not.toContain(rawToken);
    expect(serializedLogs(calls)).not.toContain(resetUrl);
  });
});

describe("createBetterAuthInstance password reset wiring", () => {
  it("configures sendResetPassword and a one-hour token expiry without changing instance creation", () => {
    const config = {
      deploymentMode: "authenticated",
      allowedHostnames: [],
      authBaseUrlMode: "explicit",
      authPublicBaseUrl: "https://auth.example.com",
      authDisableSignUp: false,
      authSocialProviders: [],
    } as unknown as Config;

    const auth = createBetterAuthInstance({} as Db, config, ["https://auth.example.com"]);

    expect(auth.options.emailAndPassword?.sendResetPassword).toBeTypeOf("function");
    expect(auth.options.emailAndPassword?.resetPasswordTokenExpiresIn).toBe(3600);
    expect(auth.options.emailAndPassword?.enabled).toBe(true);
    expect(auth.options.emailAndPassword?.disableSignUp).toBe(false);
  });
});
