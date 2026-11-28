import { describe, expect, it } from "vitest";
import { reviewQaToolInputContract, type PlanningArtifactTool } from "../services/missions/mission-plan-publication-contract.js";
import { reviewPlanAgainstIntent } from "../services/missions/mission-plan-qa.js";
import { extractMissionIntent } from "../services/missions/mission-intent.js";

const manualOnboardingQaTool: PlanningArtifactTool = {
  name: "manual-onboarding-qa",
  adapterConfig: {
    artifactContract: {
      role: "qa",
      inputParams: {
        out: "out",
        html: "html",
        content: "content",
        manifest: "htmlManifest",
        assetsDir: "assetsDir",
      },
      defaultRules: { rules: {} },
      resultAdapter: "generic",
      assetDiscovery: ["/blocks/*/assetFile"],
      bundleManifest: {
        fileName: "html-input.json",
        schemaVersion: "manual-onboarding.html-input.v1",
        ancillaryRoles: ["repoMeta", "shotResult", "empiricalResult"],
      },
      resultFileName: "qa-result.json",
      deploymentFiles: ["manual-onboarding-qa.mjs"],
      resultSchemaVersion: "workflow.qa-result.v1",
      inputEnvelopeVersion: "workflow.artifact-input.v1",
    },
  },
};

describe("reviewQaToolInputContract (PLAN-QA html/content input guard)", () => {
  it("rejects html + assetsDir without declared htmlManifest (prevents qa_artifact_html_asset_contract_unavailable)", () => {
    const diagnostics = reviewQaToolInputContract(
      [
        {
          id: "qa-8-machine-gate",
          toolName: "manual-onboarding-qa",
          toolArgs: {
            html: "{$steps.build-html.workProductPath}",
            assetsDir: "/tmp/assets",
          },
        },
      ],
      [manualOnboardingQaTool],
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      code: "invalid_qa_tool_input_contract",
      severity: "invalid",
    });
  });

  it("accepts html + declared htmlManifest", () => {
    const diagnostics = reviewQaToolInputContract(
      [
        {
          id: "qa-8-machine-gate",
          toolName: "manual-onboarding-qa",
          toolArgs: {
            html: "{$steps.build-html.workProductPath}",
            htmlManifest: "/tmp/html-input.json",
          },
        },
      ],
      [manualOnboardingQaTool],
    );
    expect(diagnostics).toEqual([]);
  });

  it("accepts content + assetsDir", () => {
    const diagnostics = reviewQaToolInputContract(
      [
        {
          id: "qa-8-machine-gate",
          toolName: "manual-onboarding-qa",
          toolArgs: {
            content: "{$steps.draft-content.workProductPath}",
            assetsDir: "/tmp/assets",
          },
        },
      ],
      [manualOnboardingQaTool],
    );
    expect(diagnostics).toEqual([]);
  });

  it("rejects content without required assetsDir", () => {
    const diagnostics = reviewQaToolInputContract(
      [
        {
          id: "qa-8-machine-gate",
          toolName: "manual-onboarding-qa",
          toolArgs: {
            content: "{$steps.draft-content.workProductPath}",
          },
        },
      ],
      [manualOnboardingQaTool],
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe("invalid_qa_tool_input_contract");
  });

  it("rejects passing both content and html simultaneously", () => {
    const diagnostics = reviewQaToolInputContract(
      [
        {
          id: "qa-8-machine-gate",
          toolName: "manual-onboarding-qa",
          toolArgs: {
            content: "{$steps.draft-content.workProductPath}",
            html: "{$steps.build-html.workProductPath}",
            assetsDir: "/tmp/assets",
          },
        },
      ],
      [manualOnboardingQaTool],
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe("invalid_qa_tool_input_contract");
  });

  it("surfaces invalid_qa_tool_input_contract through reviewPlanAgainstIntent", () => {
    const diagnostics = reviewPlanAgainstIntent({
      intent: extractMissionIntent("Create tech-scout guide"),
      selectedExecutionUnits: [
        {
          id: "qa-8-machine-gate",
          toolName: "manual-onboarding-qa",
          toolArgs: {
            html: "{$steps.build-html.workProductPath}",
            assetsDir: "/tmp/assets",
          },
        },
      ],
      tools: [manualOnboardingQaTool],
    });
    expect(diagnostics.map((d) => d.code)).toContain("invalid_qa_tool_input_contract");
  });
});
