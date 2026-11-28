import { describe, expect, it } from "vitest";
import type { Request } from "express";
import { createPasswordResetSender } from "../auth/password-reset.js";
import type { SmtpMessage } from "../auth/smtp-mailer.js";
import { buildInviteOnboardingManifest } from "../routes/access-onboarding-manifest.js";
import { buildInviteOnboardingTextDocument } from "../routes/access-onboarding-text.js";
import { renderOrgChartSvg } from "../routes/org-chart-svg.js";

function buildReq(host: string): Request {
  return {
    protocol: "http",
    header(name: string) {
      if (name.toLowerCase() === "host") return host;
      return undefined;
    },
  } as unknown as Request;
}

function buildInvite() {
  return {
    id: "invite-branding",
    companyId: "company-branding",
    inviteType: "company_join",
    allowedJoinTypes: "agent",
    tokenHash: "hash",
    defaultsPayload: null,
    expiresAt: new Date("2026-03-05T00:00:00.000Z"),
    invitedByUserId: null,
    revokedAt: null,
    acceptedAt: null,
    createdAt: new Date("2026-03-04T00:00:00.000Z"),
    updatedAt: new Date("2026-03-04T00:00:00.000Z"),
  } as any;
}

const onboardingOpts = {
  deploymentMode: "authenticated" as const,
  deploymentExposure: "private" as const,
  bindHost: "0.0.0.0",
  allowedHostnames: ["paperwork.example.test"],
};

function expectNoLegacyBrandCopy(copy: string) {
  expect(copy).not.toMatch(/\bPaperclip\b/);
  expect(copy).not.toMatch(/\bpaperclip\b/);
  expect(copy).not.toMatch(/\bpapercompany\b/i);
}

describe("server user-facing Paperwork branding", () => {
  it("uses the Paperwork wordmark in rendered org charts", () => {
    const svg = renderOrgChartSvg([
      {
        id: "root",
        name: "Root",
        role: "CEO",
        status: "active",
        reports: [],
      },
    ]);

    expect(svg).toContain(">Paperwork</text>");
    expect(svg).not.toMatch(/>\s*(?:paperclip|papercompany)\s*<\/text>/i);
  });

  it("keeps invite manifest copy branded as Paperwork while preserving machine contracts", () => {
    const manifest = buildInviteOnboardingManifest(
      buildReq("paperwork.example.test"),
      "token-branding",
      buildInvite(),
      onboardingOpts,
    );

    const userFacingCopy = JSON.stringify({
      instructions: manifest.onboarding.instructions,
      requiredFields: manifest.onboarding.requiredFields,
      guidance: manifest.onboarding.connectivity.guidance,
      diagnostics: manifest.onboarding.connectivity.diagnostics,
    });

    expect(userFacingCopy).toContain("Paperwork");
    expectNoLegacyBrandCopy(userFacingCopy);
    expect(manifest.onboarding.requiredFields.agentDefaultsPayload).toContain("paperclipApiUrl");
    expect(manifest.onboarding.skill).toMatchObject({
      name: "paperclip",
      path: "/api/skills/paperclip",
    });
    expect(manifest.onboarding.connectivity.guidance).toContain("pnpm paperclipai allowed-hostname");
  });

  it("keeps plain-text onboarding branded as Paperwork while preserving machine contracts", () => {
    const text = buildInviteOnboardingTextDocument(
      buildReq("paperwork.example.test"),
      "token-branding",
      buildInvite(),
      onboardingOpts,
    );
    const copyWithoutMachineEndpoints = text
      .replace(/\/api\/skills\/paperclip(?:-create-agent|-create-plugin)?/g, "")
      .replace(/~\/\.paperwork\/skills\/paperclip\/SKILL\.md/g, "");

    expect(text).toContain("# Paperwork Agent Onboarding");
    expectNoLegacyBrandCopy(copyWithoutMachineEndpoints);
    expect(text).toContain("PAPERCLIP_API_KEY");
    expect(text).toContain("paperclipApiUrl");
    expect(text).toContain("pnpm paperclipai allowed-hostname");
  });

  it("uses Paperwork in password-reset email copy", async () => {
    const sent: SmtpMessage[] = [];
    const sendResetPassword = createPasswordResetSender({
      smtpConfig: {
        host: "smtp.example.test",
        port: 587,
        from: "reset@example.test",
      },
      smtpSend: async (_config, message) => {
        sent.push(message);
      },
      webhookUrl: null,
      fetchImpl: async () => new Response(null, { status: 200 }),
      logger: { warn: () => {} },
    });

    await sendResetPassword({
      user: { email: "user@example.test" },
      url: "https://paperwork.example.test/reset/raw-token",
      token: "raw-token",
    });

    expect(sent).toHaveLength(1);
    const copy = `${sent[0]?.subject ?? ""}\n${sent[0]?.text ?? ""}`;
    expect(copy).toContain("Paperwork");
    expectNoLegacyBrandCopy(copy);
  });
});
