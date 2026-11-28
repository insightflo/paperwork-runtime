import { describe, expect, it, vi } from "vitest";
import * as missionCoreS9 from "../services/missions/mission-core-client-s9.js";
import { reviewPlanAgainstIntent } from "../services/missions/mission-plan-qa.js";
import type { PlanningArtifactTool } from "../services/missions/mission-plan-publication-contract.js";
import { publicationContract } from "./helpers/mission-publication-fixture.js";

const TOOLS: PlanningArtifactTool[] = [
  {
    name: "manual-onboarding-publish",
    enabled: true,
    adapterConfig: {
      artifactContract: {
        ...publicationContract("publication"),
        consumerParams: { html: "sourceHtmlPath", receipt: "qaResultPath" },
      },
    },
  },
  {
    name: "manual-onboarding-qa",
    enabled: true,
    adapterConfig: {
      artifactContract: publicationContract("qa"),
    },
  },
];

describe("mission-plan-qa Rust early-return Stage 40 receipt gate", () => {
  it("still enforces missing_publication_qa_receipt_tool when Rust 9D returns []", () => {
    const spy = vi.spyOn(missionCoreS9, "reviewPlanAgainstIntentViaRust").mockReturnValue([]);
    try {
      const diagnostics = reviewPlanAgainstIntent({
        intent: { publish: true, audienceSplit: false, scenario: false, signals: [] },
        selectedExecutionUnits: [
          { id: "action-5", kind: "action", toolNames: [] },
          { id: "qa-6", kind: "qa", toolNames: [], dependsOn: ["action-5"] },
          { id: "action-8", kind: "action", toolNames: ["manual-onboarding-publish"], dependsOn: ["qa-6"] },
        ],
        tools: TOOLS,
      });
      expect(diagnostics.map((d) => d.code)).toContain("missing_publication_qa_receipt_tool");
      expect(diagnostics.find((d) => d.code === "missing_publication_qa_receipt_tool")?.severity).toBe("invalid");
    } finally {
      spy.mockRestore();
    }
  });

  it("does not duplicate missing_publication_qa_receipt_tool if Rust already returned it", () => {
    const spy = vi.spyOn(missionCoreS9, "reviewPlanAgainstIntentViaRust").mockReturnValue([
      { code: "missing_publication_qa_receipt_tool", severity: "invalid", message: "from rust" },
    ]);
    try {
      const diagnostics = reviewPlanAgainstIntent({
        intent: { publish: true, audienceSplit: false, scenario: false, signals: [] },
        selectedExecutionUnits: [
          { id: "action-8", kind: "action", toolNames: ["manual-onboarding-publish"] },
        ],
        tools: TOOLS,
      });
      expect(diagnostics.filter((d) => d.code === "missing_publication_qa_receipt_tool")).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });
});
