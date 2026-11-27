// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EndpointBotStatusList, type EndpointBotSummary } from "./EndpointBotStatusList";

let host: HTMLDivElement;
let root: Root;
const mac: EndpointBotSummary = {
  deviceId: "device-mac-exact-01", botName: "작업용 Mac", os: "macOS", arch: "arm64",
  online: true, lastSeenAt: "2026-11-28T10:00:00Z", detectedClis: ["pi", "claude", "codex"],
  allowedFolders: [{ path: "/docs", mode: "ro" }, { path: "/work", mode: "rw" }],
  pendingOutboxCount: 3,
};
const windows: EndpointBotSummary = {
  deviceId: "device-windows-02", botName: "개인 PC", os: "Windows", arch: "x86_64",
  online: false, lastSeenAt: "2026-11-27T09:00:00Z", detectedClis: [], allowedFolders: [],
};
async function render(node: ReactNode) {
  await act(async () => { root.render(node); });
}
function button(name: string) {
  const el = host.querySelector<HTMLButtonElement>(`button[aria-label="${name} 연결 해제"]`);
  expect(el).not.toBeNull();
  return el!;
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("EndpointBotStatusList", () => {
  it("renders a clean empty state", async () => {
    await render(<EndpointBotStatusList endpoints={[]} onRevoke={vi.fn()} />);
    expect(host.textContent).toContain("연결된 개인 단말 봇이 아직 없습니다");
    expect(host.querySelector("button, li")).toBeNull();
    expect(host.textContent).not.toMatch(/paperclip/i);
  });

  it("shows each bot's connection, platform, CLIs, folder permissions and pending count", async () => {
    await render(<EndpointBotStatusList endpoints={[mac, windows]} />);
    const list = host.querySelector('ul[aria-label="개인 단말 봇"]')!;
    expect(list.children).toHaveLength(2);
    const [online, offline] = Array.from(list.children);
    expect(online.querySelector('[role="status"]')?.textContent).toBe("온라인");
    expect(offline.querySelector('[role="status"]')?.textContent).toBe("오프라인");
    expect(online.textContent).toContain("작업용 Mac");
    expect(online.textContent).toContain("macOS / arm64");
    expect(offline.textContent).toContain("Windows / x86_64");
    expect(Array.from(online.querySelectorAll('ul[aria-label="감지된 CLI"] li'))
      .map((el) => el.textContent)).toEqual(["pi", "claude", "codex"]);
    expect(Array.from(online.querySelectorAll('ul[aria-label="허용된 폴더"] li'))
      .map((el) => el.textContent)).toEqual(["/docs읽기 전용", "/work읽기·쓰기"]);
    expect(online.textContent).toContain("전송 대기 3건");
    expect(offline.textContent).not.toContain("전송 대기");
    expect(online.querySelector("time")?.getAttribute("datetime")).toBe(mac.lastSeenAt);
    expect(host.querySelector("button")).toBeNull();
    expect(host.textContent).not.toMatch(/paperclip/i);
  });

  it.each([0, -1, undefined])("hides a non-positive or absent outbox count (%s)", async (count) => {
    await render(<EndpointBotStatusList endpoints={[{ ...mac, pendingOutboxCount: count }]} />);
    expect(host.textContent).not.toContain("전송 대기");
  });

  it("revokes the exact device and disables only the bot being revoked", async () => {
    const onRevoke = vi.fn();
    await render(<EndpointBotStatusList endpoints={[mac, windows]} onRevoke={onRevoke} />);
    expect(button(mac.botName).textContent).toBe("연결 해제");
    await act(async () => { button(mac.botName).click(); });
    expect(onRevoke.mock.calls).toEqual([[mac.deviceId]]);

    await render(<EndpointBotStatusList endpoints={[mac, windows]} onRevoke={onRevoke}
      revokingId={mac.deviceId} />);
    expect(button(mac.botName).disabled).toBe(true);
    expect(button(windows.botName).disabled).toBe(false);
    await act(async () => { button(mac.botName).click(); button(windows.botName).click(); });
    expect(onRevoke.mock.calls).toEqual([[mac.deviceId], [windows.deviceId]]);

    await render(<EndpointBotStatusList endpoints={[mac]} onRevoke={onRevoke} revokingId={null} />);
    expect(button(mac.botName).disabled).toBe(false);
  });

  it("supports an asynchronous revoke callback", async () => {
    const onRevoke = vi.fn(async (_deviceId: string) => {});
    await render(<EndpointBotStatusList endpoints={[mac]} onRevoke={onRevoke} />);
    await act(async () => { button(mac.botName).click(); });
    expect(onRevoke.mock.calls).toEqual([[mac.deviceId]]);
  });
});
