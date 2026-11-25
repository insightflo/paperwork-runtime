import { describe, expect, it } from "vitest";
import {
  SOCIAL_AUTH_PROVIDER_IDS,
  buildBetterAuthSocialProviders,
  loadSocialAuthProviders,
  resolveGenericOidcProviderConfig,
  toPublicOidcProvider,
  toPublicSocialAuthProviders,
} from "../auth/social-providers.js";

describe("social auth provider environment loading", () => {
  it("declares Google, GitHub, Microsoft, Kakao, and Naver in priority order", () => {
    expect(SOCIAL_AUTH_PROVIDER_IDS).toEqual(["google", "github", "microsoft", "kakao", "naver"]);
  });

  it("loads Google, GitHub, and Microsoft Entra ID from PAPERWORK_AUTH credentials", () => {
    const providers = loadSocialAuthProviders({
      PAPERWORK_AUTH_GOOGLE_CLIENT_ID: " google-work-id ",
      PAPERWORK_AUTH_GOOGLE_CLIENT_SECRET: " google-work-secret ",
      PAPERWORK_AUTH_GITHUB_CLIENT_ID: "github-work-id",
      PAPERWORK_AUTH_GITHUB_CLIENT_SECRET: "github-work-secret",
      PAPERWORK_AUTH_MICROSOFT_CLIENT_ID: "microsoft-work-id",
      PAPERWORK_AUTH_MICROSOFT_CLIENT_SECRET: "microsoft-work-secret",
      PAPERWORK_AUTH_MICROSOFT_TENANT_ID: "work-tenant",
    });

    expect(providers).toEqual([
      {
        id: "google",
        label: "Google",
        clientId: "google-work-id",
        clientSecret: "google-work-secret",
      },
      {
        id: "github",
        label: "GitHub",
        clientId: "github-work-id",
        clientSecret: "github-work-secret",
      },
      {
        id: "microsoft",
        label: "Microsoft Entra ID",
        clientId: "microsoft-work-id",
        clientSecret: "microsoft-work-secret",
        tenantId: "work-tenant",
      },
    ]);
  });

  it("defaults the Microsoft tenant to common when no tenant override is configured", () => {
    const providers = loadSocialAuthProviders({
      PAPERWORK_AUTH_MICROSOFT_CLIENT_ID: "microsoft-work-id",
      PAPERWORK_AUTH_MICROSOFT_CLIENT_SECRET: "microsoft-work-secret",
    });

    expect(providers).toEqual([
      expect.objectContaining({ id: "microsoft", tenantId: "common" }),
    ]);
  });

  it("falls back to PAPERCLIP_AUTH credentials and prefers PAPERWORK_AUTH when both exist", () => {
    const providers = loadSocialAuthProviders({
      PAPERCLIP_AUTH_GITHUB_CLIENT_ID: "github-legacy-id",
      PAPERCLIP_AUTH_GITHUB_CLIENT_SECRET: "github-legacy-secret",
      PAPERWORK_AUTH_GITHUB_CLIENT_ID: "github-work-id",
      PAPERCLIP_AUTH_MICROSOFT_CLIENT_ID: "microsoft-legacy-id",
      PAPERCLIP_AUTH_MICROSOFT_CLIENT_SECRET: "microsoft-legacy-secret",
      PAPERCLIP_AUTH_MICROSOFT_TENANT_ID: "legacy-tenant",
      PAPERCLIP_AUTH_KAKAO_CLIENT_ID: "kakao-legacy-id",
      PAPERCLIP_AUTH_KAKAO_CLIENT_SECRET: "kakao-legacy-secret",
    });

    expect(providers).toEqual([
      {
        id: "github",
        label: "GitHub",
        clientId: "github-work-id",
        clientSecret: "github-legacy-secret",
      },
      {
        id: "microsoft",
        label: "Microsoft Entra ID",
        clientId: "microsoft-legacy-id",
        clientSecret: "microsoft-legacy-secret",
        tenantId: "legacy-tenant",
      },
      {
        id: "kakao",
        label: "Kakao",
        clientId: "kakao-legacy-id",
        clientSecret: "kakao-legacy-secret",
      },
    ]);
  });

  it("skips partial or blank credentials fail-closed", () => {
    const providers = loadSocialAuthProviders({
      PAPERWORK_AUTH_GOOGLE_CLIENT_ID: "google-work-id",
      PAPERWORK_AUTH_GOOGLE_CLIENT_SECRET: "google-work-secret",
      PAPERWORK_AUTH_GITHUB_CLIENT_ID: "github-work-id",
      PAPERWORK_AUTH_MICROSOFT_CLIENT_ID: "   ",
      PAPERWORK_AUTH_MICROSOFT_CLIENT_SECRET: "microsoft-work-secret",
      PAPERWORK_AUTH_NAVER_CLIENT_SECRET: "naver-work-secret",
    });

    expect(providers.map((provider) => provider.id)).toEqual(["google"]);
  });
});

