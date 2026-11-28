import { describe, expect, it } from "vitest";
import {
  PAPERWORK_ISSUE_STATUS_LABELS,
  SELECTABLE_ISSUE_STATUS_OPTIONS,
  paperworkIssueStatusLabel,
} from "../IssueProperties";

describe("IssueProperties Paperwork status options", () => {
  it("excludes legacy backlog and in_review from new selections", () => {
    const values = SELECTABLE_ISSUE_STATUS_OPTIONS.map((option) => option.value);

    expect(values).toEqual(["todo", "in_progress", "blocked", "done", "cancelled"]);
    expect(values).not.toContain("backlog");
    expect(values).not.toContain("in_review");
  });

  it("maps canonical statuses to Korean Paperwork labels", () => {
    expect(SELECTABLE_ISSUE_STATUS_OPTIONS).toEqual([
      { value: "todo", label: "대기" },
      { value: "in_progress", label: "진행 중" },
      { value: "blocked", label: "차단됨" },
      { value: "done", label: "완료" },
      { value: "cancelled", label: "취소됨" },
    ]);
  });

  it("keeps persisted legacy statuses readable", () => {
    expect(paperworkIssueStatusLabel("backlog")).toBe("대기열");
    expect(paperworkIssueStatusLabel("in_review")).toBe("검증 중");
    expect(PAPERWORK_ISSUE_STATUS_LABELS.todo).toBe("대기");
  });
});
