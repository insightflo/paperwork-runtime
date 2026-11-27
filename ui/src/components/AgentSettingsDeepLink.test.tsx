// @vitest-environment jsdom — Stage31 W-C: deep-link tab init + create-mode botPolicy via values.
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AgentConfigForm } from "./AgentConfigForm";
import { defaultCreateValues } from "./agent-config-defaults";

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: undefined, isPending: false, isError: false, error: null, refetch: () => {} }),
  useMutation: () => ({ mutate: () => {}, mutateAsync: async () => ({}), isPending: false, error: null }),
  useQueryClient: () => ({ invalidateQueries: () => {} }),
}));
vi.mock("../api/agents", () => ({ agentsApi: { adapterModels: async () => [], testEnvironment: async () => ({}) } }));
vi.mock("../api/instanceSettings", () => ({ instanceSettingsApi: { getUsageLimitGate: async () => null } }));
vi.mock("../api/secrets", () => ({ secretsApi: { list: async () => [], create: async () => ({}) } }));
vi.mock("../api/assets", () => ({ assetsApi: { uploadImage: async () => ({ contentPath: "" }) } }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "c1" }) }));
vi.mock("../hooks/useAdapterModelEfforts", () => ({ useAdapterModelEfforts: () => ({ data: [], isSuccess: true }) }));
vi.mock("./MarkdownEditor", () => ({ MarkdownEditor: () => null }));

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  window.history.replaceState(null, "", "/");
});
async function mount(node: ReactNode) {
  await act(async () => { root.render(<TooltipProvider>{node}</TooltipProvider>); });
}
function q<T extends Element>(selector: string): T {
  return host.querySelector<T>(selector)!;
}
async function setInput(el: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function click(el: Element) {
  await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
}
function setUrl(search: string) {
  window.history.replaceState(null, "", search || "/");
}
function panelId(): string | null {
  return host.querySelector('[role="tabpanel"]')?.id ?? null;
}

describe("AgentConfigForm deep-link tab init", () => {
  const form = () => <AgentConfigForm mode="create" values={{ ...defaultCreateValues }} onChange={vi.fn()} />;
  it("opens the permissions tab for ?tab=permissions&focus=agent.folders", async () => {
    setUrl("?tab=permissions&focus=agent.folders");
    await mount(form());
    expect(panelId()).toBe("agent-tabpanel-permissions");
    expect(host.innerHTML).toContain("허용 작업 폴더");
  });
  it("opens the behavior tab for ?tab=behavior", async () => {
    setUrl("?tab=behavior&focus=agent.busy-message");
    await mount(form());
    expect(panelId()).toBe("agent-tabpanel-behavior");
  });
  it("falls back to basic when the tab param is unknown (fail-closed)", async () => {
    setUrl("?tab=secret&focus=agent.folders");
    await mount(form());
    expect(panelId()).toBe("agent-tabpanel-basic");
  });
  it("opens basic when no deep-link params are present", async () => {
    setUrl("/");
    await mount(form());
    expect(panelId()).toBe("agent-tabpanel-basic");
  });
  it("initialTab prop wins over the URL param", async () => {
    setUrl("?tab=permissions");
    await mount(<AgentConfigForm mode="create" values={{ ...defaultCreateValues }} onChange={vi.fn()} initialTab="advanced" />);
    expect(panelId()).toBe("agent-tabpanel-advanced");
  });
});

describe("AgentConfigForm create-mode botPolicy persistence", () => {
  it("lifts folder edits into values via onChange({ botPolicy }) instead of dropping them", async () => {
    const onChange = vi.fn();
    await mount(<AgentConfigForm mode="create" values={{ ...defaultCreateValues }} onChange={onChange} />);
    await click(q('[role="tab"][aria-controls="agent-tabpanel-permissions"]'));
    await setInput(q<HTMLInputElement>('input[aria-label="새 폴더 경로"]'), "/tmp/demo");
    await click(q('button[aria-label="폴더 추가"]'));
    expect(onChange).toHaveBeenCalled();
    const patch = onChange.mock.calls.at(-1)![0] as { botPolicy?: { allowedFolders?: { path: string; mode: string }[] } };
    expect(patch.botPolicy?.allowedFolders).toEqual([{ path: "/tmp/demo", mode: "ro" }]);
  });
  it("renders botPolicy seeded from values (round-trip)", async () => {
    const onChange = vi.fn();
    await mount(
      <AgentConfigForm
        mode="create"
        values={{ ...defaultCreateValues, botPolicy: { allowedFolders: [{ path: "/tmp/seed", mode: "rw" }] } }}
        onChange={onChange}
      />,
    );
    await click(q('[role="tab"][aria-controls="agent-tabpanel-permissions"]'));
    expect(host.innerHTML).toContain("/tmp/seed");
    await click(q('button[aria-label="폴더 모드 전환: /tmp/seed"]'));
    const patch = onChange.mock.calls.at(-1)![0] as { botPolicy?: { allowedFolders?: { mode: string }[] } };
    expect(patch.botPolicy?.allowedFolders?.[0]?.mode).toBe("ro");
  });
});
