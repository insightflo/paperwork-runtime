import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const repoUi = join(repoRoot, "ui");
const script = join(repoRoot, "scripts/check-frontend-checklist.mjs");
const tempDirs: string[] = [];
const cssRules = [
  "@media (prefers-reduced-motion: reduce) { * { animation: none; } }",
  "@media print { body { color: black; } }",
  ":focus-visible { outline: 2px solid blue; }",
];

function audit(args: string[], uiDir = repoUi) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    env: { ...process.env, FE_CHECKLIST_UI_DIR: uiDir },
    encoding: "utf8",
    timeout: 10_000,
  });
  if (result.error) throw result.error;
  return { status: result.status, output: result.stdout + result.stderr };
}

function fixture(css: string | null = cssRules.join("\n")) {
  const uiDir = mkdtempSync(join(tmpdir(), "frontend-checklist-"));
  tempDirs.push(uiDir);
  mkdirSync(join(uiDir, "public"));
  mkdirSync(join(uiDir, "src"));
  for (const file of ["index.html", "public/robots.txt", "public/site.webmanifest"]) {
    copyFileSync(join(repoUi, file), join(uiDir, file));
  }
  writeFileSync(join(uiDir, "src/example.tsx"), '<img alt="Example" src="/example.png" />');
  if (css !== null) writeFileSync(join(uiDir, "src/index.css"), css);
  return uiDir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("frontend checklist command", () => {
  it("passes strict checks against the repository", () => {
    const result = audit(["--strict"]);
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain("All checks passed.");
  });

  it.each(["index.html", "public/robots.txt", "public/site.webmanifest", "src"])(
    "fails strict checks when %s is missing",
    (file) => {
      const uiDir = fixture();
      rmSync(join(uiDir, file), { recursive: true });
      expect(audit(["--strict"], uiDir).status).toBe(1);
    },
  );

  it("keeps default head findings as warnings and strict findings as failures", () => {
    const uiDir = fixture();
    writeFileSync(join(uiDir, "public/robots.txt"), "");
    expect(audit([], uiDir).status).toBe(0);
    expect(audit(["--strict"], uiDir).status).toBe(1);
  });

  it("still rejects source accessibility and security violations", () => {
    const uiDir = fixture();
    writeFileSync(join(uiDir, "src/example.tsx"), '<a target="_blank"><img src="/x.png" /></a>');
    const result = audit(["--strict"], uiDir);
    expect(result.status).toBe(1);
    expect(result.output).toContain("a11y/img-alt");
    expect(result.output).toContain("security/ext-links");
  });

  it("accepts all three CSS rules when explicitly enabled", () => {
    const result = audit(["--strict", "--with-css"], fixture());
    expect(result.status, result.output).toBe(0);
  });

  it.each([{ args: [] }, { args: ["--strict"] }])("keeps CSS opt-in for $args", ({ args }) => {
    const result = audit(args, fixture(null));
    expect(result.status, result.output).toBe(0);
  });

  it.each(["css/reduced-motion", "css/print", "css/focus-visible"])(
    "reports missing %s even if it appears only in a comment",
    (rule) => {
      const index = ["css/reduced-motion", "css/print", "css/focus-visible"].indexOf(rule);
      const css = cssRules.map((value, i) => i === index ? `/* ${value} */` : value).join("\n");
      const result = audit(["--strict", "--with-css"], fixture(css));
      expect(result.status).toBe(1);
      expect(result.output).toContain(`(${rule})`);
      expect(result.output.match(/\[ERROR\]/g)).toHaveLength(1);
    },
  );

  it("fails a requested CSS check when the stylesheet is missing", () => {
    const result = audit(["--with-css"], fixture(null));
    expect(result.status).toBe(1);
    expect(result.output).toContain("css/file");
  });

  it("skips source and CSS in head-only mode", () => {
    const uiDir = fixture(null);
    rmSync(join(uiDir, "src"), { recursive: true });
    const result = audit(["--strict", "--head-only", "--with-css"], uiDir);
    expect(result.status, result.output).toBe(0);
  });

  it("skips head, static files, and CSS in src-only mode", () => {
    const uiDir = fixture(null);
    rmSync(join(uiDir, "index.html"));
    rmSync(join(uiDir, "public"), { recursive: true });
    const result = audit(["--strict", "--src-only", "--with-css"], uiDir);
    expect(result.status, result.output).toBe(0);
  });

  it("rejects conflicting scope flags instead of silently skipping every check", () => {
    const result = audit(["--strict", "--src-only", "--head-only"]);
    expect(result.status).toBe(1);
    expect(result.output).toContain("cannot be combined");
  });
});
