/** @vitest-environment jsdom */
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { CompanyLanguageProvider } from "../lib/companyLanguage";
import { humanizeText } from "../components/wikiHumanize";

const PATTERN = {
  id: "card-1", companyId: "company-1", kind: "failure_mode",
  title: "Structural gate token mismatch stalls QA step",
  summary: "Double completion causes permanent gate token mismatch.",
  evidence: [], symptoms: "Run stays running while QA step stays pending",
  rootCause: "Double completion restamps completedAt", whatWorked: "Gate CAS requeue + reverify",
  scopeTags: ["workflow"], source: "auto_rework_draft", status: "active", audience: "ops",
  defectSignature: null, createdByAgentId: null, supersededById: null,
  createdAt: "2026-11-01T00:00:00.000Z",
};
const CANON = { ...PATTERN, id: "card-2", kind: "constraint", title: "Always requeue via gate CAS" };
const RETIRED = { ...PATTERN, id: "card-3", status: "retired", title: "Stale failure card" };
const ENTRY = {
  id: "e-1", companyId: "company-1", agentId: "a-1", missionId: null,
  pattern: "Issue stalled in blocked state", cause: "Upstream issue unresolved",
  solution: "Check parent issue before blocked transition", errorCode: null, stepId: null,
  frequency: 4, status: "active",
  createdAt: "2026-11-01T00:00:00.000Z", lastSeenAt: "2026-11-20T00:00:00.000Z",
  updatedAt: "2026-11-20T00:00:00.000Z",
};
const CLOSED_ENTRY = { ...ENTRY, id: "e-2", status: "resolved" };

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) =>
    queryKey[0] === "knowledge-patterns"
      ? { data: { patterns: [PATTERN, CANON, RETIRED] }, isLoading: false, isError: false, error: null }
      : {
          data: {
            entries: [ENTRY, CLOSED_ENTRY], timeseries: [],
            summary: { totalEntries: 2, activeEntries: 1, resolvedEntries: 1, totalHits: 8 },
          },
          isLoading: false, isError: false, error: null,
        },
}));
vi.mock("../context/CompanyContext", async (orig) => {
  const actual = await orig<typeof import("../context/CompanyContext")>();
  return { ...actual, useCompany: () => ({ selectedCompanyId: "company-1", selectedCompany: { defaultLanguage: "en" } }) };
});
vi.mock("../lib/router", () => ({ Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a> }));

import { AgentWiki } from "./AgentWiki";

describe("AgentWiki 3-tab Mistology UI (locale-aware)", () => {
  it("renders Korean labels when company language is ko", () => {
    const markup = renderToStaticMarkup(
      <CompanyLanguageProvider language="ko"><AgentWiki /></CompanyLanguageProvider>,
    );
    expect(markup).toContain("★ 표준 규약 (1)");
    expect(markup).toContain("최근 오답 · 30일 (2)");
    expect(markup).toContain("은퇴 · 해결 이력 (2)");
    expect(markup).toContain("무슨 문제였나");
    expect(markup).toContain("원인");
    expect(markup).toContain("해결·규칙");
    expect(markup).toContain("4회 관측");
    expect(markup).not.toContain("주입 허용");
    expect(markup).not.toContain("초안 승인");
  });

  it("renders English labels when company language is en", () => {
    const markup = renderToStaticMarkup(
      <CompanyLanguageProvider language="en"><AgentWiki /></CompanyLanguageProvider>,
    );
    expect(markup).toContain("★ Standard Rules (1)");
    expect(markup).toContain("Recent Mistakes · 30d (2)");
    expect(markup).toContain("Retired &amp; Resolved (2)");
    expect(markup).toContain("What happened");
    expect(markup).toContain("Root cause");
    expect(markup).toContain("Fix / Rule");
    expect(markup).toContain("Seen 4x");
    expect(markup).toContain("Auto-collected");
  });
});

describe("humanizeText", () => {
  it("strips raw UUIDs and run noise, collapses whitespace", () => {
    const out = humanizeText("Run 38fb7ef5-1111-2222-3333-444455556666 failed   (run abc123)", "en");
    expect(out).toBe("Run failed");
  });

  it("translates cryptic codes according to configured language", () => {
    expect(humanizeText("55P03", "ko")).toBe("DB 잠금 초과(55P03)");
    expect(humanizeText("55P03", "en")).toBe("DB lock timeout(55P03)");
    expect(humanizeText("x issue_status_blocked y", "en")).toBe("x Issue blocked(issue_status_blocked) y");
  });

  it("returns empty string for blank input", () => {
    expect(humanizeText(null, "en")).toBe("");
    expect(humanizeText("   ", "ko")).toBe("");
  });
});
