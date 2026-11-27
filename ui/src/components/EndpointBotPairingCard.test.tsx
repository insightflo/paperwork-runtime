/** @vitest-environment jsdom */
import { act } from "react";
import { execFileSync } from "node:child_process";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EndpointBotPairingCard } from "./EndpointBotPairingCard";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const container = document.createElement("div");
let root: Root | null = null;
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");

async function render() {
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<EndpointBotPairingCard />));
}
async function click(selector: string) {
  await act(async () => { container.querySelector<HTMLElement>(selector)!.click(); });
}
async function input(label: string, value: string) {
  const field = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
const command = () => container.querySelector("[aria-label='설치 명령']")!.textContent!;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container.remove();
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
  vi.restoreAllMocks();
});

describe("EndpointBotPairingCard", () => {
  it("shows each OS command and its default name while switching tabs", async () => {
    await render();
    const origin = window.location.origin;
    expect(command()).toBe(`bash scripts/install-paperwork-bot.sh --server ${origin} --name my-mac --folder ~/Projects`);
    expect(container.querySelector('button[aria-label="macOS"]')?.getAttribute("aria-pressed")).toBe("true");
    await click('button[aria-label="Linux"]');
    expect(command()).toBe(`bash scripts/install-paperwork-bot.sh --server ${origin} --name my-linux --folder ~/Projects`);
    await click('button[aria-label="Windows"]');
    expect(command()).toBe(`paperwork-bot init --server ${origin} --name my-windows --folder ~/Projects`);
    expect(container.textContent).toContain("Windows PowerShell");
  });

  it("uses custom values and safely quotes shell-sensitive input", async () => {
    await render();
    await input("단말 이름", "dev's laptop; echo nope");
    await input("허용 작업 폴더", "~/Projects/My Work");
    expect(command()).toContain("--name 'dev'\\''s laptop; echo nope' --folder ~/'Projects/My Work'");
    const folderArgument = command().match(/--folder (.+)$/)?.[1];
    expect(folderArgument).toBe("~/'Projects/My Work'");
    const expandedFolder = execFileSync("bash", ["-c", `set -- ${folderArgument}; printf '%s' "$1"`], {
      encoding: "utf8",
      env: { ...process.env, HOME: "/tmp/paperwork home" },
    });
    expect(expandedFolder).toBe("/tmp/paperwork home/Projects/My Work");
    await click('button[aria-label="Windows"]');
    expect(command()).toContain("--name 'dev''s laptop; echo nope' --folder '~/Projects/My Work'");
  });

  it("falls back to OS name and folder defaults when fields are empty", async () => {
    await render();
    await input("단말 이름", "custom");
    await input("단말 이름", "   ");
    await input("허용 작업 폴더", "");
    await click('button[aria-label="Linux"]');
    expect(command()).toContain("--name my-linux --folder ~/Projects");
  });

  it("copies the command, clears feedback on edits, and ignores stale completion", async () => {
    await render();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await click('button[aria-label="명령 복사"]');
    expect(writeText).toHaveBeenCalledWith(command());
    expect(container.querySelector('button[aria-label="명령 복사"]')?.textContent).toBe("복사됨");
    await input("단말 이름", "renamed");
    expect(container.querySelector('button[aria-label="명령 복사"]')?.textContent).toBe("명령 복사");

    let resolveCopy!: () => void;
    writeText.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveCopy = resolve; }));
    await click('button[aria-label="명령 복사"]');
    await input("단말 이름", "newer");
    await act(async () => resolveCopy());
    expect(container.querySelector('button[aria-label="명령 복사"]')?.textContent).toBe("명령 복사");
  });

  it("shows clipboard failure and clears it when the command changes", async () => {
    await render();
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
    await click('button[aria-label="명령 복사"]');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("클립보드를 사용할 수 없습니다");
    await input("단말 이름", "changed");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    Reflect.deleteProperty(navigator, "clipboard");
    await click('button[aria-label="명령 복사"]');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("클립보드를 사용할 수 없습니다");
  });

  it("replaces prior clipboard feedback after the next same-command attempt", async () => {
    await render();
    const writeText = vi.fn()
      .mockRejectedValueOnce(new Error("denied"))
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });

    await click('button[aria-label="명령 복사"]');
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    await click('button[aria-label="명령 복사"]');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('button[aria-label="명령 복사"]')?.textContent).toBe("복사됨");

    await click('button[aria-label="명령 복사"]');
    expect(container.querySelector('button[aria-label="명령 복사"]')?.textContent).toBe("복사됨");
    await click('button[aria-label="명령 복사"]');
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="명령 복사"]')?.textContent).toBe("명령 복사");
  });
});
