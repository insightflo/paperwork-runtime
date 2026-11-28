// @vitest-environment jsdom
import { act, type ComponentProps, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityEvent, Issue } from "@paperclipai/shared";
import { IssuesList } from "../IssuesList";
import { ActivityRow } from "../ActivityRow";
import { EntityRow } from "../EntityRow";
import { queryKeys } from "../../lib/queryKeys";

const api = vi.hoisted(() => ({ session: vi.fn(), labels: vi.fn(), search: vi.fn(), newIssue: vi.fn() }));
vi.mock("../../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1", selectedCompany: null }),
}));
vi.mock("../../context/DialogContext", () => ({ useDialog: () => ({ openNewIssue: api.newIssue }) }));
vi.mock("../../api/auth", () => ({ authApi: { getSession: api.session } }));
vi.mock("../../api/issues", () => ({ issuesApi: { list: api.search, listLabels: api.labels } }));

const issue: Issue = {
  id: "issue-1", companyId: "company-1", identifier: "TEST-1", issueNumber: 1,
  title: "Review accessibility", status: "todo", priority: "medium", description: null,
  projectId: null, projectWorkspaceId: null, goalId: null, parentId: null,
  assigneeAgentId: null, assigneeUserId: null, checkoutRunId: null, executionRunId: null,
  executionAgentNameKey: null, executionLockedAt: null, createdByAgentId: null, createdByUserId: null,
  requestDepth: 0, billingCode: null, assigneeAdapterOverrides: null, executionWorkspaceId: null,
  executionWorkspacePreference: null, executionWorkspaceSettings: null,
  startedAt: null, completedAt: null, cancelledAt: null, hiddenAt: null,
  createdAt: new Date("2026-01-01"), updatedAt: new Date("2026-01-01"),
};
const event: ActivityEvent = {
  id: "activity-1", companyId: "company-1", actorType: "user", actorId: "user-1",
  action: "issue.created", entityType: "issue", entityId: issue.id,
  agentId: null, runId: null, details: null, createdAt: issue.createdAt,
};
let host: HTMLDivElement;
let root: Root;
let client: QueryClient;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  localStorage.clear();
  api.session.mockResolvedValue({ user: { id: "user-1" } });
  api.labels.mockResolvedValue([{ id: "label-1", name: "Accessibility", color: "blue" }]);
  api.search.mockResolvedValue([issue]);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(queryKeys.auth.session, { user: { id: "user-1" } });
  client.setQueryData(queryKeys.issues.labels("company-1"), [{ id: "label-1", name: "Accessibility", color: "blue" }]);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  host.remove();
});
async function render(element: ReactElement) {
  await act(async () => root.render(
    <QueryClientProvider client={client}><MemoryRouter>{element}<LocationProbe /></MemoryRouter></QueryClientProvider>,
  ));
}
function LocationProbe() {
  return <output data-current-path={useLocation().pathname} />;
}
async function renderList(props: Partial<ComponentProps<typeof IssuesList>> = {}) {
  await render(<IssuesList issues={[issue]} viewStateKey="a11y-list" onUpdateIssue={vi.fn()}
    agents={[{ id: "agent-1", name: "Reviewer" }]} projects={[{ id: "project-1", name: "Website" }]}
    {...props} />);
}
function button(name: string): HTMLButtonElement {
  const found = document.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
  expect(found, name).not.toBeNull();
  return found!;
}
async function click(element: HTMLElement) {
  await act(async () => element.click());
}
async function press(element: HTMLElement, key: string) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  await act(async () => element.dispatchEvent(event));
  return event;
}
function expectExplicitFieldNames() {
  const fields = document.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
    'input:not([aria-hidden="true"]),select',
  );
  expect(fields.length).toBeGreaterThan(0);
  for (const field of fields) {
    const label = [...(field.labels ?? [])].find((item) => field.id && item.htmlFor === field.id);
    expect(field.getAttribute("aria-label")?.trim() || label?.textContent?.trim(), field.outerHTML).toBeTruthy();
  }
}

