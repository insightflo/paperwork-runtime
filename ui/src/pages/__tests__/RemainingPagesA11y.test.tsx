// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { OrgChart } from "../OrgChart";

const chart = vi.hoisted(() => ({
  navigate: vi.fn(), setBreadcrumbs: vi.fn(), agents: [],
  tree: [{ id: "agent-1", name: "Ada", role: "ceo", status: "active", reports: [] }],
}));
vi.mock("@/lib/router", () => ({ useNavigate: () => chart.navigate }));
vi.mock("../../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("../../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: chart.setBreadcrumbs }) }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: string[] }) => ({ data: queryKey[0] === "org" ? chart.tree : chart.agents, isLoading: false }),
}));

// Audit page-owned JSX in every conditional branch; shared components have separate ownership.
const pages = ["OrgChart", "ApprovalDetail", "MyIssues"] as const;
type Page = typeof pages[number];
type Opening = ts.JsxOpeningElement | ts.JsxSelfClosingElement;

function inspect(page: Page) {
  const source = ts.createSourceFile(`${page}.tsx`, readFileSync(
    join(__dirname, "..", `${page}.tsx`), "utf8",
  ), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const openings: Opening[] = [];
  const elements: ts.JsxElement[] = [];
  function visit(node: ts.Node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) openings.push(node);
    if (ts.isJsxElement(node)) elements.push(node);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return { openings, elements };
}

function attr(node: Opening, name: string): string | undefined {
  const attribute = node.attributes.properties.find(
    (item): item is ts.JsxAttribute => ts.isJsxAttribute(item) && item.name.getText() === name,
  );
  const value = attribute?.initializer;
  return value && ts.isStringLiteral(value) ? value.text : value?.getText();
}

describe.each(pages)("%s accessibility", (page) => {
  const { openings } = inspect(page);

  it("uses explicit non-submitting button types", () => {
    const buttons = openings.filter((node) => /^(button|Button)$/.test(node.tagName.getText()));
    expect(buttons).toHaveLength({ OrgChart: 3, ApprovalDetail: 7, MyIssues: 2 }[page]);
    for (const button of buttons) expect(attr(button, "type"), button.getText()).toBe("button");
  });

  it("explicitly names every page-owned form/filter control", () => {
    const controls = openings.filter((node) => /^(input|select|textarea)$/.test(node.tagName.getText()));
    expect(controls).toHaveLength(page === "MyIssues" ? 1 : 0);
    for (const control of controls) {
      const id = attr(control, "id");
      const label = id && openings.some((node) => node.tagName.getText() === "label" && attr(node, "htmlFor") === id);
      expect(Boolean(attr(control, "aria-label")?.trim() || label), control.getText()).toBe(true);
    }
  });
});

describe("remaining-page feedback and keyboard contracts", () => {
  it("names all chart controls, including symbolic zoom actions", () => {
    const buttons = inspect("OrgChart").openings.filter((node) => node.tagName.getText() === "button");
    expect(buttons.map((node) => attr(node, "aria-label"))).toEqual([
      "Zoom in", "Zoom out", "Fit chart to screen",
    ]);
  });

  it("makes chart agent links reachable and Enter-activated", () => {
    const card = inspect("OrgChart").openings.find((node) => node.attributes.properties.some(
      (property) => ts.isJsxAttribute(property) && property.name.getText() === "data-org-card",
    ))!;
    expect(card).toBeDefined();
    expect(attr(card, "role")).toBe("link");
    expect(attr(card, "tabIndex")).toBe("{0}");
    expect(attr(card, "aria-label")).toContain("node.name");
    expect(attr(card, "onKeyDown")).toContain('e.key === "Enter"');
    expect(attr(card, "onKeyDown")).toContain("e.currentTarget.click()");
  });

  it.each([
    ["OrgChart", "Math.round(zoom * 100)"],
    ["MyIssues", "visibleIssues.length"],
    ["ApprovalDetail", "Approval confirmed"],
    ["ApprovalDetail", 'humanLabel(lang, "approvalStatus", approval.status).label'],
  ] as const)("announces %s status: %s", (page, content) => {
    const regions = inspect(page).elements.filter((node) => attr(node.openingElement, "aria-live") === "polite");
    expect(regions.some((node) => node.children.some((child) => child.getText().includes(content)))).toBe(true);
  });

  it.each([
    ["MyIssues", "error.message"],
    ["ApprovalDetail", "Approval not found."],
    ["ApprovalDetail", "{error}"],
  ] as const)("announces %s error: %s", (page, content) => {
    const alerts = inspect(page).elements.filter((node) => attr(node.openingElement, "role") === "alert");
    expect(alerts.some((node) => node.children.some((child) => child.getText().includes(content)))).toBe(true);
  });

  it("exposes the full-request disclosure state", () => {
    const toggle = inspect("ApprovalDetail").openings.find((node) => attr(node, "aria-expanded") === "{showRawPayload}");
    expect(toggle).toBeDefined();
    expect(attr(toggle!, "type")).toBe("button");
  });
});

it("opens a focused agent with Enter and operates chart zoom using native buttons", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<OrgChart />));
    const link = host.querySelector<HTMLElement>('[role="link"][aria-label="Open agent Ada"]')!;
    link.focus();
    expect(document.activeElement).toBe(link);
    await act(async () => link.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(chart.navigate).toHaveBeenCalledExactlyOnceWith("/agents/agent-1");
    const zoom = host.querySelector('[aria-live="polite"]')!;
    const before = Number.parseInt(zoom.textContent!);
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!.click());
    expect(Number.parseInt(zoom.textContent!)).toBeGreaterThan(before);
    expect(host.querySelector('[aria-label="Zoom out"]')?.getAttribute("type")).toBe("button");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  }
});
