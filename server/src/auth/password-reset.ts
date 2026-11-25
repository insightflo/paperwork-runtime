export type PasswordResetDelivery = {
  email: string;
  url: string;
  token: string;
  expiresAt: Date;
};

export type PasswordResetDeliver = (delivery: PasswordResetDelivery) => void | Promise<void>;

export type PasswordResetLogger = {
  warn: (metadata: Record<string, unknown>, message: string) => void;
};

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

type WebhookResolution =
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "valid"; url: string };

export const PASSWORD_RESET_EXPIRES_IN_SECONDS = 3600;
const DELIVERY_ERROR_MESSAGE = "Password reset delivery failed";
const UNCONFIGURED_ERROR_MESSAGE = "Password reset delivery is not configured";

const defaultLogger: PasswordResetLogger = {
  warn(metadata, message) {
    console.warn(message, metadata);
  },
};

export function maskEmail(email: string): string {
  const trimmed = email.trim();
  const at = trimmed.indexOf("@");
  if (at <= 0 || at === trimmed.length - 1) return "***";

  const maskPart = (value: string) => (value.length <= 1 ? "*" : `${value[0]}***`);
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  const firstDot = domain.indexOf(".");
  const domainName = firstDot === -1 ? domain : domain.slice(0, firstDot);
  const domainSuffix = firstDot === -1 ? "" : domain.slice(firstDot);

  return `${maskPart(local)}@${maskPart(domainName)}${domainSuffix}`;
}

function resolveWebhookUrl(explicitUrl?: string | null): WebhookResolution {
  const paperworkUrl = process.env.PAPERWORK_AUTH_RESET_WEBHOOK_URL;
  const envUrl = paperworkUrl?.trim() ? paperworkUrl : process.env.PAPERCLIP_AUTH_RESET_WEBHOOK_URL;
  const raw = explicitUrl !== undefined ? explicitUrl : envUrl;
  const trimmed = raw?.trim();
  if (!trimmed) return { kind: "missing" };

  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return { kind: "invalid" };
    return { kind: "valid", url: url.toString() };
  } catch {
    return { kind: "invalid" };
  }
}

function safeMetadata(email: string, expiresAt: Date): Record<string, unknown> {
  return {
    email: maskEmail(email),
    expiresAt: expiresAt.toISOString(),
  };
}

function deliveryError(message = DELIVERY_ERROR_MESSAGE): Error {
  return new Error(message);
}

export type CreatePasswordResetSenderOptions = {
  deliver?: PasswordResetDeliver;
  webhookUrl?: string | null;
  expiresInSeconds?: number;
  fetchImpl?: FetchLike;
  logger?: PasswordResetLogger;
};

export function createPasswordResetSender(opts: CreatePasswordResetSenderOptions = {}) {
  const expiresInSeconds = opts.expiresInSeconds ?? PASSWORD_RESET_EXPIRES_IN_SECONDS;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const logger = opts.logger ?? defaultLogger;

  return async function sendResetPassword({ user, url, token }: {
    user: { email?: string | null };
    url: string;
    token: string;
  }): Promise<void> {
    const email = typeof user.email === "string" ? user.email : "";
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);
    const metadata = () => safeMetadata(email, expiresAt);

    if (opts.deliver) {
      try {
        await opts.deliver({ email, url, token, expiresAt });
        return;
      } catch {
        logger.warn(metadata(), "Password reset delivery failed");
        throw deliveryError();
      }
    }

    const webhook = resolveWebhookUrl(opts.webhookUrl);
    if (webhook.kind === "invalid") {
      logger.warn(metadata(), "Password reset delivery is not configured");
      throw deliveryError(UNCONFIGURED_ERROR_MESSAGE);
    }

    if (webhook.kind === "valid") {
      try {
        const response = await fetchImpl(webhook.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, url, expiresAt: expiresAt.toISOString() }),
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw new Error("non-2xx webhook response");
        return;
      } catch {
        logger.warn(metadata(), "Password reset delivery failed");
        throw deliveryError();
      }
    }

    logger.warn(metadata(), "Password reset delivery is not configured");
  };
}
