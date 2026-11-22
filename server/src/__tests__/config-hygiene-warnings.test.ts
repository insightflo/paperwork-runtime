import { describe, expect, it } from "vitest";
import {
  MAX_RECOMMENDED_SERIAL_LLM_DEPTH,
  collectAgentConfigHygieneWarnings,
  collectWorkflowAuthoringWarnings,
} from "../services/config-hygiene-warnings.js";

function llmStep(id: string, dependencies: string[] = []) {
  return { id, name: id, agentId: "agent-1", dependencies };
}

function serialChain(n: number) {
  return Array.from({ length: n }, (_, i) => llmStep(`s${i + 1}`, i > 0 ? [`s${i}`] : []));
}

describe("collectWorkflowAuthoringWarnings", () => {
  it("returns [] for chains at or below the recommended depth", () => {
    expect(collectWorkflowAuthoringWarnings(serialChain(MAX_RECOMMENDED_SERIAL_LLM_DEPTH))).toEqual([]);
  });

  it("returns [] for empty or non-step input", () => {
    expect(collectWorkflowAuthoringWarnings([])).toEqual([]);
    expect(collectWorkflowAuthoringWarnings([null, "x", 5])).toEqual([]);
  });

  it("warns when serial LLM depth exceeds the recommendation", () => {
    const warnings = collectWorkflowAuthoringWarnings(serialChain(7));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      code: "workflow_serial_llm_depth_high",
      severity: "warn",
    });
    expect(warnings[0]!.message).toContain("7");
    expect(warnings[0]!.message).toContain(String(MAX_RECOMMENDED_SERIAL_LLM_DEPTH));
  });

  it("excludes toolName and if/complete steps from LLM depth", () => {
    const steps = [
      llmStep("s1"),
      { id: "t1", name: "t1", toolName: "http-request", dependencies: ["s1"] },
      { id: "if1", name: "if1", type: "if", dependencies: ["t1"] },
      llmStep("s2", ["if1"]),
      llmStep("s3", ["s2"]),
      { id: "done", name: "done", type: "complete", dependencies: ["s3"] },
    ];
    // LLM depth is 3 (s1 -> s2 -> s3); tool/if/complete add hops but no LLM depth.
    expect(collectWorkflowAuthoringWarnings(steps)).toEqual([]);
  });

  it("still counts LLM steps across interleaved non-LLM steps", () => {
    const steps = [
      llmStep("s1"),
      llmStep("s2", ["s1"]),
      llmStep("s3", ["s2"]),
      { id: "t1", name: "t1", toolName: "scrape", dependencies: ["s3"] },
      llmStep("s4", ["t1"]),
      llmStep("s5", ["s4"]),
      llmStep("s6", ["s5"]),
    ];
    // 6 LLM hops in one serial path — tool hop between them does not parallelize.
    const warnings = collectWorkflowAuthoringWarnings(steps);
    expect(warnings.map((w) => w.code)).toEqual(["workflow_serial_llm_depth_high"]);
  });

  it("terminates on cycles and conditionalDependencies back-edges", () => {
    const steps = [
      llmStep("a", ["b"]),
      llmStep("b", ["a"]),
      { id: "c", name: "c", agentId: "agent-1", dependencies: [], conditionalDependencies: [{ stepId: "b", when: "qa_request_changes", isBackEdge: true, maxIterations: 3 }] },
      { id: "d", name: "d", agentId: "agent-1", dependencies: ["c"], conditionalDependencies: [{ stepId: "d", when: "always", isBackEdge: true, maxIterations: 2 }] },
    ];
    const warnings = collectWorkflowAuthoringWarnings(steps);
    expect(Array.isArray(warnings)).toBe(true);
    expect(warnings.length).toBeLessThanOrEqual(1);
  });

  it("uses dependsOn edges too", () => {
    const steps = [
      { id: "s1", name: "s1", agentId: "a" },
      { id: "s2", name: "s2", agentId: "a", dependsOn: ["s1"] },
      { id: "s3", name: "s3", agentId: "a", dependsOn: ["s2"] },
      { id: "s4", name: "s4", agentId: "a", dependsOn: ["s3"] },
      { id: "s5", name: "s5", agentId: "a", dependsOn: ["s4"] },
      { id: "s6", name: "s6", agentId: "a", dependsOn: ["s5"] },
    ];
    expect(collectWorkflowAuthoringWarnings(steps).map((w) => w.code)).toEqual([
      "workflow_serial_llm_depth_high",
    ]);
  });
});

describe("collectAgentConfigHygieneWarnings", () => {
  it("warns on thinking 'max' for researcher and pm roles", () => {
    for (const role of ["researcher", "pm"]) {
      const warnings = collectAgentConfigHygieneWarnings({
        role,
        adapterType: "claude_local",
        adapterConfig: { thinking: "max" },
      });
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatchObject({ code: "agent_excessive_thinking", severity: "warn" });
      expect(warnings[0]!.message).toContain("low");
    }
  });

  it("warns on effort 'max' for non-ceo/qa roles", () => {
    const warnings = collectAgentConfigHygieneWarnings({
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: { effort: "max" },
    });
    expect(warnings.map((w) => w.code)).toEqual(["agent_excessive_thinking"]);
  });

  it("returns [] for thinking 'low'", () => {
    expect(
      collectAgentConfigHygieneWarnings({
        role: "researcher",
        adapterType: "claude_local",
        adapterConfig: { thinking: "low" },
      }),
    ).toEqual([]);
  });

  it("returns [] for thinking 'medium' on ceo and qa roles", () => {
    for (const role of ["ceo", "qa"]) {
      expect(
        collectAgentConfigHygieneWarnings({
          role,
          adapterType: "claude_local",
          adapterConfig: { thinking: "medium" },
        }),
      ).toEqual([]);
    }
  });

  it("does not warn on 'max' for ceo/qa roles", () => {
    for (const role of ["ceo", "qa"]) {
      expect(
        collectAgentConfigHygieneWarnings({
          role,
          adapterType: "claude_local",
          adapterConfig: { thinking: "max" },
        }),
      ).toEqual([]);
    }
  });

  it("warns when commandcode_local pm/researcher/general leaves effort unset", () => {
    for (const role of ["pm", "researcher", "general"]) {
      const warnings = collectAgentConfigHygieneWarnings({
        role,
        adapterType: "commandcode_local",
        adapterConfig: {},
      });
      expect(warnings.map((w) => w.code)).toEqual(["agent_unset_commandcode_effort"]);
      expect(warnings[0]!.message).toContain("low");
    }
  });

  it("returns [] for commandcode_local pm with effort 'low'", () => {
    expect(
      collectAgentConfigHygieneWarnings({
        role: "pm",
        adapterType: "commandcode_local",
        adapterConfig: { effort: "low" },
      }),
    ).toEqual([]);
  });

  it("does not warn on unset effort for engineering roles or other adapters", () => {
    expect(
      collectAgentConfigHygieneWarnings({
        role: "engineer",
        adapterType: "commandcode_local",
        adapterConfig: {},
      }),
    ).toEqual([]);
    expect(
      collectAgentConfigHygieneWarnings({
        role: "pm",
        adapterType: "claude_local",
        adapterConfig: {},
      }),
    ).toEqual([]);
  });

  it("handles missing fields safely", () => {
    expect(collectAgentConfigHygieneWarnings({})).toEqual([]);
    expect(collectAgentConfigHygieneWarnings({ role: null, adapterType: null, adapterConfig: null })).toEqual([]);
  });
});
