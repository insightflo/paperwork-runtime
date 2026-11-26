export type AuthSession = {
  session: { id: string; userId: string };
  user: { id: string; email: string | null; name: string | null };
};

export type SocialAuthProvider = {
  id: string;
  label: string;
};

export type AuthSessionInfo = {
  id: string;
  userId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  expiresAt: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  current: boolean;
};

export type ChangePasswordInput = {
  currentPassword: string;
  newPassword: string;
  revokeOtherSessions?: boolean;
};

export class AuthApiError extends Error {
  status: number;
  payload: unknown;

  constructor(message: string, status: number, payload: unknown) {
    super(message);
    this.name = "AuthApiError";
    this.status = status;
    this.payload = payload;
  }
}

const RATE_LIMIT_MESSAGE =
  "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요. / Too many requests. Please wait a moment and try again.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function nullableString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function payloadErrorMessage(payload: unknown, status: number) {
  if (!isRecord(payload)) return `Request failed: ${status}`;
  if (typeof payload.error === "string") return payload.error;
  if (isRecord(payload.error) && typeof payload.error.message === "string") return payload.error.message;
  if (typeof payload.message === "string") return payload.message;
  return `Request failed: ${status}`;
}

export function isAuthRateLimitError(error: unknown) {
  if (error instanceof AuthApiError) return error.status === 429;
  if (isRecord(error) && error.status === 429) return true;
  const message = error instanceof Error ? error.message : "";
  return /\b429\b|too many requests|rate.limit/i.test(message);
}

export function authErrorMessage(error: unknown, fallback: string) {
  if (isAuthRateLimitError(error)) return RATE_LIMIT_MESSAGE;
  return error instanceof Error ? error.message : fallback;
}

function toSession(value: unknown): AuthSession | null {
  if (!isRecord(value)) return null;
  const sessionValue = value.session;
  const userValue = value.user;
  if (!isRecord(sessionValue) || !isRecord(userValue)) return null;
  if (typeof sessionValue.id !== "string" || typeof sessionValue.userId !== "string") return null;
  if (typeof userValue.id !== "string") return null;
  return {
    session: { id: sessionValue.id, userId: sessionValue.userId },
    user: {
      id: userValue.id,
      email: nullableString(userValue.email),
      name: nullableString(userValue.name),
    },
  };
}

function toSocialAuthProviders(value: unknown): SocialAuthProvider[] {
  if (!isRecord(value) || !Array.isArray(value.providers)) return [];
  const parsed: SocialAuthProvider[] = [];
  for (const provider of value.providers) {
    if (!isRecord(provider)) continue;
    if (typeof provider.id !== "string" || typeof provider.label !== "string") continue;
    parsed.push({ id: provider.id, label: provider.label });
  }
  return parsed;
}

function toSessionInfo(value: unknown): AuthSessionInfo | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  return {
    id: value.id,
    userId: nullableString(value.userId),
    createdAt: nullableString(value.createdAt),
    updatedAt: nullableString(value.updatedAt),
    expiresAt: nullableString(value.expiresAt),
    ipAddress: nullableString(value.ipAddress) ?? nullableString(value.ip),
    userAgent: nullableString(value.userAgent) ?? nullableString(value.user_agent),
    current: value.current === true || value.isCurrent === true,
  };
}

function toSessionList(payload: unknown): AuthSessionInfo[] {
  const rows = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.sessions)
      ? payload.sessions
      : isRecord(payload) && Array.isArray(payload.data)
        ? payload.data
        : [];
  return rows.map(toSessionInfo).filter((session): session is AuthSessionInfo => !!session);
}

async function authRequest(path: string, init: { method?: string; body?: Record<string, unknown> } = {}) {
  const res = await fetch(`/api/auth${path}`, {
    method: init.method ?? "GET",
    credentials: "include",
    headers: {
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) throw new AuthApiError(payloadErrorMessage(payload, res.status), res.status, payload);
  return payload;
}

function authPost(path: string, body: Record<string, unknown>) {
  return authRequest(path, { method: "POST", body });
}

export const authApi = {
  getSession: async (): Promise<AuthSession | null> => {
    const res = await fetch("/api/auth/get-session", {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (res.status === 401) return null;
    const payload = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`Failed to load session (${res.status})`);
    const direct = toSession(payload);
    if (direct) return direct;
    return isRecord(payload) ? toSession(payload.data) : null;
  },

  getSocialProviders: async (): Promise<SocialAuthProvider[]> => {
    const res = await fetch("/api/auth/providers", {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return [];
    return toSocialAuthProviders(await res.json().catch(() => null));
  },

  listSessions: async (): Promise<AuthSessionInfo[]> => {
    return toSessionList(await authRequest("/sessions"));
  },

  revokeSession: async (sessionId: string): Promise<void> => {
    await authRequest(`/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
  },

  revokeOtherSessions: async (): Promise<void> => {
    await authPost("/sessions/revoke-others", {});
  },

  changePassword: async (input: ChangePasswordInput): Promise<void> => {
    await authPost("/change-password", input);
  },

  signInEmail: async (input: { email: string; password: string }) => {
    await authPost("/sign-in/email", input);
  },

  signUpEmail: async (input: { name: string; email: string; password: string }) => {
    await authPost("/sign-up/email", input);
  },

  requestPasswordReset: async (input: { email: string; redirectTo?: string }): Promise<void> => {
    await authPost("/request-password-reset", input);
  },

  resetPassword: async (input: { token: string; newPassword: string }): Promise<void> => {
    await authPost("/reset-password", input);
  },

  startSocialSignIn: async (input: { provider: string; callbackURL: string }) => {
    const payload = await authPost("/sign-in/social", {
      provider: input.provider,
      callbackURL: input.callbackURL,
      disableRedirect: true,
    });
    const url = isRecord(payload) ? payload.url : null;
    if (typeof url !== "string" || !url) throw new Error("Social sign-in did not return an authorization URL");
    return { url };
  },

  signOut: async () => {
    await authPost("/sign-out", {});
  },
};
