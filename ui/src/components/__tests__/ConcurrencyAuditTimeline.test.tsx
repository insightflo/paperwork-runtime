/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConcurrencyAuditTimeline,
  formatConcurrencyAuditKind,
  type ConcurrencyAuditItem,
  type ConcurrencyAuditKind,
} from "../ConcurrencyAuditTimeline";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function auditItem(overrides: Partial<ConcurrencyAuditItem> = {}): ConcurrencyAuditItem {
  return {
    id: "audit-1",
    timestampIso: "2026-03-02T09:15:00.000Z",
    agentId: "agent-1",
    runId: "run-1",
    issueId: "issue-1",
    kind: "slot_admitted",
    slotSnapshot: { running: 3, maxSlots: 5, queued: 2 },
    reason: "실행 슬롯이 배정됐습니다.",
    ...overrides,
  };
}

let host: HTMLDivElement;
let root: Root;

async function renderTimeline(
  events: readonly ConcurrencyAuditItem[],
  options: { maxItems?: number; onInspectRun?: (runId: string) => void } = {},
) {
  await act(async () => {
    root.render(<ConcurrencyAuditTimeline events={events} {...options} />);
  });
}

function click(element: Element) {
  act(() => {
    (element as HTMLElement).click();
  });
}

describe("formatConcurrencyAuditKind", () => {
  it("formats every concurrency audit kind in Korean", () => {
    const expectations: Array<[ConcurrencyAuditKind, string]> = [
      ["slot_admitted", "슬롯 배정"],
      ["capacity_deferred", "슬롯 대기"],
      ["lease_renewed", "리스 갱신"],
      ["provider_throttled", "프로바이더 제한"],
      ["issue_serialized", "이슈 직렬화"],
      ["deadlock_break_recommended", "순환 대기 해제 권고"],
    ];

    for (const [kind, label] of expectations) {
      expect(formatConcurrencyAuditKind(kind)).toBe(label);
    }
  });
});

describe("ConcurrencyAuditTimeline", () => {
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    document.body.innerHTML = "";
  });

  it("returns null when there are no events", async () => {
    await renderTimeline([]);

    expect(host.querySelector('[data-testid="concurrency-audit-timeline"]')).toBeNull();
    expect(host.textContent).toBe("");
  });

  it("renders slot snapshots and a truncation footer when events exceed maxItems", async () => {
    await renderTimeline(
      [
        auditItem({ id: "audit-1", runId: "run-1", reason: "첫 번째 사유" }),
        auditItem({ id: "audit-2", runId: "run-2", reason: "두 번째 사유" }),
        auditItem({ id: "audit-3", runId: "run-3", reason: "세 번째 사유" }),
      ],
      { maxItems: 2 },
    );

    const region = host.querySelector('[data-testid="concurrency-audit-timeline"]');
    expect(region).toBeTruthy();
    expect(region!.getAttribute("role")).toBe("region");
    expect(region!.getAttribute("aria-label")).toBe("동시 실행 감사 기록");
    expect(host.querySelectorAll("li")).toHaveLength(2);
    expect(host.textContent).toContain("3/5 · 대기 2");
    expect(host.textContent).toContain("첫 번째 사유");
    expect(host.textContent).toContain("두 번째 사유");
    expect(host.textContent).not.toContain("세 번째 사유");
    expect(host.textContent).toContain("+1건 더 있음");
  });

  it("fires onInspectRun with the run id when the inspect action is clicked", async () => {
    const onInspectRun = vi.fn();
    await renderTimeline([auditItem({ runId: "run-inspect" })], { onInspectRun });

    const button = host.querySelector("button");
    expect(button).toBeTruthy();
    expect(button!.getAttribute("type")).toBe("button");
    expect(button!.textContent).toContain("실행 검토");

    click(button!);

    expect(onInspectRun).toHaveBeenCalledTimes(1);
    expect(onInspectRun).toHaveBeenCalledWith("run-inspect");
  });
});
