// @vitest-environment jsdom — Stage30 W5: 4-tab AgentConfigForm + OpenBot botPolicy tabs.
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@paperclipai/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AgentBehaviorTab, normalizeBotPolicy, parseServerNames, updatePolicyField, type AgentBotPolicy } from "./agent-settings/AgentBehaviorTab";
import { AgentPermissionsFoldersTab, addFolderGrant } from "./agent-settings/AgentPermissionsFoldersTab";
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
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
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
async function setSelect(el: HTMLSelectElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(el, value); el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
async function click(el: Element) {
  await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
}
/** Policy tab with live state feedback, mirroring how AgentConfigForm feeds policy back. */
function ControlledPolicy({ Tab, initial, spy }: {
  Tab: (props: { policy: AgentBotPolicy; onChange: (p: AgentBotPolicy) => void }) => ReactNode;
  initial: AgentBotPolicy; spy: (p: AgentBotPolicy) => void;
}) {
  const [policy, setPolicy] = useState(initial);
  return <Tab policy={policy} onChange={(next) => { spy(next); setPolicy(next); }} />;
}
async function expectMounted(node: ReactNode, texts: string[]) {
  await mount(node);
  for (const text of texts) expect(host.innerHTML).toContain(text);
}
const samplePolicy: AgentBotPolicy = {
  accessLevel: "full", allowedFolders: [{ path: "/tmp/allow", mode: "ro" }],
  mcpAccess: { mode: "allowlist", servers: ["mcp-a", "mcp-b"] }, fastMode: true,
};
describe("botPolicy helpers", () => {
  it("addFolderGrant trims and rejects empty/duplicates; parseServerNames/normalize stay clean", () => {
    const base = [{ path: "/tmp/a", mode: "ro" as const }];
    expect(addFolderGrant([], "  ", "rw")).toEqual({ ok: false, reason: "empty" });
    expect(addFolderGrant(base, " /tmp/a ", "rw")).toEqual({ ok: false, reason: "duplicate" });
    expect(addFolderGrant(base, " /tmp/b ", "rw")).toEqual({
      ok: true, grants: [{ path: "/tmp/a", mode: "ro" }, { path: "/tmp/b", mode: "rw" }],
    });
    expect(base[0].mode).toBe("ro");
    expect(parseServerNames(" a, b ,,c ")).toEqual(["a", "b", "c"]);
    expect(normalizeBotPolicy({
      accessLevel: "bogus", allowedFolders: [{ path: " /x ", mode: "rw" }, { path: 42 }, null],
      fastMode: true, memoryLimit: "12", hackerKey: true, mcpAccess: { mode: "denylist", servers: ["s", 3, "t"] },
    })).toEqual({ allowedFolders: [{ path: "/x", mode: "rw" }], fastMode: true, mcpAccess: { mode: "denylist", servers: ["s", "t"] } });
    expect(updatePolicyField({ fastMode: true }, "fastMode", undefined)).toEqual({});
    expect(updatePolicyField({}, "memoryLimit", null)).toEqual({ memoryLimit: null });
  });
});
describe("AgentPermissionsFoldersTab", () => {
  it("renders access level, folder rows with mode/delete controls; hides MCP input in allow_all", async () => {
    await expectMounted(<AgentPermissionsFoldersTab policy={samplePolicy} onChange={vi.fn()} />, [
      "접근 권한", "전체 허용", "허용 작업 폴더", "/tmp/allow", "읽기 전용",
      'aria-label="폴더 모드 전환: /tmp/allow"', 'aria-label="폴더 삭제: /tmp/allow"', 'aria-label="MCP 서버 이름"', "mcp-a, mcp-b",
    ]);
    await mount(<AgentPermissionsFoldersTab policy={{ mcpAccess: { mode: "allow_all", servers: [] } }} onChange={vi.fn()} />);
    expect(host.innerHTML).not.toContain('aria-label="MCP 서버 이름"');
  });

  it("adds a folder entry once (dedupe) and removes it via the row button", async () => {
    const onChange = vi.fn();
    await mount(<ControlledPolicy Tab={AgentPermissionsFoldersTab} initial={samplePolicy} spy={onChange} />);
    await setInput(q<HTMLInputElement>('input[aria-label="새 폴더 경로"]'), "/tmp/demo");
    await click(q('button[aria-label="폴더 추가"]'));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0].allowedFolders).toEqual([{ path: "/tmp/allow", mode: "ro" }, { path: "/tmp/demo", mode: "ro" }]);
    await setInput(q<HTMLInputElement>('input[aria-label="새 폴더 경로"]'), "/tmp/demo");
    await click(q('button[aria-label="폴더 추가"]'));
    expect(onChange).toHaveBeenCalledTimes(1);
    await click(q('button[aria-label="폴더 삭제: /tmp/demo"]'));
    expect(onChange.mock.calls[1][0].allowedFolders).toEqual([{ path: "/tmp/allow", mode: "ro" }]);
  });
  it("toggles folder ro→rw and updates accessLevel and mcpAccess from controls", async () => {
    const onChange = vi.fn();
    await mount(<ControlledPolicy Tab={AgentPermissionsFoldersTab} initial={samplePolicy} spy={onChange} />);
    await click(q('button[aria-label="폴더 모드 전환: /tmp/allow"]'));
    expect(onChange.mock.calls[0][0].allowedFolders).toEqual([{ path: "/tmp/allow", mode: "rw" }]);
    await setSelect(q<HTMLSelectElement>('select[aria-label="접근 권한"]'), "ask");
    expect(onChange.mock.calls[1][0].accessLevel).toBe("ask");
    await setSelect(q<HTMLSelectElement>('select[aria-label="MCP 서버 접근"]'), "denylist");
    expect(onChange.mock.calls[2][0].mcpAccess).toEqual({ mode: "denylist", servers: ["mcp-a", "mcp-b"] });
  });
});
describe("AgentBehaviorTab", () => {
  it("updates busyMessagePolicy, notificationLevel, fastMode and memoryLimit (empty → null)", async () => {
    const onChange = vi.fn();
    await mount(<ControlledPolicy Tab={AgentBehaviorTab} initial={{}} spy={onChange} />);
    await setSelect(q<HTMLSelectElement>('select[aria-label="작업 중 새 메시지 처리"]'), "steer");
    expect(onChange.mock.calls[0][0].busyMessagePolicy).toBe("steer");
    await setSelect(q<HTMLSelectElement>('select[aria-label="알림 강도"]'), "muted");
    expect(onChange.mock.calls[1][0].notificationLevel).toBe("muted");
    await click(q('button[aria-label="Fast Mode (빠른 응답 우선)"]'));
    expect(onChange.mock.calls[2][0].fastMode).toBe(true);
    await setInput(q<HTMLInputElement>('input[aria-label="최대 메모리 항목"]'), "50");
    expect(onChange.mock.calls[3][0].memoryLimit).toBe(50);
    await setInput(q<HTMLInputElement>('input[aria-label="최대 메모리 항목"]'), "");
    expect(onChange.mock.calls[4][0].memoryLimit).toBeNull();
  });
});

