// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StatusBadge } from "../StatusBadge";

let host: HTMLDivElement;
let root: Root;

async function render(node: React.ReactNode) {
  await act(async () => {
    root.render(node);
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const canonicalCases = [
  ["agent", "active", "활성"],
  ["agent", "paused", "일시정지"],
  ["agent", "idle", "대기"],
  ["agent", "running", "실행 중"],
  ["agent", "error", "오류"],
  ["agent", "pending_approval", "승인 대기"],
  ["agent", "terminated", "종료됨"],
  ["run", "queued", "실행 대기"],
  ["run", "running", "실행 중"],
  ["run", "succeeded", "성공"],
  ["run", "failed", "실패"],
  ["run", "cancelled", "취소됨"],
  ["run", "timed_out", "시간 초과"],
  ["approval", "pending", "대기 중"],
  ["approval", "revision_requested", "수정 요청"],
  ["approval", "approved", "승인됨"],
  ["approval", "rejected", "반려됨"],
  ["mission", "planning", "계획 중"],
  ["mission", "active", "활성"],
  ["mission", "paused", "일시정지"],
  ["mission", "completed", "완료"],
  ["mission", "cancelled", "취소됨"],
  ["huddle", "open", "열림"],
  ["huddle", "decided", "결정됨"],
  ["huddle", "timed_out", "시간 초과"],
  ["huddle", "cancelled", "취소됨"],
  ["issue", "backlog", "대기열"],
  ["issue", "todo", "예정"],
  ["issue", "in_progress", "진행 중"],
  ["issue", "in_review", "검토 중"],
  ["issue", "blocked", "차단됨"],
  ["issue", "done", "완료"],
  ["issue", "cancelled", "취소됨"],
  ["goal", "planned", "계획됨"],
  ["goal", "achieved", "달성"],
  ["routine", "archived", "보관됨"],
] as const;

describe("StatusBadge", () => {
  it.each(canonicalCases)("renders the %s status %s with its Korean label", async (_domain, status, label) => {
    await render(<StatusBadge status={status} />);

    const badge = host.querySelector("span") as HTMLSpanElement;
    expect(badge.textContent).toBe(label);
    expect(badge.getAttribute("data-status")).toBe(status);
  });

  it("falls back to a spaced multi-underscore label for unknown statuses", async () => {
    await render(<StatusBadge status="custom_multi_word" />);

    const badge = host.querySelector("span") as HTMLSpanElement;
    expect(badge.textContent).toBe("custom multi word");
  });

  it("preserves the raw status in diagnostic attributes", async () => {
    await render(<StatusBadge status="custom_multi_word" />);

    const badge = host.querySelector("span") as HTMLSpanElement;
    expect(badge.getAttribute("data-status")).toBe("custom_multi_word");
    expect(badge.getAttribute("title")).toBe("custom_multi_word");
  });
});
