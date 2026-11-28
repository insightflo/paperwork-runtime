// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunButton, PauseResumeButton } from "../AgentActionButtons";
import { CompanyDataStorageSettings } from "../CompanyDataStorageSettings";
import { AgentPermissionsFoldersTab } from "../agent-settings/AgentPermissionsFoldersTab";

const state = vi.hoisted(() => ({
  storageError: false, secretsError: false, saveError: false, connectionOk: true,
  config: {
    provider: "s3", endpoint: "https://storage.example.test", region: "us-east-1",
    bucket: "data", keyPrefix: "company", forcePathStyle: false,
    accessKeySecretId: "access", secretAccessKeySecretId: "secret",
  },
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: readonly string[] }) => ({
    data: queryKey[0] === "company-data-storage" ? state.config : [],
    isPending: false,
    isError: queryKey[0] === "company-data-storage" ? state.storageError : state.secretsError,
  }),
  useMutation: ({ onSuccess }: { onSuccess?: (result: unknown) => void }) => ({
    isPending: false, isError: state.saveError, error: new Error("Save failed"),
    mutate: () => onSuccess?.({ ok: state.connectionOk, provider: "s3", error: "Connection failed" }),
  }),
  useQueryClient: () => ({ invalidateQueries: vi.fn(), setQueryData: vi.fn() }),
}));
vi.mock("../../context/ToastContext", () => ({ useToast: () => ({ pushToast: vi.fn() }) }));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.assign(state, { storageError: false, secretsError: false, saveError: false, connectionOk: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
async function mount(node: ReactNode) { await act(async () => root.render(node)); }
function button(text: string) {
  const found = Array.from(host.querySelectorAll("button")).find((el) => el.textContent?.includes(text));
  expect(found, `button: ${text}`).toBeDefined();
  return found!;
}
function expectNamedControls() {
  const controls = host.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input, select");
  expect(controls.length).toBeGreaterThan(0);
  for (const control of controls) {
    const name = control.getAttribute("aria-label") ??
      Array.from(control.labels ?? []).map((label) => label.textContent).join(" ");
    expect(name.trim(), control.outerHTML).not.toBe("");
  }
  for (const control of host.querySelectorAll("button")) {
    expect(control.getAttribute("type")).toBe("button");
    expect((control.getAttribute("aria-label") ?? control.textContent ?? "").trim()).not.toBe("");
  }
}

describe("agent action and storage accessibility", () => {
  it.each(["Run now", "Run diagnostic", "Pause", "Resume"])(
    "%s keeps its name when the mobile label is hidden and does not submit a form", async (name) => {
      const onClick = vi.fn();
      const onSubmit = vi.fn((event) => event.preventDefault());
      await mount(<form onSubmit={onSubmit}>
        {name === "Pause" || name === "Resume"
          ? <PauseResumeButton isPaused={name === "Resume"} onPause={onClick} onResume={onClick} />
          : <RunButton onClick={onClick} label={name} />}
      </form>);
      const action = host.querySelector("button")!;
      const label = action.querySelector<HTMLElement>("span")!;
      expect(label.className).toBe("hidden sm:inline");
      label.style.display = "none"; // Model the narrow-screen presentation.
      expect(action.getAttribute("aria-label")).toBe(name);
      expect(action.getAttribute("type")).toBe("button");
      await act(async () => action.click());
      expect(onClick).toHaveBeenCalledOnce();
      expect(onSubmit).not.toHaveBeenCalled();
    },
  );

  it.each(["run", "pause", "resume"])("preserves disabled %s actions", async (action) => {
    const onClick = vi.fn();
    await mount(action === "run" ? <RunButton onClick={onClick} disabled /> :
      <PauseResumeButton isPaused={action === "resume"} onPause={onClick} onResume={onClick} disabled />);
    const control = host.querySelector("button")!;
    expect(control.disabled).toBe(true);
    expect(control.getAttribute("aria-label")).toBeTruthy();
    await act(async () => control.click());
    expect(onClick).not.toHaveBeenCalled();
  });

  it.each(["New access-key secret", "New secret-access-key secret"])(
    "names the storage controls and the fields opened by %s", async (action) => {
      await mount(<CompanyDataStorageSettings companyId="company-1" />);
      expectNamedControls();
      await act(async () => button(action).click());
      expectNamedControls();
      expect(host.querySelector('input[aria-label="Secret name"]')).not.toBeNull();
      expect(host.querySelector('input[type="password"][aria-label="Secret value"]')).not.toBeNull();
      await act(async () => button("Cancel").click());
      expect(host.querySelector('input[type="password"]')).toBeNull();
    },
  );

  it.each([
    ["storageError", "Current shared-data settings could not be loaded."],
    ["secretsError", "Saved secrets could not be loaded."],
    ["saveError", "Save failed"],
  ] as const)("announces %s as an alert", async (key, message) => {
    state[key] = true;
    await mount(<CompanyDataStorageSettings companyId="company-1" />);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(message);
  });

  it.each([true, false])("announces connection results (success: %s)", async (ok) => {
    state.connectionOk = ok;
    await mount(<CompanyDataStorageSettings companyId="company-1" />);
    await act(async () => button("Test saved shared-data connection").click());
    expect(host.querySelector(`[role="${ok ? "status" : "alert"}"]`)?.textContent)
      .toContain(ok ? "Shared-data connection verified." : "Connection failed");
  });

  it.each(["allow_all", "allowlist", "denylist"] as const)(
    "preserves named permission controls in %s mode", async (mode) => {
      await mount(<AgentPermissionsFoldersTab policy={{
        allowedFolders: [{ path: "/workspace", mode: "ro" }], mcpAccess: { mode, servers: [] },
      }} onChange={vi.fn()} />);
      expectNamedControls();
      expect(host.querySelector('[aria-label="폴더 삭제: /workspace"]')).not.toBeNull();
      expect(host.querySelector('[aria-label="MCP 서버 이름"]') !== null).toBe(mode !== "allow_all");
    },
  );
});
