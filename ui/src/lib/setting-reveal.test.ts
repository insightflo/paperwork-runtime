import { describe, expect, it } from "vitest";
import {
  AGENT_SETTING_TARGETS,
  buildAgentSettingHref,
  parseAgentSettingDeepLink,
  type AgentSettingLinkId,
} from "./setting-reveal";

const ALL_LINK_IDS: AgentSettingLinkId[] = [
  "agent.model",
  "agent.backup-models",
  "agent.instructions",
  "agent.access",
  "agent.folders",
  "agent.mcp",
  "agent.busy-message",
  "agent.notification-level",
  "agent.heartbeat",
  "agent.cli-env",
];

describe("AGENT_SETTING_TARGETS", () => {
  it("defines a target with tab, fieldAnchor, and Korean label for every link id", () => {
    for (const id of ALL_LINK_IDS) {
      const target = AGENT_SETTING_TARGETS[id];
      expect(["basic", "permissions", "behavior", "advanced"]).toContain(target.tab);
      expect(target.fieldAnchor.length).toBeGreaterThan(0);
      expect(target.labelKo.length).toBeGreaterThan(0);
    }
  });
});

describe("buildAgentSettingHref", () => {
  it("builds a company-prefixed agent URL with tab and focus query params", () => {
    expect(buildAgentSettingHref("pap", "agent-1", "agent.model")).toBe(
      "/PAP/agents/agent-1?tab=basic&focus=agent.model",
    );
  });

  it("normalizes a lowercase company prefix", () => {
    expect(buildAgentSettingHref("ret", "a2", "agent.cli-env")).toBe(
      "/RET/agents/a2?tab=advanced&focus=agent.cli-env",
    );
  });

  it("omits the prefix segment when companyPrefix is null", () => {
    expect(buildAgentSettingHref(null, "a3", "agent.folders")).toBe(
      "/agents/a3?tab=permissions&focus=agent.folders",
    );
  });
});

describe("parseAgentSettingDeepLink", () => {
  it("parses a valid tab and focus pair", () => {
    expect(parseAgentSettingDeepLink("?tab=basic&focus=agent.model")).toEqual({
      tab: "basic",
      settingId: "agent.model",
    });
  });

  it("rejects an unknown tab but keeps a valid focus (fail-closed per field)", () => {
    expect(parseAgentSettingDeepLink("?tab=secret&focus=agent.mcp")).toEqual({
      tab: null,
      settingId: "agent.mcp",
    });
  });

  it("rejects an unknown focus id but keeps a valid tab (fail-closed per field)", () => {
    expect(parseAgentSettingDeepLink("?tab=advanced&focus=agent.hack")).toEqual({
      tab: "advanced",
      settingId: null,
    });
  });

  it("returns nulls when params are missing entirely", () => {
    expect(parseAgentSettingDeepLink("")).toEqual({ tab: null, settingId: null });
    expect(parseAgentSettingDeepLink("?tab=basic")).toEqual({ tab: "basic", settingId: null });
    expect(parseAgentSettingDeepLink("?focus=agent.model")).toEqual({
      tab: null,
      settingId: "agent.model",
    });
  });
});
