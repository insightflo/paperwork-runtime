/** @vitest-environment jsdom */

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PAPERWORK_SELECTABLE_WORK_STATUSES,
  StatusIcon,
  WORK_STATUS_LABELS,
} from "../StatusIcon";

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children?: ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children?: ReactNode }) => <div data-testid="status-picker">{children}</div>,
}));

let host: HTMLDivElement;
let root: Root;

async function render(node: ReactNode) {
  await act(async () => {
    root.render(node);
  });
}

function pickerButtons(): HTMLButtonElement[] {
  const picker = host.querySelector('[data-testid="status-picker"]');
  expect(picker).not.toBeNull();
  return Array.from(picker!.querySelectorAll("button"));
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

describe("StatusIcon Paperwork status picker", () => {
  it("exposes only the five selectable Paperwork statuses with Korean labels", async () => {
    await render(<StatusIcon status="todo" onChange={() => {}} />);

    expect(PAPERWORK_SELECTABLE_WORK_STATUSES).toEqual(["todo", "in_progress", "blocked", "done", "cancelled"]);
    expect(pickerButtons().map((button) => button.textContent?.trim())).toEqual([
      "대기",
      "진행 중",
      "차단됨",
      "완료",
      "취소됨",
    ]);
    expect(host.textContent).not.toContain("대기열");
    expect(host.textContent).not.toContain("검증 중");
  });

  it("uses the Korean Paperwork labels for every selectable and legacy status", () => {
    expect(WORK_STATUS_LABELS).toMatchObject({
      todo: "대기",
      in_progress: "진행 중",
      blocked: "차단됨",
      done: "완료",
      cancelled: "취소됨",
      backlog: "대기열",
      in_review: "검증 중",
    });
  });

  it("continues rendering existing legacy in_review and backlog statuses cleanly", async () => {
    await render(
      <>
        <StatusIcon status="in_review" />
        <StatusIcon status="backlog" />
      </>,
    );

    expect(host.querySelectorAll("span")).toHaveLength(2);
  });

  it("calls onChange with the canonical status enum value when a picker option is selected", async () => {
    const onChange = vi.fn();
    await render(<StatusIcon status="todo" onChange={onChange} />);

    const inProgress = pickerButtons().find((button) => button.textContent?.includes("진행 중"));
    expect(inProgress).toBeDefined();
    await act(async () => {
      inProgress!.click();
    });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("in_progress");
  });
});
