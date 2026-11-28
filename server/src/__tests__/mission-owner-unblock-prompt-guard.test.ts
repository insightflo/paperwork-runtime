import { describe, expect, it } from "vitest";
import { buildMissionOwnerUnblockDescription } from "../services/missions/mission-owner-unblock-description.js";

const ACTIVE_REWORK_GUARD = "Never submit `request_input` or `escalate` while another workflow/rework step in this mission is actively `running`";
const CONCRETE_REASON_GUARD = "always include a concrete `reason` and `nextAction` (blank requests are rejected)";

describe("mission owner unblock prompt guard", () => {
  it("includes active-rework and concrete-reason guard text in the same bullet", () => {
    const description = buildMissionOwnerUnblockDescription(
      { id: "mission-1", title: "Mission" },
      {
        id: "source-1",
        identifier: "SRC-1",
        title: "Source",
        status: "blocked",
        assigneeAgentId: "agent-1",
      },
    );

    const guardLine = description
      .split("\n")
      .find((line) => line.startsWith("- Never submit `request_input`"));

    expect(guardLine).toBeDefined();
    expect(guardLine).toContain(ACTIVE_REWORK_GUARD);
    expect(guardLine).toContain("let active rework or Exception Huddle finish first");
    expect(guardLine).toContain(CONCRETE_REASON_GUARD);
  });
});
