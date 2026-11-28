import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const sourceRoot = fileURLToPath(new URL("./", import.meta.url));

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name) ? [path] : [];
  });
}

function imageViolations(source: string, fileName: string) {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const images: { location: string; violations: string[] }[] = [];
  function visit(node: ts.Node) {
    if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node))
      && node.tagName.getText(file) === "img") {
      const attributes = node.attributes.properties.filter(ts.isJsxAttribute);
      const alt = attributes.find((attribute) => attribute.name.getText(file) === "alt");
      const decoding = attributes.find((attribute) => attribute.name.getText(file) === "decoding");
      const violations: string[] = [];
      if (!alt?.initializer) violations.push("missing alt");
      if (!decoding?.initializer || !ts.isStringLiteral(decoding.initializer)
        || decoding.initializer.text !== "async") violations.push("missing async decoding");
      if (attributes.some((attribute) => {
        const name = attribute.name.getText(file);
        const initializer = attribute.initializer;
        return name.toLowerCase() === "onerror"
          && (name !== "onError" || (initializer && (ts.isStringLiteral(initializer)
            || (ts.isJsxExpression(initializer) && initializer.expression
              && ts.isStringLiteralLike(initializer.expression)))));
      })) violations.push("inline onerror");
      const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
      images.push({ location: `${fileName}:${line + 1}`, violations });
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return images;
}

describe("Front-End Checklist: images", () => {
  const images = sourceFiles(sourceRoot).flatMap((path) =>
    imageViolations(readFileSync(path, "utf8"), relative(sourceRoot, path)));

  it("finds image elements in the non-test UI sources", () => {
    expect(images.length).toBeGreaterThan(0);
  });

  it.each(images)("has alt, async decoding, and no inline onerror: $location", ({ violations }) => {
    expect(violations).toEqual([]);
  });

  it.each([
    ['<img decoding="async" />', ["missing alt"]],
    ['<img alt decoding="async" />', ["missing alt"]],
    ['<img alt="Preview" />', ["missing async decoding"]],
    ['<img alt="Preview" decoding="sync" />', ["missing async decoding"]],
    ['<img alt="Preview" decoding="async" onerror="fallback()" />', ["inline onerror"]],
    ['<img alt="Preview" decoding="async" onError="fallback()" />', ["inline onerror"]],
    ['<img alt="Preview" decoding="async" onError={"fallback()"} />', ["inline onerror"]],
    ['<img alt="" decoding="async" aria-hidden="true" />', []],
    ['<img alt="Logo" decoding="async" onError={() => setError(true)} />', []],
    ['<img\n {...props}\n src={size > 0 ? big : small}\n alt={name ?? "Preview"}\n decoding="async" />', []],
    ['<img alt="Preview" decoding="async"></img>', []],
  ])("checks JSX image attributes: %s", (source, expected) => {
    const parsed = imageViolations(source, "fixture.tsx");
    expect(parsed).toHaveLength(1);
    expect(parsed[0].violations).toEqual(expected);
  });

  it("ignores comments and strings that only mention image markup", () => {
    expect(imageViolations('/* <img /> */ const example = "<img />";', "fixture.ts")).toEqual([]);
  });
});
