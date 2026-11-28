// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AdapterEnvironmentTestResult, CompanySecret } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "../ui/tooltip";
import { AdapterEnvironmentResult, EnvVarEditor, ModelDropdown } from "../agent-config-form-fields";
import { NewProjectDialog } from "../NewProjectDialog";

vi.mock("../../context/DialogContext", () => ({
  useDialog: () => ({ newProjectOpen: true, closeNewProject: vi.fn() }),
}));
vi.mock("../../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1", selectedCompany: null }),
}));
vi.mock("../MarkdownEditor", () => ({ MarkdownEditor: () => <div /> }));
vi.mock("../PathInstructionsModal", () => ({ ChoosePathButton: () => null }));
vi.mock("../../api/projects", () => ({
  projectsApi: { create: vi.fn(async () => { throw new Error("Unavailable"); }) },
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let host: HTMLDivElement;
let root: Root;
let client: QueryClient;
const secret = { id: "secret-1", name: "api-token" } as CompanySecret;

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function render(node: React.ReactNode) {
  await act(async () => root.render(
    <QueryClientProvider client={client}><TooltipProvider>{node}</TooltipProvider></QueryClientProvider>,
  ));
}
function named<T extends HTMLElement>(label: string): T {
  const element = document.querySelector<T>(`[aria-label="${label}"]`);
  expect(element, label).not.toBeNull();
  return element!;
}
async function change(input: HTMLInputElement | HTMLSelectElement, value: string) {
  await act(async () => {
    const prototype = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}

describe("environment and help accessibility", () => {
  it("names plain, secret and trailing row controls without exposing secret values", async () => {
    const onChange = vi.fn();
    await render(<EnvVarEditor value={{ TOKEN: "sensitive-value", API_KEY: { type: "secret_ref", secretId: secret.id, version: "latest" } }} secrets={[secret]} onCreateSecret={vi.fn()} onChange={onChange} />);
    expect(named<HTMLInputElement>("Environment variable name, row 1").value).toBe("TOKEN");
    expect(named<HTMLInputElement>("Value for TOKEN").value).toBe("sensitive-value");
    expect(named<HTMLSelectElement>("Secret for API_KEY").value).toBe(secret.id);
    expect(named<HTMLInputElement>("Value for row 3").value).toBe("");
    for (const control of host.querySelectorAll("input, select, button")) {
      expect(control.getAttribute("aria-label") || control.textContent?.trim()).toBeTruthy();
      expect(control.getAttribute("aria-label") ?? "").not.toContain("sensitive-value");
      if (control.tagName === "BUTTON") expect(control.getAttribute("type")).toBe("button");
    }
    await change(named<HTMLSelectElement>("Value source for TOKEN"), "secret");
    expect(named<HTMLSelectElement>("Secret for TOKEN")).toBeTruthy();
    await act(async () => named<HTMLButtonElement>("Remove environment variable API_KEY").click());
    expect(document.querySelector('[aria-label="Secret for API_KEY"]')).toBeNull();
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });

  it("announces a failed secret creation and preserves the entered value", async () => {
    vi.spyOn(window, "prompt").mockReturnValue("token");
    const onCreateSecret = vi.fn().mockRejectedValue(new Error("Secret creation failed"));
    const onChange = vi.fn();
    await render(<EnvVarEditor value={{ TOKEN: "keep-me" }} secrets={[]} onCreateSecret={onCreateSecret} onChange={onChange} />);
    await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Seal")!.click());
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Secret creation failed");
    expect(named<HTMLInputElement>("Value for TOKEN").value).toBe("keep-me");
    expect(onCreateSecret).toHaveBeenCalledWith("token", "keep-me");
    expect(onChange).not.toHaveBeenCalled();
  });

  it.each(["pass", "warn", "fail"] as const)("announces %s environment test feedback", async (status) => {
    const result = { status, testedAt: "2026-11-28T00:00:00Z", checks: [{ code: "test", level: "info", message: "Environment checked" }] } as AdapterEnvironmentTestResult;
    await render(<AdapterEnvironmentResult result={result} />);
    expect(host.querySelector('[aria-live="polite"]')?.textContent).toContain("Environment checked");
  });

  it("labels model search and announces empty results", async () => {
    await render(<ModelDropdown models={[]} value="" onChange={vi.fn()} open onOpenChange={vi.fn()} allowDefault={false} required={false} groupByProvider={false} />);
    expect(named<HTMLInputElement>("Search models")).toBeTruthy();
    expect(document.querySelector('[role="status"][aria-live="polite"]')?.textContent).toBe("No models found.");
  });

  it("makes both help icons named, focusable buttons with working tooltips", async () => {
    await render(<NewProjectDialog />);
    for (const [label, text] of [["GitHub repo help", "Link a GitHub repository"], ["Local folder help", "Set an absolute path"]]) {
      const button = named<HTMLButtonElement>(label);
      expect(button.tagName).toBe("BUTTON");
      expect(button.type).toBe("button");
      await act(async () => button.focus());
      expect(document.activeElement).toBe(button);
      expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(text);
      await act(async () => button.blur());
    }
    for (const label of ["Work context name", "GitHub repo", "Local folder", "Target date"]) {
      expect(named<HTMLInputElement>(label).tagName).toBe("INPUT");
    }
    expect(named<HTMLButtonElement>("Expand work context dialog").type).toBe("button");
    expect(named<HTMLButtonElement>("Close work context dialog").type).toBe("button");
  });

  it.each([false, true])("announces work context errors (request failure: %s)", async (requestFailure) => {
    await render(<NewProjectDialog />);
    await change(named<HTMLInputElement>("Work context name"), "Example");
    if (!requestFailure) await change(named<HTMLInputElement>("Local folder"), "relative/path");
    await act(async () => [...document.querySelectorAll("button")].find((button) => button.textContent === "Create work context")!.click());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      requestFailure ? "Failed to create work context." : "Local folder must be a full absolute path.",
    );
  });
});
