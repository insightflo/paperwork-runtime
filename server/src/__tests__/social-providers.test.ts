import { describe, expect, it } from "vitest";
import {
  SOCIAL_AUTH_PROVIDER_IDS,
  buildBetterAuthSocialProviders,
  loadSocialAuthProviders,
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
