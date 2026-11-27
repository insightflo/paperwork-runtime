// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSharedTablesPanel, type SharedTableSummary } from "./AgentSharedTablesPanel";

const tables: SharedTableSummary[] = [
  { id: "contacts", name: "연락처", columns: ["이름", "횟수", "활성", "메모"],
    rows: [{ 이름: "민수", 횟수: 0, 활성: false, 메모: null }] },
  { id: "tasks", name: "할 일", columns: ["작업"], rows: [{ 작업: "자료 조사" }] },
];
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => { await act(() => root.unmount()); host.remove(); });

async function render(props: Parameters<typeof AgentSharedTablesPanel>[0]) {
  await act(() => root.render(<AgentSharedTablesPanel {...props} />));
}
async function fill(label: string, value: string) {
  const input = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function submit() {
  await act(async () => {
    host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

describe("AgentSharedTablesPanel", () => {
  it("explains an empty state without brand text or unavailable create controls", async () => {
    await render({ tables: [] });
    expect(host.textContent).toContain("에이전트들이 함께 읽고 쓰는 공유 표가 아직 없습니다");
    expect(host.textContent).not.toMatch(/paperclip/i);
    expect(host.querySelector("table")).toBeNull();
    expect(host.querySelector("form")).toBeNull();
  });

  it("renders headers and primitive cells, and switches tables with accessible tabs", async () => {
    await render({ tables });
    expect([...host.querySelectorAll("th")].map((node) => node.textContent)).toEqual(tables[0].columns);
    expect([...host.querySelectorAll("td")].map((node) => node.textContent)).toEqual(["민수", "0", "false", "—"]);
    const tabs = host.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    await act(() => {
      tabs[1].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
      tabs[1].click();
    });
    expect(tabs[1].getAttribute("aria-selected")).toBe("true");
    expect(host.querySelector("table")?.textContent).toContain("자료 조사");
    expect(host.querySelector("table")?.textContent).not.toContain("민수");
    await render({ tables: [tables[0]] });
    expect(host.querySelector('[role="tablist"]')).toBeNull();
    expect(host.querySelector("table")?.textContent).toContain("민수");
  });

  it("submits a trimmed name and trimmed, deduplicated, nonempty columns", async () => {
    const onCreateTable = vi.fn();
    await render({ tables: [], onCreateTable });
    await fill("표 이름", "  고객 목록  ");
    await fill("열 이름", " 이름, 이메일 , 이름, , 이메일, 상태 ");
    await submit();
    expect(onCreateTable).toHaveBeenCalledExactlyOnceWith({ name: "고객 목록", columns: ["이름", "이메일", "상태"] });
    expect(host.querySelector<HTMLInputElement>('input[aria-label="표 이름"]')?.value).toBe("");
  });

  it("shows a named empty table and supports keyboard tab selection", async () => {
    await render({ tables: [{ ...tables[0], rows: [] }, tables[1]] });
    expect(host.querySelector("table")?.getAttribute("aria-label")).toBe("연락처");
    expect(host.querySelector("table")?.textContent).toContain("아직 등록된 행이 없습니다.");
    const tabs = host.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    await act(async () => {
      tabs[1].focus();
      tabs[1].dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(tabs[1].getAttribute("aria-selected")).toBe("true");
    expect(host.querySelector("table")?.textContent).toContain("자료 조사");
  });

  it.each([["", "이름"], ["   ", "이름"], ["고객", ""], ["고객", " , , "]])(
    "ignores invalid input (%j, %j)", async (name, columns) => {
      const onCreateTable = vi.fn();
      await render({ tables: [], onCreateTable });
      await fill("표 이름", name);
      await fill("열 이름", columns);
      await submit();
      expect(onCreateTable).not.toHaveBeenCalled();
      expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
    },
  );

  it("blocks submissions while creating", async () => {
    const onCreateTable = vi.fn();
    await render({ tables: [], onCreateTable, creating: true });
    await fill("표 이름", "고객");
    await fill("열 이름", "이름");
    await submit();
    expect(onCreateTable).not.toHaveBeenCalled();
    expect(host.querySelector("form")?.getAttribute("aria-busy")).toBe("true");
  });

  it("prevents duplicate async submissions and preserves input when creation fails", async () => {
    let reject!: (error: Error) => void;
    const onCreateTable = vi.fn(() => new Promise<void>((_, fail) => { reject = fail; }));
    await render({ tables: [], onCreateTable });
    await fill("표 이름", "고객");
    await fill("열 이름", "이름");
    await submit();
    await submit();
    expect(onCreateTable).toHaveBeenCalledTimes(1);
    await act(async () => { reject(new Error("offline")); });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("다시 시도");
    expect(host.querySelector<HTMLInputElement>('input[aria-label="표 이름"]')?.value).toBe("고객");
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
  });
});
