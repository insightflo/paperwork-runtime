/**
 * [purpose] Fail-closed workflow step output gate (RES-12860 fake-done fix).
 *   A workflow step issue whose run succeeded but registered zero work products used to
 *   auto-complete as done when the issue carried a deliverable contract (the
 *   "Deliverable output (use exactly this directory):" prompt block) or when a downstream
 *   step consumed `$steps.<stepId>...`. The gate must defer such auto-completions while
 *   preserving today's behavior for non-deliverable steps with zero products.
 */
import { describe, expect, it } from "vitest";
import {
  extractDeliverableOutputDir,
  shouldDeferWorkflowStepAutoComplete,
  stepHasDownstreamWorkProductConsumer,
} from "../services/workflow/step-output-completion-gate.js";
const deliverableIssueDescription = [
  "Analyze service into structured profile.",
  "Deliverable output (use exactly this directory):",
  "- /missions/m1/runs/2026-01-01/analyze-service-profile",
  "- Finish with `[ARTIFACT]: <absolute path>`.",
].join("\n");
const res12860DefinitionSnapshot = {
  steps: [
    { id: "analyze-service-profile", title: "Analyze", graphWorkProductRequired: true },
    {
      id: "prescreen-service-content",
      title: "Prescreen",
      input: { profile: "$steps.analyze-service-profile.workProduct" },
      dependsOn: ["analyze-service-profile"],
    },
  ],
};

describe("extractDeliverableOutputDir", () => {
  it("extracts the absolute directory from the standard deliverable block", () => {
    expect(extractDeliverableOutputDir(deliverableIssueDescription)).toBe(
      "/missions/m1/runs/2026-01-01/analyze-service-profile",
    );
  });

  it("trims surrounding whitespace on the directory line", () => {
    expect(extractDeliverableOutputDir("Deliverable output (use exactly this directory):\n-  /abs/out  ")).toBe(
      "/abs/out",
    );
  });

  it("ignores non-absolute directory lines", () => {
    expect(extractDeliverableOutputDir("Deliverable output (use exactly this directory):\n- ./out")).toBeNull();
    expect(extractDeliverableOutputDir("Deliverable output (use exactly this directory):\n- save.md")).toBeNull();
  });

  it("returns null when the block or input is missing", () => {
    expect(extractDeliverableOutputDir("no contract here")).toBeNull();
    expect(extractDeliverableOutputDir(null)).toBeNull();
    expect(extractDeliverableOutputDir(undefined)).toBeNull();
    expect(extractDeliverableOutputDir("")).toBeNull();
  });
});

describe("stepHasDownstreamWorkProductConsumer", () => {
  it("detects $steps.<stepId> references in another step's input", () => {
    expect(stepHasDownstreamWorkProductConsumer(res12860DefinitionSnapshot, "analyze-service-profile")).toBe(true);
  });

  it("detects references serialized in toolArgs, args, and dependsOn", () => {
    const snapshot = {
      steps: [
        { id: "producer" },
        { id: "a", toolArgs: { source: "$steps.producer.workProduct" } },
        { id: "b", args: ["$steps.producer.summary"] },
        { id: "c", dependsOn: ["$steps.producer"] },
      ],
    };
    expect(stepHasDownstreamWorkProductConsumer(snapshot, "producer")).toBe(true);
  });

  it("ignores unrelated steps without $steps references", () => {
    const snapshot = {
      steps: [
        { id: "producer" },
        { id: "consumer", input: { profile: "$steps.other-step.workProduct" }, dependsOn: ["other-step"] },
      ],
    };
    expect(stepHasDownstreamWorkProductConsumer(snapshot, "producer")).toBe(false);
  });

  it("treats a bare dependsOn id as a non-consumer (plain DAG preserved)", () => {
    const snapshot = { steps: [{ id: "producer" }, { id: "next", dependsOn: ["producer"] }] };
    expect(stepHasDownstreamWorkProductConsumer(snapshot, "producer")).toBe(false);
  });

  it("counts deliverable contract fields on the step itself", () => {
    for (const field of ["workProductContract", "expectedOutputs", "deliverable"]) {
      const snapshot = { steps: [{ id: "producer", [field]: { any: "value" } }] };
      expect(stepHasDownstreamWorkProductConsumer(snapshot, "producer")).toBe(true);
    }
  });

  it("returns false for malformed snapshots", () => {
    expect(stepHasDownstreamWorkProductConsumer(null, "producer")).toBe(false);
    expect(stepHasDownstreamWorkProductConsumer({ steps: "not-array" }, "producer")).toBe(false);
    expect(stepHasDownstreamWorkProductConsumer({ steps: [{ id: 1 }, "x"] }, "producer")).toBe(false);
  });
});

