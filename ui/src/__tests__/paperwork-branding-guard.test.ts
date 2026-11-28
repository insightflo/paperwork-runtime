import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const uiRoot = fileURLToPath(new URL("../../", import.meta.url));
const sourceRoots = ["src/components", "src/pages"];
const keyUserFacingFiles = [
  "src/components/ProjectProperties.tsx",
  "src/pages/Auth.tsx",
  "src/pages/NotFound.tsx",
];

const technicalIdentifierPatterns = [
  /^@paperclipai\/\S*$/,
  /^paperclip[.:]\S*$/,
  /^paperclipai\/paperclip\/\S*$/,
];
const internalSingleTokenAllowlist = new Map<string, Set<string>>([
  ["src/pages/CompanySkills.tsx", new Set(["paperclip"])],
]);

type BrandViolation = {
  file: string;
  line: number;
  kind: "string" | "jsx-text";
  text: string;
};

function readUiFile(relativePath: string): string {
  return readFileSync(join(uiRoot, relativePath), "utf8");
}

function posixPath(path: string): string {
  return path.split(sep).join("/");
}

function collectSourceFiles(relativeDir: string): string[] {
  const absoluteDir = join(uiRoot, relativeDir);
  const files: string[] = [];
  for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
    const absolutePath = join(absoluteDir, entry.name);
    const relativePath = posixPath(relative(uiRoot, absolutePath));
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(relativePath));
      continue;
    }
    if (!/\.tsx?$/.test(entry.name) || entry.name.includes(".test.") || entry.name === "CliAuth.tsx") continue;
    files.push(relativePath);
  }
  return files.sort();
}

function stripAllowedTechnicalReferences(text: string, relativePath: string): string {
  const value = text.trim();
  const singleToken = value.toLowerCase();
  if (internalSingleTokenAllowlist.get(relativePath)?.has(singleToken)) return "";
  if (technicalIdentifierPatterns.some((pattern) => pattern.test(value))) return "";
  if (/^\[paperclip\]\s+/i.test(value)) return "";
  return value
    .replace(/\bpaperclip-[a-z0-9-]+/gi, "")
    .replace(/\bPAPERCLIP_[A-Z0-9_*]+/g, "");
}

function brandViolations(relativePath: string): BrandViolation[] {
  const sourceText = readUiFile(relativePath);
  const sourceFile = ts.createSourceFile(relativePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const violations: BrandViolation[] = [];
  const addIfUserVisibleBrand = (kind: BrandViolation["kind"], text: string, node: ts.Node) => {
    if (!text.toLowerCase().includes("paperclip")) return;
    const residual = stripAllowedTechnicalReferences(text, relativePath);
    if (!residual.toLowerCase().includes("paperclip")) return;
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    violations.push({ file: relativePath, line, kind, text: text.trim() });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      addIfUserVisibleBrand("string", node.text, node);
    } else if (ts.isTemplateExpression(node)) {
      addIfUserVisibleBrand("string", node.getText(sourceFile).slice(1, -1), node);
    } else if (ts.isJsxText(node)) {
      addIfUserVisibleBrand("jsx-text", node.getText(sourceFile), node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

describe("Paperwork branding guard", () => {
  it("keeps user-visible HTML title, metadata, and noscript copy free of the legacy product name", () => {
    const html = readUiFile("index.html");
    const visibleHtml = html
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<script\b[\s\S]*?<\/script>/gi, "");

    expect(visibleHtml).not.toMatch(/paperclip/i);
    expect(visibleHtml).toContain("<title>Paperwork</title>");
    expect(visibleHtml).toMatch(/<noscript>[\s\S]*Paperwork[\s\S]*<\/noscript>/i);
  });

  it("keeps the installable web manifest on the Paperwork brand", () => {
    const raw = readUiFile("public/site.webmanifest");
    const manifest = JSON.parse(raw) as { name?: unknown; short_name?: unknown };

    expect(raw).not.toMatch(/paperclip/i);
    expect(manifest.name).toBe("Paperwork");
    expect(manifest.short_name).toBe("Paperwork");
  });

  it("scans component and page source for user-visible legacy brand strings", () => {
    const files = sourceRoots.flatMap((root) => collectSourceFiles(root));
    for (const keyFile of keyUserFacingFiles) {
      expect(files).toContain(keyFile);
    }

    const violations = files.flatMap((file) => brandViolations(file));
    expect(violations.map((violation) => `${violation.file}:${violation.line} ${violation.kind} ${violation.text}`)).toEqual([]);
  });

  it("keeps the execution worktree placeholder on the Paperwork path", () => {
    const properties = readUiFile("src/components/ProjectProperties.tsx");

    expect(properties).toContain('placeholder=".paperwork/worktrees"');
    expect(properties).not.toContain('placeholder=".paperclip/');
  });
});
