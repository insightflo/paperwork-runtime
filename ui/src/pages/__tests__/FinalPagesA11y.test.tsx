import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Front-End-Checklist: explicit form names, native keyboard controls and feedback.
type Element = ts.JsxElement | ts.JsxSelfClosingElement;
const opening = (node: Element) => ts.isJsxElement(node) ? node.openingElement : node;
const attribute = (node: Element, name: string) => opening(node).attributes.properties.find(
  (prop): prop is ts.JsxAttribute => ts.isJsxAttribute(prop) && prop.name.getText() === name,
);
const value = (node: Element, name: string) => {
  const initializer = attribute(node, name)?.initializer;
  return initializer && ts.isStringLiteral(initializer) ? initializer.text : undefined;
};
const hasJsx = (node: ts.Node): boolean => ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)
  || ts.forEachChild(node, hasJsx) === true;
const content = (node: Element) => ts.isJsxElement(node) ? node.children.flatMap((child) => {
  if (ts.isJsxText(child)) return [child.text.trim()];
  if (ts.isJsxExpression(child) && child.expression && !hasJsx(child.expression)) return [child.expression.getText()];
  return [];
}).join(" ") : "";
function announced(node: ts.Node | undefined): boolean {
  if (!node) return false;
  if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
    if (value(node, "role") === "alert" || value(node, "aria-live") === "polite") return true;
  }
  return announced(node.parent);
}
function parse(page: string) {
  const source = ts.createSourceFile(page, readFileSync(new URL(`../${page}.tsx`, import.meta.url), "utf8"),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const elements: Element[] = [];
  function visit(node: ts.Node) {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) elements.push(node);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return elements;
}

const feedback = {
  MyIssues: ["error.message", "visibleIssues.length"],
  InviteLanding: ["Invalid invite token.", "Loading invite...", "Invite not available",
    "The first instance admin is now configured.", "Your request is pending admin approval.",
    "Sign in or create an account before submitting", "error", "acceptMutation.isPending"],
  BoardClaim: ["Invalid board claim URL.", "Loading claim challenge...", "statusQuery.error instanceof Error",
    "Claim challenge unavailable.", "This instance is now linked", "Sign in or create an account, then return",
    "claimMutation.error instanceof Error", "claimMutation.isPending"],
};

describe.each(Object.entries(feedback))("%s accessibility", (page, messages) => {
  const elements = parse(page);
  it("explicitly names every form control", () => {
    const controls = elements.filter((node) => ["input", "select", "textarea"].includes(opening(node).tagName.getText()));
    expect(controls).toHaveLength(page === "MyIssues" ? 1 : page === "InviteLanding" ? 3 : 0);
    for (const control of controls) {
      const id = value(control, "id");
      const labels = elements.filter((node) => opening(node).tagName.getText() === "label"
        && id && value(node, "htmlFor") === id);
      expect(Boolean(value(control, "aria-label")?.trim())
        || labels.some((node) => node.getText().replace(/<[^>]*>/g, "").trim().length > 0)).toBe(true);
    }
  });

  it("keeps actions native, named and explicitly non-submitting", () => {
    const buttons = elements.filter((node) => ["button", "Button"].includes(opening(node).tagName.getText())
      && !attribute(node, "asChild"));
    expect(buttons).toHaveLength(page === "BoardClaim" ? 1 : 2);
    for (const button of buttons) {
      expect(value(button, "type")).toBe("button");
      const label = button.getText().replace(/<[^>]*>/g, "").trim();
      expect(Boolean(value(button, "aria-label")) || Boolean(label)).toBe(true);
      expect(attribute(button, "tabIndex")).toBeUndefined();
    }
    const toggles = buttons.filter((node) => content(node).includes("group.label") || content(node).includes("Join as"));
    for (const toggle of toggles) expect(attribute(toggle, "aria-pressed")).toBeDefined();
  });

  it.each(messages)("announces feedback: %s", (message) => {
    const matches = elements.filter((node) => content(node).includes(message));
    expect(matches.length).toBeGreaterThan(0);
    for (const match of matches) expect(announced(match), message).toBe(true);
  });
});
