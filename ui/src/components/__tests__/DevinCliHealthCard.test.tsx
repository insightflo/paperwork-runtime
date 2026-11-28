import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  DevinCliHealthCard,
  formatDevinHealthStatus,
  type DevinCliHealthView,
} from "../DevinCliHealthCard";

const readyHealth: DevinCliHealthView = {
  installed: true,
  version: "3000.15.14",
  supportsHeadlessPrompt: true,
  supportsWorkspaceTrustFlag: true,
  supportsInProcessModel: true,
  supportsSessionResume: true,
  readyForPaperwork: true,
  missingFlags: [],
};

describe("formatDevinHealthStatus", () => {
  it("returns 미설치 when Devin CLI is not installed", () => {
    expect(formatDevinHealthStatus({ ...readyHealth, installed: false, readyForPaperwork: false })).toBe("미설치");
  });

  it("returns 실행 준비 완료 when the CLI is ready for Paperwork", () => {
    expect(formatDevinHealthStatus(readyHealth)).toBe("실행 준비 완료");
  });

  it("returns the missing-flag count when required flags are unavailable", () => {
    const health = {
      ...readyHealth,
      supportsSessionResume: false,
      readyForPaperwork: false,
      missingFlags: ["--session-resume", "--workspace-trust"],
    };

    expect(formatDevinHealthStatus(health)).toBe("플래그 부족 (2)");
  });
});

describe("DevinCliHealthCard", () => {
  it("renders null when health is empty", () => {
    expect(renderToStaticMarkup(<DevinCliHealthCard health={null} />)).toBe("");
    expect(renderToStaticMarkup(<DevinCliHealthCard health={undefined} />)).toBe("");
  });

  it("displays the version and ready state", () => {
    const html = renderToStaticMarkup(<DevinCliHealthCard health={readyHealth} />);

    expect(html).toContain('data-testid="devin-cli-health-card"');
    expect(html).toContain('aria-label="Devin CLI 준비 상태"');
    expect(html).toContain("3000.15.14");
    expect(html).toContain("실행 준비 완료");
  });

  it("lists missing flags when the CLI is not ready", () => {
    const health = {
      ...readyHealth,
      supportsWorkspaceTrustFlag: false,
      supportsSessionResume: false,
      readyForPaperwork: false,
      missingFlags: ["--workspace-trust", "--session-resume"],
    };
    const html = renderToStaticMarkup(<DevinCliHealthCard health={health} />);

    expect(html).toContain("플래그 부족 (2)");
    expect(html).toContain("--workspace-trust");
    expect(html).toContain("--session-resume");
    expect(html).toContain("<code");
  });
});
