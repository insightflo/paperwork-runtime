import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Inspect every JSX branch, including closed popovers and staged-file actions.
// This checks the explicit contracts requested by Front-End-Checklist;
// browser focus management and shared editor internals are outside this audit.
const dialogs = ["NewIssueDialog", "NewProjectDialog", "NewAgentDialog"];
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
  )?.initializer;
}

function literal(node: Opening, name: string) {
  const value = attribute(node, name);
  return value && ts.isStringLiteral(value) ? value.text : undefined;
}

function hasName(node: Opening) {
  const value = attribute(node, "aria-label");
  if (!value) return false;
  return ts.isStringLiteral(value)
    ? value.text.trim().length > 0
    : ts.isJsxExpression(value) && !!value.expression && value.expression.getText().trim().length > 0;
}

describe.each(dialogs)("%s accessibility and forms", (name) => {
  const nodes = inspect(name);
  const tag = (node: Opening) => node.tagName.getText();

  it("explicitly names every native form control", () => {
    const controls = nodes.filter((node) => ["input", "textarea", "select"].includes(tag(node)));
    if (name !== "NewAgentDialog") expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) {
      const id = literal(control, "id");
      const labelled = !!id && nodes.some(
        (node) => tag(node) === "label" && literal(node, "htmlFor") === id,
      );
      expect(hasName(control) || labelled, control.getText()).toBe(true);
    }
  });

  it("gives buttons explicit non-submit types and accessible labels", () => {
    const buttons = nodes.filter((node) => ["button", "Button"].includes(tag(node)));
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      expect(literal(button, "type"), button.getText()).toBe("button");
      expect(hasName(button), button.getText()).toBe(true);
    }
  });

  it("announces every inline error banner as an alert", () => {
    const errors = nodes.filter((node) =>
      ["p", "span"].includes(tag(node)) && literal(node, "className")?.includes("text-destructive"),
    );
    expect(errors).toHaveLength(name === "NewIssueDialog" ? 1 : name === "NewProjectDialog" ? 2 : 0);
    for (const error of errors) expect(literal(error, "role"), error.getText()).toBe("alert");
  });
});