describe("shouldDeferWorkflowStepAutoComplete", () => {
  it("defers the RES-12860 scenario: zero products with a deliverable contract", () => {
    const verdict = shouldDeferWorkflowStepAutoComplete({
      hasAnyProduct: false,
      thisRunRegistered: false,
      issueDescription: deliverableIssueDescription,
      stepId: "analyze-service-profile",
      definitionSnapshot: res12860DefinitionSnapshot,
    });
    expect(verdict).toEqual({
      defer: true,
      reason: "missing_required_step_deliverable",
      expectedOutputDir: "/missions/m1/runs/2026-01-01/analyze-service-profile",
    });
  });

  it("defers on downstream $steps consumption even without the description block", () => {
    const verdict = shouldDeferWorkflowStepAutoComplete({
      hasAnyProduct: false,
      thisRunRegistered: false,
      issueDescription: "plain description without contract",
      stepId: "analyze-service-profile",
      definitionSnapshot: res12860DefinitionSnapshot,
    });
    expect(verdict.defer).toBe(true);
    expect(verdict.reason).toBe("missing_required_step_deliverable");
    expect(verdict.expectedOutputDir).toBeNull();
  });

  it("allows auto-complete for non-deliverable steps with zero products (existing behavior)", () => {
    const verdict = shouldDeferWorkflowStepAutoComplete({
      hasAnyProduct: false,
      thisRunRegistered: false,
      issueDescription: "read the source files and report findings",
      stepId: "collect-inputs",
      definitionSnapshot: { steps: [{ id: "collect-inputs" }, { id: "summarize", dependsOn: ["collect-inputs"] }] },
    });
    expect(verdict).toEqual({ defer: false, reason: null, expectedOutputDir: null });
  });

  it("preserves the follow-up defer when products exist but none registered this run", () => {
    const verdict = shouldDeferWorkflowStepAutoComplete({
      hasAnyProduct: true,
      thisRunRegistered: false,
      issueDescription: "anything",
      stepId: "analyze-service-profile",
      definitionSnapshot: res12860DefinitionSnapshot,
    });
    expect(verdict.defer).toBe(true);
    expect(verdict.reason).toBe("follow_up_without_new_evidence");
    expect(verdict.expectedOutputDir).toBeNull();
  });

  it("allows auto-complete when this run registered the product", () => {
    const verdict = shouldDeferWorkflowStepAutoComplete({
      hasAnyProduct: true,
      thisRunRegistered: true,
      issueDescription: deliverableIssueDescription,
      stepId: "analyze-service-profile",
      definitionSnapshot: res12860DefinitionSnapshot,
    });
    expect(verdict).toEqual({ defer: false, reason: null, expectedOutputDir: null });
  });

  it("handles absent step identity and snapshot defensively", () => {
    const verdict = shouldDeferWorkflowStepAutoComplete({
      hasAnyProduct: false,
      thisRunRegistered: false,
      issueDescription: "no contract",
      stepId: null,
      definitionSnapshot: null,
    });
    expect(verdict).toEqual({ defer: false, reason: null, expectedOutputDir: null });
  });
});
