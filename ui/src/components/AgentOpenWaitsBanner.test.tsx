/** @vitest-environment jsdom */
// [purpose] AgentOpenWaitsBanner: 대기가 없으면 아무 것도 렌더링하지 않는 동작과 개수 배지·요약·
//   종류 배지·대상 라벨 표시, 해결 버튼의 콜백 인자/로딩 상태를 검증한다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentOpenWaitsBanner, type AgentOpenWaitItem } from "./AgentOpenWaitsBanner";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function wait(overrides: Partial<AgentOpenWaitItem> = {}): AgentOpenWaitItem {
  return {
    id: "wait-1",
    kind: "pending-question",
    summary: "스키마 변경 승인 질문",
    createdAt: "2026-02-01T09:00:00.000Z",
    targetLabel: "agent-alpha",
    ...overrides,
  };
}

let host: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount(node: ReactNode) {
  host = document.createElement("div");
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(node);
  });
}

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  host?.remove();
  host = null;
  root = null;
});

function resolveButtons(): HTMLButtonElement[] {
  const found = [...host!.querySelectorAll("button")].filter((el) => el.textContent?.includes("해결"));
  if (found.length === 0) throw new Error("resolve buttons not found");
  return found as HTMLButtonElement[];
}

describe("AgentOpenWaitsBanner", () => {
  it("returns empty DOM when waits is empty", async () => {
    await mount(<AgentOpenWaitsBanner waits={[]} />);
    expect(host!.innerHTML).toBe("");
  });

  it("renders count badge, summaries, kind badges, and target labels", async () => {
    await mount(
      <AgentOpenWaitsBanner
        waits={[
          wait(),
          wait({ id: "wait-2", kind: "external-approval", summary: "외부 API 키 발급 대기", targetLabel: "agent-beta" }),
        ]}
      />,
    );
    expect(host!.querySelector('[role="region"][aria-label="대기 중인 요청"]')).not.toBeNull();
    expect(host!.textContent).toContain("대기 중인 요청 2건");
    expect(host!.textContent).toContain("스키마 변경 승인 질문");
    expect(host!.textContent).toContain("외부 API 키 발급 대기");
    expect(host!.textContent).toContain("질문 대기");
    expect(host!.textContent).toContain("외부 승인");
    expect(host!.textContent).toContain("agent-alpha");
    expect(host!.textContent).toContain("agent-beta");
  });

  it("clicking 해결 완료 invokes onResolve with the exact wait.id", async () => {
    const onResolve = vi.fn();
    const waits = [
      wait(),
      wait({ id: "wait-2", kind: "blocked-handoff", summary: "담당자 인계 차단", targetLabel: "agent-beta" }),
    ];
    await mount(<AgentOpenWaitsBanner waits={waits} onResolve={onResolve} />);
    await act(async () => {
      resolveButtons()[1].click();
    });
    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(onResolve).toHaveBeenCalledWith("wait-2");
  });

  it("disables the button and shows a progress label while resolvingId matches", async () => {
    const waits = [wait(), wait({ id: "wait-2", kind: "blocked-handoff", summary: "담당자 인계 차단" })];
    await mount(<AgentOpenWaitsBanner waits={waits} onResolve={vi.fn()} resolvingId="wait-1" />);
    const buttons = resolveButtons();
    expect(buttons[0].disabled).toBe(true);
    expect(buttons[0].textContent).toContain("해결 중");
    expect(buttons[1].disabled).toBe(false);
    expect(buttons[1].textContent).toContain("해결 완료");
  });
});
