import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Check every JSX branch, including mobile filters, pending actions and closed forms.
const pages = ["Costs", "Projects", "CompanySkills"] as const;
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
  if (!attribute) return undefined;
  const value = attribute.initializer;
  return value && ts.isStringLiteral(value) ? value.text : value?.getText();
}

function hasText(node: ts.Node): boolean {
  if (ts.isJsxText(node)) return node.text.trim().length > 0;
  if (ts.isJsxSelfClosingElement(node)) return false;
  if (ts.isJsxElement(node) || ts.isJsxFragment(node)) return node.children.some(hasText);
  if (ts.isJsxExpression(node)) return !!node.expression && hasText(node.expression);
  // An icon-only pending branch still needs a stable explicit name.
  if (ts.isConditionalExpression(node)) return hasText(node.whenTrue) && hasText(node.whenFalse);
  if (ts.isStringLiteralLike(node)) return node.text.trim().length > 0;
  return ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)
    || ts.isElementAccessExpression(node) || ts.isCallExpression(node);
}

describe.each(pages)("%s accessibility contracts", (page) => {
  const { openings, elements } = inspect(page);

  it("explicitly names every form/filter control, including conditional fields", () => {
    const controls = openings.filter((node) => /^(input|Input|select|Select|textarea|Textarea)$/.test(node.tagName.getText()));
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) {
      const label = attr(control, "aria-label");
      const id = attr(control, "id");
      const linkedLabel = id && openings.some((node) => node.tagName.getText() === "label" && attr(node, "htmlFor") === id);
      expect(Boolean(label?.trim() || linkedLabel), control.getText()).toBe(true);
    }
  });

  it("gives icon-only buttons explicit names and non-submitting types", () => {
    const iconButtons = elements.filter((node) => /^(button|Button)$/.test(node.openingElement.tagName.getText())
      && !node.children.some(hasText));
    expect(iconButtons).toHaveLength(page === "CompanySkills" ? 5 : 0);
    for (const element of iconButtons) {
      const button = element.openingElement;
      expect(attr(button, "aria-label"), button.getText()).toBeTruthy();
      expect(attr(button, "type"), button.getText()).toBe("button");
    }
  });

  it("announces each inline query error", () => {
    const errors = elements.filter((node) => node.children.some((child) =>
      ts.isJsxExpression(child) && child.expression?.getText().endsWith(".message"),
    ));
    expect(errors).toHaveLength(page === "Costs" ? 3 : 1);
    for (const error of errors) expect(attr(error.openingElement, "role")).toBe("alert");
  });
});

describe("dynamic status and keyboard navigation", () => {
  it.each([
    ["CompanySkills", "scanStatusMessage"],
    ["CompanySkills", "updateStatus.reason"],
    ["CompanySkills", "Up to date"],
    ["Projects", "visible.length"],
    ["Projects", "No work contexts match this filter."],
  ] as const)("announces %s: %s politely", (page, feedback) => {
    const { elements } = inspect(page);
    const banner = elements.find((node) => node.children.some((child) =>
      (ts.isJsxExpression(child) && child.expression?.getText() === feedback)
      || (ts.isJsxText(child) && child.text.trim() === feedback),
    ));
    expect(banner, feedback).toBeDefined();
    let region: ts.Node | undefined = banner;
    while (region && !(ts.isJsxElement(region) && attr(region.openingElement, "aria-live") === "polite")) {
      region = region.parent;
    }
    expect(region, `${feedback} must be inside a polite live region`).toBeDefined();
  });

  it("removes collapsed skill files from the keyboard sequence", () => {
    const { openings } = inspect("CompanySkills");
    const collapsed = openings.filter((node) => attr(node, "aria-hidden") === "{!expanded}");
    expect(collapsed).toHaveLength(1);
    expect(attr(collapsed[0], "inert")).toBe("{!expanded}");
    const toggles = openings.filter((node) => attr(node, "aria-label")?.includes("Collapse"));
    expect(toggles).toHaveLength(2);
    for (const toggle of toggles) expect(attr(toggle, "aria-expanded")).toBe("{expanded}");
  });
});
