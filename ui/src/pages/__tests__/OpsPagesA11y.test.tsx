import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Inspect all JSX branches, including the closed schedule form and error states.
const pages = ["ExecutionWorkspaceDetail", "SchedulerConfig", "HumanOperator"] as const;
type Opening = ts.JsxOpeningElement | ts.JsxSelfClosingElement;

function inspect(page: typeof pages[number]) {
  const source = ts.createSourceFile(`${page}.tsx`, readFileSync(
    new URL(`../${page}.tsx`, import.meta.url), "utf8",
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

function hasText(node: ts.Node): boolean {
  if (ts.isJsxText(node)) return node.text.trim().length > 0;
  if (ts.isJsxSelfClosingElement(node)) return false;
  if (ts.isJsxElement(node) || ts.isJsxFragment(node)) return node.children.some(hasText);
  if (ts.isJsxExpression(node)) return !!node.expression && hasText(node.expression);
  if (ts.isConditionalExpression(node)) return hasText(node.whenTrue) && hasText(node.whenFalse);
  if (ts.isStringLiteralLike(node)) return node.text.trim().length > 0;
  return ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isCallExpression(node);
}

function announced(node: ts.Node | undefined): boolean {
  while (node) {
    if (ts.isJsxElement(node) && (attr(node.openingElement, "role") === "alert"
      || attr(node.openingElement, "aria-live") === "polite")) return true;
    node = node.parent;
  }
  return false;
}

describe.each(pages)("%s accessibility contracts", (page) => {
  const { openings, elements } = inspect(page);

  it("links every input and select trigger to a nonempty accessible label", () => {
    const controls = openings.filter((node) => /^(input|Input|select|SelectTrigger|textarea|Textarea)$/.test(node.tagName.getText()));
    expect(controls).toHaveLength(page === "SchedulerConfig" ? 4 : 0);
    for (const control of controls) {
      const id = attr(control, "id");
      const label = elements.find((node) => id && node.openingElement.tagName.getText() === "label"
        && attr(node.openingElement, "htmlFor") === id && node.children.some(hasText));
      expect(Boolean(attr(control, "aria-label")?.trim() || label), control.getText()).toBe(true);
    }
  });

  it("names icon-only actions and explicitly types all actual buttons", () => {
    const buttons = elements.filter((node) => /^(button|Button)$/.test(node.openingElement.tagName.getText())
      && !node.openingElement.attributes.properties.some((item) => ts.isJsxAttribute(item) && item.name.getText() === "asChild"));
    const icons = buttons.filter((node) => !node.children.some(hasText));
    expect(icons).toHaveLength(page === "SchedulerConfig" ? 2 : 0);
    for (const button of buttons) {
      expect(attr(button.openingElement, "type"), button.getText()).toBe(
        button.children.some((node) => node.getText().includes("Create schedule")) ? "submit" : "button",
      );
    }
    for (const icon of icons) expect(attr(icon.openingElement, "aria-label"), icon.getText()).toBeTruthy();
  });

  it("announces query and validation errors, including nested feedback", () => {
    const errors = elements.filter((node) => node.children.some((child) => ts.isJsxExpression(child)
      && ((child.expression && ts.isConditionalExpression(child.expression)
        && child.expression.whenTrue.getText() === "error.message") || child.expression?.getText() === "formError")));
    expect(errors).toHaveLength(page === "SchedulerConfig" ? 2 : 1);
    for (const error of errors) expect(announced(error), error.getText()).toBe(true);
  });

  it("keeps keyboard controls in natural tab order", () => {
    for (const node of openings) {
      expect(Number(attr(node, "tabIndex")?.replace(/[{}]/g, "") ?? 0), node.getText()).toBeLessThanOrEqual(0);
    }
  });
});

describe("operations status announcements", () => {
  it.each([
    ["ExecutionWorkspaceDetail", "Loading..."],
    ["SchedulerConfig", "{strip.map"],
    ["HumanOperator", "{displayedLabel}"],
    ["HumanOperator", "{decision.status ==="],
  ] as const)("announces %s updates: %s", (page, feedback) => {
    const banner = inspect(page).elements.find((node) => node.children.some((child) =>
      (ts.isJsxExpression(child) || ts.isJsxText(child)) && child.getText().includes(feedback)));
    expect(banner, feedback).toBeDefined();
    expect(announced(banner), feedback).toBe(true);
  });

  it("announces both mission loading/stale notices and mission errors", () => {
    const notice = inspect("HumanOperator").elements.find((node) => node.children.some((child) => child.getText() === "{missionStatusNotice}"));
    expect(notice).toBeDefined();
    expect(attr(notice!.openingElement, "role")).toBe('{missionsQuery.isError ? "alert" : "status"}');
    expect(attr(notice!.openingElement, "aria-live")).toBe('{missionsQuery.isError ? undefined : "polite"}');
  });
});
