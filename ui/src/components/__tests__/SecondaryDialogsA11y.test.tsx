// @vitest-environment jsdom
import { act, type Ref } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewMissionDialog } from "../NewMissionDialog";
import {
  button, cleanup, click, dialogOpen, mountDialog, posts, previewFixture,
  requestViewFixture, selectAndPreview, setRoute, stubFetch, typeReason, waitFor,
} from "../mission-resume-dialog-test-harness";

const closeNewMission = vi.hoisted(() => vi.fn());
vi.mock("../../context/DialogContext", () => ({ useDialog: () => ({
  newMissionOpen: true, closeNewMission, newMissionDefaults: { title: "Test mission" },
}) }));
vi.mock("../../context/CompanyContext", () => ({ useCompany: () => ({
  selectedCompanyId: "company-1", selectedCompany: { name: "Company" },
}) }));
vi.mock("../../api/agents", () => ({ agentsApi: { list: async () => [{ id: "agent-1", name: "Planner" }] } }));
vi.mock("../../api/projects", () => ({ projectsApi: { list: async () => [] } }));
// Isolate the editor dependency; dialog, buttons, popovers and React Query remain real.
vi.mock("../MarkdownEditor", () => ({ MarkdownEditor: ({ ref }: { ref: Ref<HTMLDivElement> }) => (
  <div ref={ref} contentEditable suppressContentEditableWarning role="textbox" aria-label="Test editor" tabIndex={0} />
) }));

let host: HTMLDivElement | undefined;
let root: Root | undefined;
let client: QueryClient | undefined;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  closeNewMission.mockClear();
  stubFetch();
});
afterEach(async () => {
  await act(async () => root?.unmount());
  client?.clear(); host?.remove();
  root = undefined; client = undefined; host = undefined;
  await cleanup();
});
async function mountNewMission() {
  host = document.createElement("div"); document.body.append(host);
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root!.render(<QueryClientProvider client={client!}><NewMissionDialog /></QueryClientProvider>));
  await waitFor(() => !button("Create mission").disabled);
}
function dialog() { return document.querySelector<HTMLElement>('[role="dialog"]')!; }
function namedButton(name: string) {
  const result = dialog().querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
  expect(result, name).not.toBeNull();
  expect(result!.getAttribute("type")).toBe("button");
  return result!;
}
function checkNames() {
  const modal = dialog();
  expect(modal.getAttribute("aria-modal")).toBe("true");
  expect(document.getElementById(modal.getAttribute("aria-labelledby")!)?.textContent?.trim()).toBeTruthy();
  const controls = modal.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("input,select,textarea");
  expect(controls.length).toBeGreaterThan(0);
  for (const control of controls) {
    const label = [...(control.labels ?? [])].find((item) => control.id && item.htmlFor === control.id);
    expect(control.getAttribute("aria-label")?.trim() || label?.textContent?.trim(), control.outerHTML).toBeTruthy();
  }
  for (const control of modal.querySelectorAll<HTMLButtonElement>("button")) {
    expect(control.getAttribute("type"), control.outerHTML).toBe("button");
    expect(control.getAttribute("aria-label")?.trim() || control.textContent?.trim(), control.outerHTML).toBeTruthy();
    if (!control.disabled) expect(control.tabIndex).toBeGreaterThanOrEqual(0);
  }
}
async function key(target: HTMLElement, key: string, shiftKey = false) {
  await act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true })); });
}
async function checkFocusLoop() {
  const buttons = [...dialog().querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
  const first = buttons[0]!; const last = buttons.at(-1)!;
  act(() => last.focus());
  await key(last, "Tab");
  // Native controls can precede the first button in the resume dialog.
  const firstControl = dialog().querySelector<HTMLElement>("button:not(:disabled),select:not(:disabled),input:not(:disabled)")!;
  expect(document.activeElement).toBe(firstControl);
  act(() => firstControl.focus());
  await key(firstControl, "Tab", true);
  expect(document.activeElement).toBe(last);
  expect(dialog().contains(first)).toBe(true);
}

describe("secondary dialog accessibility (Front-End-Checklist)", () => {
  it("names the new mission, its title field and icon actions without submitting", async () => {
    await mountNewMission(); checkNames();
    expect(dialog().querySelector('input[aria-label="Mission title"]')).not.toBeNull();
    await click(namedButton("Expand dialog"));
    await click(namedButton("Collapse dialog"));
    await click(namedButton("Close dialog"));
    expect(closeNewMission).toHaveBeenCalledOnce();
    expect(posts()).toHaveLength(0);
  });

  it("preserves title-to-editor Tab navigation, focus containment and Escape dismissal", async () => {
    await mountNewMission();
    const title = dialog().querySelector<HTMLInputElement>("input")!;
    act(() => title.focus());
    await key(title, "Tab");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Test editor");
    await checkFocusLoop();
    await key(dialog(), "Escape");
    expect(closeNewMission).toHaveBeenCalledOnce();
  });

  it("keeps resume controls explicitly labelled and keyboard focus inside the modal", async () => {
    await mountDialog(); checkNames();
    expect(dialog().querySelectorAll("select")).toHaveLength(2);
    expect(dialog().querySelectorAll("textarea")).toHaveLength(1);
    await checkFocusLoop();
    await key(dialog(), "Escape");
    expect(dialogOpen()).toBe(false);
  });

  it.each(["blocked", "apply", "readback"])("announces %s errors with role=alert", async (failure) => {
    setRoute(async (url, init) => {
      if (url.includes("/workflow-resume-preview?")) return { status: 200, body: previewFixture(
        failure === "blocked" ? { eligible: false, snapshotToken: null, blockers: [{ code: "executed_step", message: "Cannot resume" }] } : {},
      ) };
      if (init?.method === "POST") return failure === "apply"
        ? { status: 409, body: { error: "Cannot resume" } }
        : { status: 202, body: requestViewFixture("pending_delivery") };
      return { status: 500, body: { error: "Cannot read request" } };
    });
    await mountDialog(); await selectAndPreview();
    if (failure !== "blocked") {
      typeReason("Continue the interrupted work");
      await click(button("이 지점부터 재개"));
    }
    await waitFor(() => [...dialog().querySelectorAll('[role="alert"]')].some((el) => el.textContent?.includes("Cannot")));
  });

  it("explicitly names and types the delivered-request close action", async () => {
    setRoute(async (url) => ({ status: 200, body: url.includes("/workflow-resume-preview?")
      ? previewFixture() : requestViewFixture("accepted") }));
    await mountDialog(); await selectAndPreview(); typeReason("Continue work");
    await click(button("이 지점부터 재개"));
    await waitFor(() => dialog().querySelector('button[aria-label="닫기"]') !== null);
    await click(namedButton("닫기"));
    expect(dialogOpen()).toBe(false);
  });
});