describe("AgentConfigForm 4-tab layout", () => {
  const createForm = (onChange = vi.fn()) => (
    <AgentConfigForm mode="create" values={{ ...defaultCreateValues }} onChange={onChange} />
  );
  it("renders a 4-tab tablist with basic selected and only the basic panel mounted", async () => {
    await mount(createForm());
    const html = host.innerHTML;
    expect((html.match(/role="tab"/g) ?? []).length).toBe(4);
    for (const text of ["기본 · 모델", "권한 · 폴더", "협업 · 실행", "고급 · 환경"]) expect(html).toContain(text);
    expect(html).toContain('aria-selected="true"');
    expect((html.match(/role="tabpanel"/g) ?? []).length).toBe(1);
    expect(html).toContain("자동 폴백 전환");
    expect(html).not.toContain("허용 작업 폴더");
    expect(html).not.toContain("Extra args");
  });
  it("progressively discloses permissions, behavior (with heartbeat child) and advanced panels", async () => {
    await mount(createForm());
    await click(q('[role="tab"][aria-controls="agent-tabpanel-permissions"]'));
    expect(host.querySelector('[role="tabpanel"]')!.textContent).toContain("허용 작업 폴더");
    await click(q('[role="tab"][aria-controls="agent-tabpanel-behavior"]'));
    const behavior = host.querySelector('[role="tabpanel"]')!.textContent ?? "";
    expect(behavior).toContain("작업 중 새 메시지 처리");
    expect(behavior).toContain("Heartbeat on interval");
    await click(q('[role="tab"][aria-controls="agent-tabpanel-advanced"]'));
    expect(host.querySelector('[role="tabpanel"]')!.textContent).toContain("Extra args");
  });
  it("persists edited botPolicy via the adapterConfig overlay patch on save", async () => {
    const onSave = vi.fn();
    const agent = {
      id: "a1", name: "Alpha", title: null, reportsTo: null, capabilities: "",
      adapterType: "claude_local", adapterConfig: {}, agentConfig: {}, runtimeConfig: {}, metadata: {},
    } as unknown as Agent;
    await mount(<AgentConfigForm mode="edit" agent={agent} onSave={onSave} />);
    await click(q('[role="tab"][aria-controls="agent-tabpanel-permissions"]'));
    await setInput(q<HTMLInputElement>('input[aria-label="새 폴더 경로"]'), "/tmp/demo");
    await click(q('button[aria-label="폴더 추가"]'));
    const saveButton = [...host.querySelectorAll("button")].find((b) => b.textContent === "Save");
    expect(saveButton).toBeDefined(); await click(saveButton!);
    expect(onSave).toHaveBeenCalledTimes(1);
    const patch = onSave.mock.calls[0][0] as { adapterConfig: { botPolicy: AgentBotPolicy } };
    expect(patch.adapterConfig.botPolicy.allowedFolders).toEqual([{ path: "/tmp/demo", mode: "ro" }]);
  });
});