describe("IssuesList accessibility", () => {
  it("names search and responsive icon controls, and exposes the active view", async () => {
    await renderList();
    expectExplicitFieldNames();
    expect(host.querySelector('input[aria-label="Search work"]')).not.toBeNull();
    for (const name of ["New Work Item", "List view", "Board view", "Filter", "Sort", "Group"]) {
      expect(button(name).getAttribute("type"), name).toBe("button");
    }
    expect(button("List view").getAttribute("aria-pressed")).toBe("true");
    expect(button("Board view").getAttribute("aria-pressed")).toBe("false");
    await click(button("Board view"));
    expect(button("Board view").getAttribute("aria-pressed")).toBe("true");
    await click(button("List view"));
    expect(button("List view").getAttribute("aria-pressed")).toBe("true");
  });

  it("names every filter including optional user, agent, label and project choices", async () => {
    await renderList();
    await click(button("Filter"));
    const choices = [...document.querySelectorAll('button[role="checkbox"]')];
    expect(choices.length).toBeGreaterThan(10);
    for (const choice of choices) expect(choice.getAttribute("aria-label")?.trim()).toBeTruthy();
    for (const name of ["Assignee: No assignee", "Assignee: Me", "Assignee: Reviewer",
      "Label: Accessibility", "Work Context: Website"]) expect(button(name)).toBeTruthy();
    await click(button("Status: Todo"));
    expect(button("Status: Todo").getAttribute("aria-checked")).toBe("true");
    expect(button("Filters: 1")).toBeTruthy();
  });

  it("labels the assignee search inside the real picker and preserves assignment", async () => {
    const update = vi.fn();
    await renderList({ onUpdateIssue: update });
    const trigger = [...host.querySelectorAll("button")].find((item) => item.textContent?.trim() === "Assignee");
    expect(trigger).toBeDefined();
    expect(trigger!.getAttribute("type")).toBe("button");
    await click(trigger!);
    expect(host.querySelector("[data-current-path]")?.getAttribute("data-current-path")).toBe("/");
    expectExplicitFieldNames();
    expect(document.querySelector('input[aria-label="Search assignees"]')).not.toBeNull();
    const choice = [...document.querySelectorAll("button")].find((item) => item.textContent?.includes("Reviewer"));
    expect(choice).toBeDefined();
    await click(choice!);
    expect(update).toHaveBeenCalledWith(issue.id, { assigneeAgentId: "agent-1", assigneeUserId: null });
    expect(host.querySelector("[data-current-path]")?.getAttribute("data-current-path")).toBe("/");
  });

  it("names group add buttons and preserves group-specific creation", async () => {
    await renderList();
    await click(button("Group"));
    const status = [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === "Status");
    expect(status).toBeDefined();
    await click(status!);
    const add = button("New Work Item in Todo");
    expect(add.getAttribute("type")).toBe("button");
    await click(add);
    expect(api.newIssue).toHaveBeenCalledWith({ status: "todo" });
  });

  it("announces loading, errors and empty results", async () => {
    await renderList({ issues: [], isLoading: true });
    expect(host.querySelector('[role="status"][aria-live="polite"][aria-label="Loading work items"]')).not.toBeNull();
    await renderList({ issues: [], error: new Error("Could not load work items") });
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Could not load work items");
    expect(host.querySelector('[aria-live="polite"]')?.textContent).toContain("No work items match");
  });

  it("does not submit an enclosing form when toolbar actions are clicked", async () => {
    const submit = vi.fn((e) => e.preventDefault());
    await render(<form onSubmit={submit}><IssuesList issues={[issue]} viewStateKey="form-a11y"
      onUpdateIssue={vi.fn()} /></form>);
    await click(button("New Work Item"));
    await click(button("Board view"));
    await click(button("List view"));
    expect(api.newIssue).toHaveBeenCalledTimes(1);
    expect(submit).not.toHaveBeenCalled();
  });
});

describe("interactive rows", () => {
  it("makes callback rows focusable and activates them with Enter, Space and click", async () => {
    const activate = vi.fn();
    await render(<EntityRow title="Review task" onClick={activate} />);
    const row = host.querySelector<HTMLElement>('[role="button"]')!;
    expect(row).not.toBeNull();
    expect(row.tabIndex).toBe(0);
    row.focus();
    expect(document.activeElement).toBe(row);
    expect((await press(row, "Enter")).defaultPrevented).toBe(true);
    expect((await press(row, " ")).defaultPrevented).toBe(true);
    await press(row, "Escape");
    await click(row);
    expect(activate).toHaveBeenCalledTimes(3);
  });

  it("does not activate the row for keyboard events from a nested control", async () => {
    const activate = vi.fn();
    await render(<EntityRow title="Review task" onClick={activate} trailing={<input aria-label="Note" />} />);
    const event = await press(host.querySelector("input")!, " ");
    expect(event.defaultPrevented).toBe(false);
    expect(activate).not.toHaveBeenCalled();
  });

  it("preserves native link semantics when a destination is supplied", async () => {
    const activate = vi.fn();
    await render(<EntityRow title="Review task" to="/issues/TEST-1" onClick={activate} />);
    const link = host.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("/issues/TEST-1");
    expect(link.getAttribute("role")).toBeNull();
    expect(link.textContent).toContain("Review task");
    await click(link);
    expect(activate).toHaveBeenCalledTimes(1);
  });

  it("keeps read-only entity and activity rows out of the tab order", async () => {
    await render(<><EntityRow title="Read-only" /><ActivityRow event={{ ...event, entityType: "company" }}
      agentMap={new Map()} entityNameMap={new Map()} /></>);
    expect(host.querySelector('a,button,[role="button"],[tabindex]')).toBeNull();
    expect(host.textContent).toContain("Read-only");
    expect(host.textContent).toContain("Board");
  });

  it("uses a named native link for activity navigation", async () => {
    await render(<ActivityRow event={event} agentMap={new Map()}
      entityNameMap={new Map([[`issue:${issue.id}`, "TEST-1"]])}
      entityTitleMap={new Map([[`issue:${issue.id}`, issue.title]])} />);
    const link = host.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("/issues/TEST-1");
    expect(link.textContent).toContain("TEST-1");
    expect(link.textContent).toContain(issue.title);
    expect(link.getAttribute("role")).toBeNull();
  });
});
