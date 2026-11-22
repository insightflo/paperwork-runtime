import { describe, expect, it } from "vitest";
import {
  canonSignatureFor,
  clusterEscapedDefects,
  clusterPlanQaDiagnostics,
  extractDiagnosticCode,
  extractDiagnosticSummary,
  shouldAutoGraduateToWiki,
} from "../services/quality-rsi.js";

describe("quality-rsi pure engine", () => {
  it("normalizes diagnostic codes including template UUIDs and fallbacks", () => {
    expect(extractDiagnosticCode({ code: "action_contract_gap" })).toBe("action_contract_gap");
    expect(extractDiagnosticCode({ class: "Dependency-Gap!" })).toBe("dependency_gap");
    expect(extractDiagnosticCode({ check: "template:600b6e90-5672-48e3-b642-548589cb3aa5:item:1" }))
      .toBe("template_contract_gap");
    expect(extractDiagnosticCode({})).toBe("general_qa_gap");
  });

  it("extracts readable detail across heterogeneous Plan QA diagnostic shapes", () => {
    expect(extractDiagnosticSummary({ message: "Missing URL" })).toBe("Missing URL");
    expect(extractDiagnosticSummary({ problem: "Wrong assignee" })).toBe("Wrong assignee");
    expect(extractDiagnosticSummary({ finding: "Missing role" })).toBe("Missing role");
    expect(extractDiagnosticSummary({ brokenConnection: "gate.pass[1]" })).toBe("gate.pass[1]");
    expect(extractDiagnosticSummary({})).toBe("");
  });

  it("clusters recurring request_changes diagnostics and ignores pass verdicts", () => {
    const now = new Date("2026-11-22T10:00:00Z").getTime();
    const recent = new Date("2026-11-15T10:00:00Z");
    const old = new Date("2026-08-20T10:00:00Z");
    const clusters = clusterPlanQaDiagnostics(
      [
        {
          missionTitle: "M1",
          verdict: "request_changes",
          diagnostics: [{ code: "action_contract_gap", message: "Missing toolArgs.url" }],
          createdAt: recent,
        },
        {
          missionTitle: "M2",
          verdict: "request_changes",
          diagnostics: [
            { code: "action_contract_gap", message: "Empty toolArgs" },
            { code: "action_contract_gap", message: "Duplicate in same verdict" },
          ],
          createdAt: old,
        },
        {
          missionTitle: "M3",
          verdict: "pass",
          diagnostics: [{ code: "action_contract_gap", message: "Ignored pass" }],
          createdAt: recent,
        },
        {
          missionTitle: "M4",
          verdict: "request_changes",
          diagnostics: [{ class: "dependency_gap", message: "Missing proof" }],
          createdAt: recent,
        },
      ],
      now,
    );

    expect(clusters).toHaveLength(2);
    expect(clusters[0]).toMatchObject({
      axis: "worker",
      code: "action_contract_gap",
      signature: "quality-rsi:action_contract_gap",
      canonSignature: "quality-rsi-canon:action_contract_gap",
      count: 2,
      recentCount30d: 1,
      summary: "Missing toolArgs.url",
    });
    expect(shouldAutoGraduateToWiki(clusters[0].count)).toBe(true);
    expect(shouldAutoGraduateToWiki(clusters[1].count)).toBe(false);
  });

  it("clusters QA Self-RSI escaped defects (Plan QA pass -> post-pass failure/cancel)", () => {
    const now = new Date("2026-11-22T10:00:00Z").getTime();
    const clusters = clusterEscapedDefects(
      [
        {
          source: "final_qa_failure",
          missionTitle: "M10",
          detail: "plan_goal_mismatch",
          createdAt: new Date("2026-11-10T00:00:00Z"),
        },
        {
          source: "final_qa_failure",
          missionTitle: "M11",
          detail: "broken_html",
          createdAt: new Date("2026-11-18T00:00:00Z"),
        },
        {
          source: "post_pass_cancelled",
          missionTitle: "M12",
          detail: "Cancelled after Plan QA pass",
          createdAt: new Date("2026-09-01T00:00:00Z"),
        },
      ],
      now,
    );

    expect(clusters).toHaveLength(2);
    expect(clusters[0]).toMatchObject({
      axis: "qa_self",
      code: "qa_escaped_final_qa_failure",
      signature: "quality-rsi:qa_escaped_final_qa_failure",
      canonSignature: "quality-rsi-canon:qa_escaped_final_qa_failure",
      count: 2,
      recentCount30d: 2,
    });
    expect(shouldAutoGraduateToWiki(clusters[0].count)).toBe(true);
    expect(canonSignatureFor("quality-rsi:dependency_gap")).toBe("quality-rsi-canon:dependency_gap");
  });
});
