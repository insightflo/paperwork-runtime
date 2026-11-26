import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readInlineSkillImports,
  readLocalSkillImports,
  readUrlSkillImports,
} from "../services/company-skills.js";

const COMPANY_ID = "33333333-3333-4333-8333-333333333333";
const PINNED_SHA = "0123456789abcdef0123456789abcdef01234567";

const cleanupDirs = new Set<string>();

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(Array.from(cleanupDirs, (dir) => fs.rm(dir, { recursive: true, force: true })));
  cleanupDirs.clear();
});

async function makeTempDir(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  cleanupDirs.add(dir);
  return dir;
}

async function writeFileEnsured(filePath: string, content: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

describe("company skill root-level fileInventory handling", () => {
  describe("readLocalSkillImports (local directory)", () => {
    it("includes all nested files in fileInventory when SKILL.md is at the root directory", async () => {
      const rootDir = await makeTempDir("paperclip-root-local-skill-");
      await writeFileEnsured(
        path.join(rootDir, "SKILL.md"),
        "---\nname: Root Skill\ndescription: Root-level skill\n---\n\n# Root Skill\n",
      );
      await writeFileEnsured(path.join(rootDir, "scripts", "a.py"), "print('hello')\n");
      await writeFileEnsured(path.join(rootDir, "references", "guide.md"), "# Guide\n");
      await writeFileEnsured(path.join(rootDir, "assets", "logo.svg"), "<svg />\n");

      const imports = await readLocalSkillImports(COMPANY_ID, rootDir);
      expect(imports).toHaveLength(1);
      expect(imports[0]!.fileInventory).toEqual([
        { path: "assets/logo.svg", kind: "asset" },
        { path: "references/guide.md", kind: "reference" },
        { path: "scripts/a.py", kind: "script" },
        { path: "SKILL.md", kind: "skill" },
      ]);
      expect(imports[0]!.trustLevel).toBe("scripts_executables");
    });

    it("keeps nested skill directories strictly scoped and excludes sibling files", async () => {
      const rootDir = await makeTempDir("paperclip-nested-local-skills-");
      await writeFileEnsured(path.join(rootDir, "README.md"), "# Repo\n");
      await writeFileEnsured(
        path.join(rootDir, "shared", "skills", "foo", "SKILL.md"),
        "---\nname: Foo\n---\n# Foo\n",
      );
      await writeFileEnsured(
        path.join(rootDir, "shared", "skills", "foo", "scripts", "x.sh"),
        "echo foo\n",
      );
      await writeFileEnsured(
        path.join(rootDir, "shared", "skills", "bar", "SKILL.md"),
        "---\nname: Bar\n---\n# Bar\n",
      );
      await writeFileEnsured(
        path.join(rootDir, "shared", "skills", "bar", "scripts", "y.sh"),
        "echo bar\n",
      );

      const imports = await readLocalSkillImports(COMPANY_ID, rootDir);
      const foo = imports.find((skill) => skill.slug === "foo");
      const bar = imports.find((skill) => skill.slug === "bar");

      expect(foo).toBeDefined();
      expect(foo!.fileInventory).toEqual([
        { path: "scripts/x.sh", kind: "script" },
        { path: "SKILL.md", kind: "skill" },
      ]);

      expect(bar).toBeDefined();
      expect(bar!.fileInventory).toEqual([
        { path: "scripts/y.sh", kind: "script" },
        { path: "SKILL.md", kind: "skill" },
      ]);
    });

    it("does not leak nested skill files into a root-level skill in the same tree", async () => {
      const rootDir = await makeTempDir("paperclip-mixed-root-nested-skills-");
      await writeFileEnsured(
        path.join(rootDir, "SKILL.md"),
        "---\nname: Root Skill\n---\n# Root\n",
      );
      await writeFileEnsured(path.join(rootDir, "scripts", "root.sh"), "echo root\n");
      await writeFileEnsured(
        path.join(rootDir, "skills", "nested", "SKILL.md"),
        "---\nname: Nested Skill\n---\n# Nested\n",
      );
      await writeFileEnsured(
        path.join(rootDir, "skills", "nested", "scripts", "nested.sh"),
        "echo nested\n",
      );

      const imports = await readLocalSkillImports(COMPANY_ID, rootDir);
      const rootSkill = imports.find((skill) => skill.slug === "root-skill");
      const nestedSkill = imports.find((skill) => skill.slug === "nested-skill");

      expect(rootSkill).toBeDefined();
      expect(rootSkill!.fileInventory).toEqual([
        { path: "scripts/root.sh", kind: "script" },
        { path: "SKILL.md", kind: "skill" },
      ]);

      expect(nestedSkill).toBeDefined();
      expect(nestedSkill!.fileInventory).toEqual([
        { path: "scripts/nested.sh", kind: "script" },
        { path: "SKILL.md", kind: "skill" },
      ]);
    });
  });

  describe("readInlineSkillImports (inline file map)", () => {
    it("includes all files with intact relative paths when SKILL.md is at the root", () => {
      const imports = readInlineSkillImports(COMPANY_ID, {
        "SKILL.md": "---\nname: Inline Root\n---\n# Inline Root\n",
        "scripts/a.py": "print('ok')\n",
        "references/guide.md": "# Guide\n",
      });

      expect(imports).toHaveLength(1);
      expect(imports[0]!.fileInventory).toEqual([
        { path: "references/guide.md", kind: "reference" },
        { path: "scripts/a.py", kind: "script" },
        { path: "SKILL.md", kind: "skill" },
      ]);
      expect(imports[0]!.trustLevel).toBe("scripts_executables");
    });

    it("keeps sibling inline skills strictly scoped to their own directories", () => {
      const imports = readInlineSkillImports(COMPANY_ID, {
        "README.md": "# Top\n",
        "skills/foo/SKILL.md": "---\nname: Foo\n---\n# Foo\n",
        "skills/foo/scripts/x.sh": "echo x\n",
        "skills/bar/SKILL.md": "---\nname: Bar\n---\n# Bar\n",
        "skills/bar/references/doc.md": "# Doc\n",
      });

      const foo = imports.find((skill) => skill.slug === "foo");
      const bar = imports.find((skill) => skill.slug === "bar");

      expect(foo!.fileInventory).toEqual([
        { path: "scripts/x.sh", kind: "script" },
        { path: "SKILL.md", kind: "skill" },
      ]);
      expect(bar!.fileInventory).toEqual([
        { path: "references/doc.md", kind: "reference" },
        { path: "SKILL.md", kind: "skill" },
      ]);
    });
  });

  describe("readUrlSkillImports (GitHub tree)", () => {
    it("includes all files when SKILL.md is at the GitHub repository root", async () => {
      const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url = String(input);
        if (url === `https://api.github.com/repos/acme/root-skill/git/trees/${PINNED_SHA}?recursive=1`) {
          return new Response(JSON.stringify({
            tree: [
              { path: "SKILL.md", type: "blob" },
              { path: "scripts/run.sh", type: "blob" },
              { path: "references/guide.md", type: "blob" },
            ],
          }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (url === `https://raw.githubusercontent.com/acme/root-skill/${PINNED_SHA}/SKILL.md`) {
          return new Response("---\nname: Root Repo Skill\n---\n# Root Repo Skill\n", { status: 200 });
        }
        throw new Error(`Unexpected fetch URL: ${url}`);
      });

      const result = await readUrlSkillImports(
        COMPANY_ID,
        `https://github.com/acme/root-skill/tree/${PINNED_SHA}`,
      );

      expect(fetchMock).toHaveBeenCalled();
      expect(result.skills).toHaveLength(1);
      expect(result.skills[0]!.fileInventory).toEqual([
        { path: "references/guide.md", kind: "reference" },
        { path: "scripts/run.sh", kind: "script" },
        { path: "SKILL.md", kind: "skill" },
      ]);
      expect(result.skills[0]!.trustLevel).toBe("scripts_executables");
    });

    it("includes all files when a GitHub tree URL points directly to a skill subdirectory", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url = String(input);
        if (url === `https://api.github.com/repos/acme/skills/git/trees/${PINNED_SHA}?recursive=1`) {
          return new Response(JSON.stringify({
            tree: [
              { path: "skills/my-skill/SKILL.md", type: "blob" },
              { path: "skills/my-skill/scripts/a.py", type: "blob" },
              { path: "skills/my-skill/references/guide.md", type: "blob" },
              { path: "skills/other-skill/SKILL.md", type: "blob" },
              { path: "skills/other-skill/scripts/b.py", type: "blob" },
            ],
          }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (url === `https://raw.githubusercontent.com/acme/skills/${PINNED_SHA}/skills/my-skill/SKILL.md`) {
          return new Response("---\nname: My Skill\n---\n# My Skill\n", { status: 200 });
        }
        throw new Error(`Unexpected fetch URL: ${url}`);
      });

      const result = await readUrlSkillImports(
        COMPANY_ID,
        `https://github.com/acme/skills/tree/${PINNED_SHA}/skills/my-skill`,
      );

      expect(result.skills).toHaveLength(1);
      expect(result.skills[0]!.fileInventory).toEqual([
        { path: "references/guide.md", kind: "reference" },
        { path: "scripts/a.py", kind: "script" },
        { path: "SKILL.md", kind: "skill" },
      ]);
    });
  });
});
