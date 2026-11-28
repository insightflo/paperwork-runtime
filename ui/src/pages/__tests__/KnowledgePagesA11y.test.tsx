import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Inspect all JSX branches, including closed rule editors and conditional inputs.
const pages = ["AgentWiki", "WorktreeRules", "InstanceGeneralSettings"] as const;
type Page = typeof pages[number];
type Opening = ts.JsxOpeningElement | ts.JsxSelfClosingElement;

function inspect(page: Page) {
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

describe.each(pages)("%s accessibility contracts", (page) => {
  const { openings, elements } = inspect(page);

  it("explicitly names every form/filter control", () => {
    const controls = openings.filter((node) => /^(input|Input|select|SelectTrigger|textarea)$/.test(node.tagName.getText()));
    expect(controls).toHaveLength({ AgentWiki: 1, WorktreeRules: 9, InstanceGeneralSettings: 4 }[page]);
    for (const control of controls) {
      const id = attr(control, "id");
      const linkedLabel = id && openings.some((node) => node.tagName.getText() === "label" && attr(node, "htmlFor") === id);
      expect(Boolean(attr(control, "aria-label")?.trim() || linkedLabel), control.getText()).toBe(true);
    }
  });

  it("gives icon-only actions explicit names and non-submitting types", () => {
    const icons = elements.filter((node) => /^(button|Button)$/.test(node.openingElement.tagName.getText())
      && !node.children.some(hasText));
    expect(icons).toHaveLength({ AgentWiki: 0, WorktreeRules: 5, InstanceGeneralSettings: 1 }[page]);
    for (const { openingElement: button } of icons) {
      expect(attr(button, "aria-label"), button.getText()).toBeTruthy();
      expect(attr(button, "type"), button.getText()).toBe("button");
    }
  });

  it("keeps every page-owned action keyboard-native with an explicit button type", () => {
    const buttons = openings.filter((node) => /^(button|Button)$/.test(node.tagName.getText()));
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) expect(["button", "submit"]).toContain(attr(button, "type"));
  });

  it("announces every existing error banner", () => {
    const errors = elements.filter((node) => /^(p|div)$/.test(node.openingElement.tagName.getText())
      && /text-(destructive|rose-700)/.test(attr(node.openingElement, "className") ?? ""));
    expect(errors).toHaveLength({ AgentWiki: 1, WorktreeRules: 3, InstanceGeneralSettings: 2 }[page]);
    for (const error of errors) expect(attr(error.openingElement, "role"), error.getText()).toBe("alert");
  });
});

describe("dynamic feedback and toggle state", () => {
  it.each([
    ["AgentWiki", "Loading…"],
    ["AgentWiki", "Select a company to view its wiki."],
    ["WorktreeRules", "filtered.length"],
    ["WorktreeRules", "Saving..."],
    ["InstanceGeneralSettings", "Loading general settings..."],
    ["InstanceGeneralSettings", "키 등록됨"],
  ] as const)("announces %s feedback: %s", (page, text) => {
    const { elements } = inspect(page);
    const feedback = elements.filter((node) => node.children.some((child) => child.getText().includes(text)));
    expect(feedback.length).toBeGreaterThan(0);
    expect(feedback.some((node) => attr(node.openingElement, "aria-live") === "polite")).toBe(true);
  });

  it("exposes rule expansion and enabled settings to assistive technology", () => {
    const rules = inspect("WorktreeRules").openings;
    expect(rules.some((node) => attr(node, "aria-expanded") === "{expanded}")).toBe(true);
    expect(rules.some((node) => attr(node, "aria-pressed") === "{values.enabled}")).toBe(true);
    expect(inspect("InstanceGeneralSettings").openings.some(
      (node) => attr(node, "aria-pressed") === "{censorUsernameInLogs}",
    )).toBe(true);
  });
});