describe("social auth provider projection", () => {
  it("never exposes client secrets or tenant configuration in public providers", () => {
    const publicProviders = toPublicSocialAuthProviders([
      {
        id: "microsoft",
        label: "Microsoft Entra ID",
        clientId: "microsoft-id",
        clientSecret: "microsoft-secret",
        tenantId: "tenant-id",
      },
    ]);

    expect(publicProviders).toEqual([{ id: "microsoft", label: "Microsoft Entra ID" }]);
    expect(JSON.stringify(publicProviders)).not.toContain("microsoft-secret");
    expect(JSON.stringify(publicProviders)).not.toContain("tenant-id");
  });

  it("propagates disableSignUp and Microsoft tenantId to Better Auth", () => {
    const configured = buildBetterAuthSocialProviders(
      [
        {
          id: "github",
          label: "GitHub",
          clientId: "github-id",
          clientSecret: "github-secret",
        },
        {
          id: "microsoft",
          label: "Microsoft Entra ID",
          clientId: "microsoft-id",
          clientSecret: "microsoft-secret",
          tenantId: "contoso-tenant",
        },
      ],
      true,
    );

    expect(configured).toEqual({
      github: {
        clientId: "github-id",
        clientSecret: "github-secret",
        disableSignUp: true,
      },
      microsoft: {
        clientId: "microsoft-id",
        clientSecret: "microsoft-secret",
        disableSignUp: true,
        tenantId: "contoso-tenant",
      },
    });
  });
});

