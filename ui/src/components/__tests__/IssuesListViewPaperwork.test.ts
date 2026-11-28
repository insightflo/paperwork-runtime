import { describe, expect, it } from "vitest";
import {
  PAPERWORK_ISSUE_STATUS_LABELS,
  paperworkIssueStatusLabel,
  quickFilterPresets,
} from "../issuesListView";

describe("IssuesList Paperwork status labels", () => {
  it("maps every canonical issue status to its Korean execution label", () => {
    expect(PAPERWORK_ISSUE_STATUS_LABELS).toEqual({
      backlog: "대기열",
      todo: "대기",
      in_progress: "진행 중",
      in_review: "검증 중",
      blocked: "차단됨",
      done: "완료",
      cancelled: "취소됨",
    });
  });

  it("keeps unknown statuses readable with the legacy title-case fallback", () => {
    expect(paperworkIssueStatusLabel("custom_state")).toBe("Custom State");
  });

  it("uses Paperwork labels for direct status quick filters without changing status keys", () => {
    expect(quickFilterPresets.find((preset) => preset.statuses.join(",") === "backlog")?.label).toBe("대기열");
    expect(quickFilterPresets.find((preset) => preset.statuses.join(",") === "done,cancelled")?.label).toBe("완료");
  });
});
