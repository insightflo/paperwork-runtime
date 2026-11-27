/** @vitest-environment jsdom */
// [purpose] EndpointLocalTaskCard: 온라인 봇이 없으면 제출이 막히고 안내가 보이며, `..` 경로는
//   클라이언트에서 차단되고, list_dir 접수는 deviceId/targetPath를 그대로 전달해 taskId를 표시하며,
//   shell_exec는 명령이 필수이고 입력한 명령이 전달되며, 접수 실패 시 오류 배너가 보이는 것을 검증한다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EndpointLocalTaskCard, type EndpointLocalTaskTarget } from "./EndpointLocalTaskCard";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function endpoint(overrides: Partial<EndpointLocalTaskTarget> = {}): EndpointLocalTaskTarget {
  return { deviceId: "dev-1", botName: "내 노트북", online: true, ...overrides };
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

function control(selectors: string): HTMLInputElement | HTMLSelectElement {
  const found = host!.querySelector<HTMLInputElement | HTMLSelectElement>(selectors);
  if (!found) throw new Error(`control not found: ${selectors}`);
  return found;
}

async function setValue(selectors: string, value: string) {
  const element = control(selectors);
  // React value tracker 우회: 프로토타입의 native setter로 값을 넣어야 onChange가 반응한다.
  const proto = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  await act(async () => {
    setter.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function submitForm() {
  await act(async () => {
    const form = host!.querySelector("form");
    if (!form) throw new Error("form not found");
    form.requestSubmit();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("EndpointLocalTaskCard", () => {
  it("온라인 봇이 없으면 제출을 막고 안내 문구를 보여준다", async () => {
    await mount(<EndpointLocalTaskCard endpoints={[endpoint({ online: false })]} onDispatch={vi.fn()} />);
    const button = host!.querySelector<HTMLButtonElement>("button[type='submit']");
    expect(button?.disabled).toBe(true);
    expect(host!.textContent).toContain("온라인 상태인 개인 단말 봇이 없습니다");
  });

  it("`..` 경로는 onDispatch를 호출하지 않고 검증 오류를 보여준다", async () => {
    const onDispatch = vi.fn();
    await mount(<EndpointLocalTaskCard endpoints={[endpoint()]} onDispatch={onDispatch} />);
    await setValue("input[aria-label='대상 경로']", "../secret/keys.txt");
    await submitForm();
    expect(onDispatch).not.toHaveBeenCalled();
    expect(host!.textContent).toContain("허용되지 않습니다");
  });

  it("list_dir 작업에 deviceId와 targetPath를 전달하고 taskId를 표시한다", async () => {
    const onDispatch = vi.fn().mockResolvedValue({ taskId: "task-42" });
    await mount(
      <EndpointLocalTaskCard
        endpoints={[
          endpoint({ deviceId: "dev-9", botName: "회사 맥" }),
          endpoint({ deviceId: "dev-off", botName: "절전 맥", online: false }),
        ]}
        onDispatch={onDispatch}
      />,
    );
    await setValue("input[aria-label='대상 경로']", "~/Projects/paperclip");
    await submitForm();
    expect(onDispatch).toHaveBeenCalledTimes(1);
    expect(onDispatch).toHaveBeenCalledWith("dev-9", {
      kind: "list_dir",
      targetPath: "~/Projects/paperclip",
    });
    expect(host!.textContent).toContain("task-42");
  });

  it("shell_exec는 명령이 필수이고 입력한 명령을 onDispatch에 전달한다", async () => {
    const onDispatch = vi.fn().mockResolvedValue(undefined);
    await mount(<EndpointLocalTaskCard endpoints={[endpoint()]} onDispatch={onDispatch} />);
    await setValue("select[aria-label='로컬 작업 종류']", "shell_exec");
    await setValue("input[aria-label='대상 경로']", "~/Projects");
    await submitForm();
    expect(onDispatch).not.toHaveBeenCalled();
    expect(host!.textContent).toContain("실행할 명령을 입력하세요");
    await setValue("input[aria-label='실행할 명령']", "git status --short");
    await submitForm();
    expect(onDispatch).toHaveBeenCalledTimes(1);
    expect(onDispatch).toHaveBeenCalledWith("dev-1", {
      kind: "shell_exec",
      targetPath: "~/Projects",
      command: "git status --short",
    });
  });

  it("onDispatch가 실패하면 오류 배너를 보여준다", async () => {
    const onDispatch = vi.fn().mockRejectedValue(new Error("봇에 도달할 수 없습니다"));
    await mount(<EndpointLocalTaskCard endpoints={[endpoint()]} onDispatch={onDispatch} />);
    await setValue("input[aria-label='대상 경로']", "~/Projects");
    await submitForm();
    expect(host!.textContent).toContain("작업 접수에 실패했습니다");
    expect(host!.textContent).toContain("봇에 도달할 수 없습니다");
  });
});
