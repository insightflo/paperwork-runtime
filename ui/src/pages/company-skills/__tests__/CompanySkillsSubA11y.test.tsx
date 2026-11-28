/** @vitest-environment jsdom */
// Front-End-Checklist: accessible names, native controls and live feedback.
import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ToolDefinition, ToolTestOutcome } from "@paperclipai/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toolDefinitionsApi } from "../../../api/tools";
import { ToolDefinitionList } from "../ToolDefinitionList";
import { ToolDefinitionEditor } from "../ToolDefinitionEditor";
import { ToolTestDialog } from "../ToolTestDialog";
import { formFromTool } from "../toolAdminModel";

vi.mock("../../../context/CompanyContext", () => ({ useCompany: () => ({ canAdmin: true }) }));
vi.mock("../../../api/tools", () => ({ toolDefinitionsApi: { test: vi.fn() } }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const tool: ToolDefinition = {
  id: "tool-1", companyId: "company-1", name: "Lookup", description: "Find a record",
  inputSchema: {}, adapterType: "builtin", adapterConfig: {}, enabled: true,
  createdAt: new Date("2026-01-01"), updatedAt: new Date("2026-01-01"),
};
let container: HTMLDivElement;
let root: Root;
let client: QueryClient;

async function mount(children: ReactNode) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await render(children);
}

async function render(children: ReactNode) {
  await act(async () => {
    root.render(<QueryClientProvider client={client}>{children}</QueryClientProvider>);
  });
}

function button(name: string, scope: ParentNode = document) {
  const found = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => (node.getAttribute("aria-label") ?? node.textContent?.trim()) === name,
  );
  expect(found, `button named ${name}`).toBeDefined();
  return found!;
}

function expectActionTypes(scope: ParentNode) {
  const actions = [...scope.querySelectorAll("button")];
  expect(actions.length).toBeGreaterThan(0);
  for (const action of actions) expect(action.getAttribute("type")).toBe("button");
}

afterEach(async () => {
  await act(async () => root?.unmount());
  client?.clear();
  container?.remove();
  vi.clearAllMocks();
});

describe("company skills subcomponent accessibility", () => {
  it("names list controls, preserves focus and avoids unintended form submission", async () => {
    const onCreate = vi.fn();
    const onSelect = vi.fn();
    const onFilterChange = vi.fn();
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
    const props: ComponentProps<typeof ToolDefinitionList> = {
      tools: [tool], filteredTools: [tool], selectedToolId: tool.id, filter: "",
      isLoading: false, error: null, onFilterChange, onSelect, onCreate,
    };
    await mount(<form onSubmit={onSubmit}><ToolDefinitionList {...props} /></form>);
    expectActionTypes(container);
    const create = button("Create tool");
    const filter = container.querySelector<HTMLInputElement>('input[aria-label="Filter tools"]')!;
    const select = button("LookupbuiltinEnabled");
    for (const control of [create, filter, select]) {
      control.focus();
      expect(document.activeElement).toBe(control);
      expect(control.tabIndex).toBe(0);
    }
    await act(async () => {
      create.click();
      select.click();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(filter, "lookup");
      filter.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(onCreate).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith(tool.id);
    expect(onFilterChange).toHaveBeenCalledWith("lookup");
    expect(onSubmit).not.toHaveBeenCalled();

    await render(<ToolDefinitionList {...props} error={new Error("Unable to load tools")} />);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Unable to load tools");
    await render(<ToolDefinitionList {...props} filteredTools={[]} />);
    expect(container.querySelector('[role="status"][aria-live="polite"]')?.textContent).toContain("No tools match");
  });

  it("keeps editor inputs named, action buttons safe and validation announced", async () => {
    const setForm = vi.fn();
    const onSave = vi.fn();
    await mount(<ToolDefinitionEditor companyId={tool.companyId} selectedTool={tool}
      form={formFromTool(tool)} setForm={setForm} formError="Tool name is required."
      isSaving={false} isDeleting={false} onSave={onSave} onToggleEnabled={vi.fn()} onDelete={vi.fn()} />);
    expectActionTypes(container);
    for (const name of ["Tool name", "Tool description", "Tool adapter type", "Tool input schema JSON", "Tool adapter config JSON"]) {
      expect(container.querySelector(`input[aria-label="${name}"], select[aria-label="${name}"], textarea[aria-label="${name}"]`)).not.toBeNull();
    }
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Tool name is required.");
    const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await act(async () => { button("Save").click(); toggle.click(); });
    expect(onSave).toHaveBeenCalledOnce();
    expect(setForm).toHaveBeenCalledWith({ ...formFromTool(tool), enabled: false });
  });

  it("associates the dialog input label and supports Escape dismissal", async () => {
    const onOpenChange = vi.fn();
    await mount(<ToolTestDialog companyId={tool.companyId} tool={tool} open onOpenChange={onOpenChange} />);
    const dialog = document.querySelector('[role="dialog"]')!;
    expectActionTypes(dialog);
    const input = dialog.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(input.labels?.[0]?.textContent?.trim()).toBe("Input JSON");
    input.focus();
    expect(document.activeElement).toBe(input);
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it.each([
    { ok: true, status: "success", httpStatus: 200, result: { found: true } },
    { ok: false, status: "failure", httpStatus: 503, error: "Service unavailable" },
    { ok: false, status: "error", httpStatus: 0, error: "Request failed" },
  ] satisfies ToolTestOutcome[])("announces $status test outcomes", async (outcome) => {
    if (outcome.status === "error") vi.mocked(toolDefinitionsApi.test).mockRejectedValueOnce(new Error(outcome.error));
    else vi.mocked(toolDefinitionsApi.test).mockResolvedValueOnce(outcome);
    await mount(<ToolTestDialog companyId={tool.companyId} tool={tool} open onOpenChange={vi.fn()} />);
    await act(async () => button("Run test").click());
    const role = outcome.ok ? "status" : "alert";
    await vi.waitFor(async () => {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      const feedback = document.querySelector(`[role="${role}"]`);
      expect(feedback?.getAttribute("aria-live")).toBe(outcome.ok ? "polite" : "assertive");
      expect(feedback?.textContent).toContain(`HTTP ${outcome.httpStatus}`);
      expect(feedback?.textContent).toContain(outcome.error ?? '"found": true');
    });
    expect(toolDefinitionsApi.test).toHaveBeenCalledWith(tool.companyId, tool.id, {});
  });
});
