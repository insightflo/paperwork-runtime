import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Static Front-End-Checklist audit for the wave's surviving governance page.
// Goals.tsx / GoalDetail.tsx no longer exist: the /goals routes were removed in
// "Phase 0-3 Goals Wave 2" and are guarded by src/__tests__/goals-w2-removed-routes.test.tsx,
// so Approvals is the only page in this wave to audit. Source-level inspection sees every
// JSX branch including closed/error states; live focus and screen-reader behaviour are
// outside this audit.
const pages = ["Approvals"];
type Opening = ts.JsxOpeningElement | ts.JsxSelfClosingElement;

function inspect(name: string) {
  const source = ts.createSourceFile(
    `${name}.tsx`,
    readFileSync(new URL(`../${name}.tsx`, import.meta.url), "utf8"),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX,
  );
  const nodes: Opening[] = [];
  function visit(node: ts.Node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) nodes.push(node);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return nodes;
}

function attribute(node: Opening, name: string) {
  return node.attributes.properties.find(
    (prop): prop is ts.JsxAttribute => ts.isJsxAttribute(prop) && prop.name.getText() === name,
  );
}

function literal(node: Opening, name: string) {
  const value = attribute(node, name)?.initializer;
  return value && ts.isStringLiteral(value) ? value.text : undefined;
}

function hasName(node: Opening) {
  const value = attribute(node, "aria-label")?.initializer;
  if (!value) return false;
  return ts.isStringLiteral(value)
    ? value.text.trim().length > 0
    : ts.isJsxExpression(value) && !!value.expression && value.expression.getText().trim().length > 0;
}

// Text an assistive-technology accessible name can come from. Unknown runtime
// expressions may render text, so they count; `aria-hidden` subtrees do not.
function visibleText(node: ts.Node): boolean {
  if (ts.isJsxText(node)) return node.getText().trim().length > 0;
  if (ts.isJsxExpression(node)) {
    const expr = node.expression;
    if (!expr) return false;
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.getText().trim().length > 0;
    if (ts.isJsxElement(expr) || ts.isJsxSelfClosingElement(expr) || ts.isJsxFragment(expr)) return visibleText(expr);
    return true;
  }
  if (ts.isJsxElement(node)) {
    return boolAttr(node.openingElement, "aria-hidden") !== true && node.children.some(visibleText);
  }
  if (ts.isJsxSelfClosingElement(node)) {
    if (boolAttr(node, "aria-hidden") === true) return false;
    return hasName(node);
  }
  if (ts.isJsxFragment(node)) return node.children.some(visibleText);
  return false;
}

function boolAttr(node: Opening, name: string) {
  const attr = attribute(node, name);
  if (!attr) return undefined;
  if (!attr.initializer) return true; // bare JSX attribute shorthand
  return ts.isStringLiteral(attr.initializer) ? attr.initializer.text === "true" : undefined;
}

describe.each(pages)("%s accessibility and forms", (name) => {
  const nodes = inspect(name);
  const tag = (node: Opening) => node.tagName.getText();

  it("explicitly names every native form control", () => {
    const controls = nodes.filter((node) => ["input", "textarea", "select"].includes(tag(node)));
    for (const control of controls) {
      const id = literal(control, "id");
      const labelled = !!id && nodes.some(
        (node) => tag(node) === "label" && literal(node, "htmlFor") === id,
      );
      expect(hasName(control) || labelled, control.getText()).toBe(true);
    }
  });

  it("gives buttons explicit non-submit types and accessible names", () => {
    const buttons = nodes.filter((node) => ["button", "Button"].includes(tag(node)));
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      expect(literal(button, "type"), button.getText()).toBe("button");
      // Icon-only buttons need aria-label; text-bearing buttons may rely on content.
      const element = ts.isJsxOpeningElement(button) ? button.parent : undefined;
      const hasText = !!element && ts.isJsxElement(element) && element.children.some(visibleText);
      expect(hasName(button) || hasText, button.getText()).toBe(true);
    }
  });

  it("announces every inline error banner as an alert", () => {
    const errors = nodes.filter((node) =>
      ["p", "span"].includes(tag(node)) && literal(node, "className")?.includes("text-destructive"),
    );
    expect(errors).toHaveLength(2);
    for (const error of errors) expect(literal(error, "role"), error.getText()).toBe("alert");
  });
});
