export const SOCIAL_AUTH_PROVIDER_IDS = ["google", "github", "microsoft", "kakao", "naver"] as const;

export type SocialAuthProviderId = (typeof SOCIAL_AUTH_PROVIDER_IDS)[number];

export type SocialAuthProvider = {
  id: SocialAuthProviderId;
  label: string;
  clientId: string;
  clientSecret: string;
  tenantId?: string;
};

export type PublicSocialAuthProvider = Pick<SocialAuthProvider, "id" | "label">;

export type GenericOidcProviderConfig = {
  providerId: string;
  label: string;
  clientId: string;
  clientSecret: string;
  discoveryUrl: string;
};

export type PublicOidcProvider = Pick<GenericOidcProviderConfig, "label"> & {
  id: string;
};

export type BetterAuthSocialProviders = Partial<Record<
  SocialAuthProviderId,
  {
    clientId: string;
    clientSecret: string;
    disableSignUp: boolean;
    tenantId?: string;
  }
>>;

type SocialAuthEnvironment = Readonly<Record<string, string | undefined>>;

const PROVIDER_DEFINITIONS: ReadonlyArray<{
  id: SocialAuthProviderId;
  label: string;
}> = [
  { id: "google", label: "Google" },
  { id: "github", label: "GitHub" },
  { id: "microsoft", label: "Microsoft Entra ID" },
  { id: "kakao", label: "Kakao" },
  { id: "naver", label: "Naver" },
];

function readCredential(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized || null;
}

function readProviderCredential(
  environment: SocialAuthEnvironment,
  providerId: SocialAuthProviderId,
  credential: "CLIENT_ID" | "CLIENT_SECRET" | "TENANT_ID",
): string | null {
  const providerKey = providerId.toUpperCase();
  return (
    readCredential(environment[`PAPERWORK_AUTH_${providerKey}_${credential}`]) ??
    readCredential(environment[`PAPERCLIP_AUTH_${providerKey}_${credential}`])
  );
}

const MICROSOFT_TENANT_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

function sanitizeMicrosoftTenantId(tenantId: string | null): string {
  return tenantId && MICROSOFT_TENANT_ID_PATTERN.test(tenantId) ? tenantId : "common";
}

type OidcEnvironmentKey = "CLIENT_ID" | "CLIENT_SECRET" | "DISCOVERY_URL" | "ISSUER" | "PROVIDER_ID" | "LABEL";

function readOidcCredential(environment: SocialAuthEnvironment, key: OidcEnvironmentKey): string | null {
  return (
    readCredential(environment[`PAPERWORK_AUTH_OIDC_${key}`]) ??
    readCredential(environment[`PAPERCLIP_AUTH_OIDC_${key}`])
  );
}

function isValidOidcEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  } catch {
    return false;
  }
}

export function resolveGenericOidcProviderConfig(
  environment: SocialAuthEnvironment = process.env,
): GenericOidcProviderConfig | null {
  const clientId = readOidcCredential(environment, "CLIENT_ID");
  const clientSecret = readOidcCredential(environment, "CLIENT_SECRET");
  if (!clientId || !clientSecret) return null;

  const discoveryUrlValue = readOidcCredential(environment, "DISCOVERY_URL");
  const endpoint = discoveryUrlValue ?? readOidcCredential(environment, "ISSUER");
  if (!endpoint || !isValidOidcEndpoint(endpoint)) return null;

  const discoveryUrl = discoveryUrlValue ?? `${endpoint.replace(/\/+$/, "")}/.well-known/openid-configuration`;

  return {
    providerId: readOidcCredential(environment, "PROVIDER_ID") ?? "oidc",
    label: readOidcCredential(environment, "LABEL") ?? "SSO (OIDC)",
    clientId,
    clientSecret,
    discoveryUrl,
  };
}

export function toPublicOidcProvider(config: GenericOidcProviderConfig): PublicOidcProvider {
  return { id: config.providerId, label: config.label };
}

export function loadSocialAuthProviders(environment: SocialAuthEnvironment = process.env): SocialAuthProvider[] {
  const providers: SocialAuthProvider[] = [];

  for (const definition of PROVIDER_DEFINITIONS) {
    const clientId = readProviderCredential(environment, definition.id, "CLIENT_ID");
    const clientSecret = readProviderCredential(environment, definition.id, "CLIENT_SECRET");
    if (!clientId || !clientSecret) continue;

    const tenantId =
      definition.id === "microsoft"
        ? sanitizeMicrosoftTenantId(readProviderCredential(environment, definition.id, "TENANT_ID"))
        : undefined;

    providers.push({
      id: definition.id,
      label: definition.label,
      clientId,
      clientSecret,
      ...(tenantId ? { tenantId } : {}),
    });
  }

  return providers;
}

export function toPublicSocialAuthProviders(
  providers: readonly SocialAuthProvider[],
): PublicSocialAuthProvider[] {
  return providers.map(({ id, label }) => ({ id, label }));
}

export function buildBetterAuthSocialProviders(
  providers: readonly SocialAuthProvider[],
  disableSignUp: boolean,
): BetterAuthSocialProviders {
  const configured: BetterAuthSocialProviders = {};

  for (const provider of providers) {
    configured[provider.id] = {
      clientId: provider.clientId,
      clientSecret: provider.clientSecret,
      disableSignUp,
      ...(provider.tenantId ? { tenantId: provider.tenantId } : {}),
    };
  }

  return configured;
}