describe("generic OIDC provider resolution", () => {
  function oidcEnvironment(overrides: Record<string, string> = {}): Record<string, string> {
    return {
      PAPERWORK_AUTH_OIDC_CLIENT_ID: "oidc-client-id",
      PAPERWORK_AUTH_OIDC_CLIENT_SECRET: "oidc-client-secret",
      ...overrides,
    };
  }

  it("resolves a complete config from PAPERWORK_AUTH_OIDC values", () => {
    const config = resolveGenericOidcProviderConfig(oidcEnvironment({
      PAPERWORK_AUTH_OIDC_DISCOVERY_URL: "https://idp.example.com/.well-known/openid-configuration",
      PAPERWORK_AUTH_OIDC_PROVIDER_ID: "acme-sso",
      PAPERWORK_AUTH_OIDC_LABEL: "Acme SSO",
    }));

    expect(config).toEqual({
      providerId: "acme-sso",
      label: "Acme SSO",
      clientId: "oidc-client-id",
      clientSecret: "oidc-client-secret",
      discoveryUrl: "https://idp.example.com/.well-known/openid-configuration",
    });
  });

  it("derives the discovery URL from the issuer and applies default id and label", () => {
    const config = resolveGenericOidcProviderConfig(oidcEnvironment({
      PAPERWORK_AUTH_OIDC_ISSUER: "https://idp.example.com/realms/acme/",
    }));

    expect(config).toMatchObject({
      providerId: "oidc",
      label: "SSO (OIDC)",
      discoveryUrl: "https://idp.example.com/realms/acme/.well-known/openid-configuration",
    });
  });

  it("falls back to PAPERCLIP_AUTH_OIDC values and prefers PAPERWORK per credential", () => {
    const legacyOnly = resolveGenericOidcProviderConfig({
      PAPERCLIP_AUTH_OIDC_CLIENT_ID: "legacy-client-id",
      PAPERCLIP_AUTH_OIDC_CLIENT_SECRET: "legacy-client-secret",
      PAPERCLIP_AUTH_OIDC_ISSUER: "https://legacy-idp.example.com",
    });
    expect(legacyOnly).toMatchObject({
      providerId: "oidc",
      clientId: "legacy-client-id",
      discoveryUrl: "https://legacy-idp.example.com/.well-known/openid-configuration",
    });

    const mixed = resolveGenericOidcProviderConfig({
      PAPERCLIP_AUTH_OIDC_CLIENT_ID: "legacy-client-id",
      PAPERWORK_AUTH_OIDC_CLIENT_ID: "work-client-id",
      PAPERCLIP_AUTH_OIDC_CLIENT_SECRET: "legacy-client-secret",
      PAPERCLIP_AUTH_OIDC_ISSUER: "https://legacy-idp.example.com",
      PAPERWORK_AUTH_OIDC_LABEL: "Work SSO",
    });
    expect(mixed).toMatchObject({ clientId: "work-client-id", clientSecret: "legacy-client-secret", label: "Work SSO" });
  });

  it("returns null when credentials or endpoint configuration are missing", () => {
    const incompleteEnvironments = [
      {},
      oidcEnvironment({ PAPERWORK_AUTH_OIDC_CLIENT_SECRET: "", PAPERWORK_AUTH_OIDC_DISCOVERY_URL: "https://idp.example.com/x" }),
      oidcEnvironment(),
    ];

    for (const environment of incompleteEnvironments) {
      expect(resolveGenericOidcProviderConfig(environment)).toBeNull();
    }
  });

  it("rejects non-https endpoints outside loopback development hosts", () => {
    const invalidEnvironments = [
      oidcEnvironment({ PAPERWORK_AUTH_OIDC_DISCOVERY_URL: "http://idp.example.com/.well-known/openid-configuration" }),
      oidcEnvironment({ PAPERWORK_AUTH_OIDC_ISSUER: "not a url" }),
      oidcEnvironment({ PAPERWORK_AUTH_OIDC_ISSUER: "ftp://idp.example.com" }),
    ];

    for (const environment of invalidEnvironments) {
      expect(resolveGenericOidcProviderConfig(environment)).toBeNull();
    }
  });

  it("accepts loopback http endpoints for local development", () => {
    for (const issuer of ["http://localhost:8080/realms/dev", "http://127.0.0.1:8080"]) {
      const config = resolveGenericOidcProviderConfig(oidcEnvironment({ PAPERWORK_AUTH_OIDC_ISSUER: issuer }));
      expect(config!.discoveryUrl).toBe(`${issuer}/.well-known/openid-configuration`);
    }
  });

  it("projects only the public id and label without leaking secrets", () => {
    const config = resolveGenericOidcProviderConfig(oidcEnvironment({
      PAPERWORK_AUTH_OIDC_DISCOVERY_URL: "https://idp.example.com/.well-known/openid-configuration",
      PAPERWORK_AUTH_OIDC_PROVIDER_ID: "acme-sso",
      PAPERWORK_AUTH_OIDC_LABEL: "Acme SSO",
    }));

    const publicProvider = toPublicOidcProvider(config!);
    expect(publicProvider).toEqual({ id: "acme-sso", label: "Acme SSO" });
    const serialized = JSON.stringify(publicProvider);
    expect(serialized).not.toContain("oidc-client-secret");
    expect(serialized).not.toContain("oidc-client-id");
    expect(serialized).not.toContain("discoveryUrl");
  });
});

describe("microsoft tenant id hardening", () => {
  function loadMicrosoft(tenantId: string) {
    return loadSocialAuthProviders({
      PAPERWORK_AUTH_MICROSOFT_CLIENT_ID: "id",
      PAPERWORK_AUTH_MICROSOFT_CLIENT_SECRET: "secret",
      PAPERWORK_AUTH_MICROSOFT_TENANT_ID: tenantId,
    });
  }

  it("accepts tenant ids with letters, digits, dots, dashes, and underscores", () => {
    expect(loadMicrosoft("contoso-tenant_1.onmicrosoft.com")[0]).toMatchObject({
      tenantId: "contoso-tenant_1.onmicrosoft.com",
    });
  });

  it("falls back to common when the tenant id contains unsafe characters", () => {
    for (const tenantId of ["tenant/injection", "tenant with spaces", "tenant?query=1", "tenant%00null", "tenant@evil"]) {
      expect(loadMicrosoft(tenantId)[0]).toMatchObject({ id: "microsoft", tenantId: "common" });
    }
  });
});
