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

export function loadSocialAuthProviders(environment: SocialAuthEnvironment = process.env): SocialAuthProvider[] {
  const providers: SocialAuthProvider[] = [];

  for (const definition of PROVIDER_DEFINITIONS) {
    const clientId = readProviderCredential(environment, definition.id, "CLIENT_ID");
    const clientSecret = readProviderCredential(environment, definition.id, "CLIENT_SECRET");
    if (!clientId || !clientSecret) continue;

    const tenantId =
      definition.id === "microsoft"
        ? (readProviderCredential(environment, definition.id, "TENANT_ID") ?? "common")
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
