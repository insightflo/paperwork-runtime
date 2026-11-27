import { normalizeCompanyPrefix } from "./company-routes";

/**
 * Deep-link reveal targets for the agent settings UI (stage30 W5 4-tab form).
 * A link id resolves to a settings tab plus a stable DOM anchor for focusing
 * the field after navigation.
 */
export type AgentSettingTab = "basic" | "permissions" | "behavior" | "advanced";

export type AgentSettingLinkId =
  | "agent.model"
  | "agent.backup-models"
  | "agent.instructions"
  | "agent.access"
  | "agent.folders"
  | "agent.mcp"
  | "agent.busy-message"
  | "agent.notification-level"
  | "agent.heartbeat"
  | "agent.cli-env";

export type AgentSettingTarget = {
  tab: AgentSettingTab;
  fieldAnchor: string;
  labelKo: string;
};

const AGENT_SETTING_TABS: readonly AgentSettingTab[] = [
  "basic",
  "permissions",
  "behavior",
  "advanced",
];

export const AGENT_SETTING_TARGETS: Record<AgentSettingLinkId, AgentSettingTarget> = {
  "agent.model": { tab: "basic", fieldAnchor: "agent-field-model", labelKo: "모델" },
  "agent.backup-models": { tab: "basic", fieldAnchor: "agent-field-backup-models", labelKo: "백업 모델" },
  "agent.instructions": { tab: "behavior", fieldAnchor: "agent-field-instructions", labelKo: "지시문" },
  "agent.access": { tab: "permissions", fieldAnchor: "agent-field-access", labelKo: "접근 권한" },
  "agent.folders": { tab: "permissions", fieldAnchor: "agent-field-folders", labelKo: "폴더 접근" },
  "agent.mcp": { tab: "advanced", fieldAnchor: "agent-field-mcp", labelKo: "MCP 서버" },
  "agent.busy-message": { tab: "behavior", fieldAnchor: "agent-field-busy-message", labelKo: "바쁨 메시지" },
  "agent.notification-level": { tab: "behavior", fieldAnchor: "agent-field-notification-level", labelKo: "알림 수준" },
  "agent.heartbeat": { tab: "behavior", fieldAnchor: "agent-field-heartbeat", labelKo: "하트비트" },
  "agent.cli-env": { tab: "advanced", fieldAnchor: "agent-field-cli-env", labelKo: "CLI 환경" },
};

const AGENT_SETTING_LINK_IDS: readonly string[] = Object.keys(AGENT_SETTING_TARGETS);

/** Builds the agent settings URL for a deep link, e.g. `/PAP/agents/a1?tab=basic&focus=agent.model`. */
export function buildAgentSettingHref(
  companyPrefix: string | null,
  agentId: string,
  settingId: AgentSettingLinkId,
): string {
  const target = AGENT_SETTING_TARGETS[settingId];
  const prefix = companyPrefix ? `/${normalizeCompanyPrefix(companyPrefix)}` : "";
  return `${prefix}/agents/${agentId}?tab=${target.tab}&focus=${settingId}`;
}

/**
 * Parses `location.search` for an agent settings deep link. Values are
 * validated against the closed enums fail-closed: an unknown tab or unknown
 * focus id yields `null` for that field only.
 */
export function parseAgentSettingDeepLink(search: string): {
  tab: AgentSettingTab | null;
  settingId: AgentSettingLinkId | null;
} {
  const params = new URLSearchParams(search);
  const tabParam = params.get("tab");
  const focusParam = params.get("focus");
  const tab =
    tabParam !== null && AGENT_SETTING_TABS.includes(tabParam as AgentSettingTab)
      ? (tabParam as AgentSettingTab)
      : null;
  const settingId =
    focusParam !== null && AGENT_SETTING_LINK_IDS.includes(focusParam)
      ? (focusParam as AgentSettingLinkId)
      : null;
  return { tab, settingId };
}
