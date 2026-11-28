import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Source contracts include closed popovers and conditional advanced settings.
// Browser focus order and third-party MDXEditor internals are outside this test.
type Element = ts.JsxElement | ts.JsxSelfClosingElement;
const files = ["IssueProperties", "ProjectProperties", "MarkdownEditor"] as const;
function elements(name: string) {
  const source = ts.createSourceFile(name, readFileSync(new URL(`../${name}.tsx`, import.meta.url), "utf8"),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const result: Element[] = [];
  function visit(node: ts.Node) {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) result.push(node);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return result;
}
function opening(element: Element) {
  return ts.isJsxElement(element) ? element.openingElement : element;
}
function tag(element: Element) {
  return opening(element).tagName.getText();
}
function attribute(element: Element, name: string) {
  return opening(element).attributes.properties.find((property): property is ts.JsxAttribute =>
    ts.isJsxAttribute(property) && property.name.getText() === name)?.initializer;
}
function literal(element: Element, name: string) {
  const value = attribute(element, name);
  return value && ts.isStringLiteral(value) ? value.text : undefined;
}
function content(element: Element) {
  return ts.isJsxElement(element) ? element.children.map((child) => child.getText()).join("").trim() : "";
}
function announced(element: Element) {
  return literal(element, "role") === "alert" || literal(element, "aria-live") === "polite";
}

describe("property and editor accessibility (Front-End-Checklist)", () => {
  for (const file of files) {
    const nodes = elements(file);
    it(`${file}: gives local buttons a non-submit type`, () => {
      const buttons = nodes.filter((node) => ["button", "Button"].includes(tag(node)));
      expect(buttons.length).toBeGreaterThan(0);
      for (const button of buttons) expect(literal(button, "type"), button.getText()).toBe("button");
    });
    it(`${file}: explicitly labels every native and draft form control`, () => {
      const controls = nodes.filter((node) => ["input", "select", "textarea", "DraftInput"].includes(tag(node)));
      expect(controls).toHaveLength(file === "IssueProperties" ? 7 : file === "ProjectProperties" ? 8 : 0);
      for (const control of controls) {
        const id = literal(control, "id");
        const hasLabel = Boolean(literal(control, "aria-label")?.trim()) || Boolean(id && nodes.some((node) =>
          tag(node) === "label" && literal(node, "htmlFor") === id && content(node)));
        expect(hasLabel, control.getText()).toBe(true);
      }
    });
    it(`${file}: labels icon-only actions explicitly`, () => {
      const icons = nodes.filter((node) => ["button", "Button"].includes(tag(node)) &&
        (/^<(?:Trash2|X)\b/.test(content(node)) || content(node).includes("copied ? <Check")));
      expect(icons).toHaveLength(file === "IssueProperties" ? 2 : file === "ProjectProperties" ? 3 : 0);
      for (const button of icons) expect(attribute(button, "aria-label"), button.getText()).toBeDefined();
    });
    it(`${file}: announces every error message container`, () => {
      const errors = nodes.filter((node) => ["p", "span", "div"].includes(tag(node)) &&
        literal(node, "className")?.includes("text-destructive") &&
        /uploadError|workspaceError|Failed/.test(content(node)));
      expect(errors).toHaveLength(file === "IssueProperties" ? 0 : file === "ProjectProperties" ? 5 : 1);
      for (const error of errors) expect(announced(error), error.getText()).toBe(true);
    });
  }

  it("exposes project toggle names and their pressed state", () => {
    const switches = elements("ProjectProperties").filter((node) => tag(node) === "button" &&
      opening(node).getText().includes("relative inline-flex h-5 w-9"));
    expect(switches).toHaveLength(2);
    for (const button of switches) {
      expect(literal(button, "aria-label")?.trim()).toBeTruthy();
      expect(attribute(button, "aria-pressed")).toBeDefined();
    }
  });

  it("announces saving, saved, archive and image-drop feedback", () => {
    const project = elements("ProjectProperties");
    for (const message of ["Saving", "Saved"]) {
      const indicator = project.find((node) => tag(node) === "span" && content(node).endsWith(message));
      expect(indicator, message).toBeDefined();
      expect(announced(indicator!)).toBe(true);
    }
    const archive = project.find((node) => tag(node) === "Button" && content(node).includes('"Archiving..."'));
    expect(archive).toBeDefined();
    expect(announced(archive!)).toBe(true);
    const drop = elements("MarkdownEditor").find((node) => tag(node) === "div" && content(node) === "Drop image to upload");
    expect(drop).toBeDefined();
    expect(announced(drop!)).toBe(true);
  });
});
