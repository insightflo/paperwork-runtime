// server/src/__tests__/portability-yaml-stage1-parity.test.ts
//
// Stage 5.1 — differential parity between the Rust helper
// crates/portability-yaml (paperclip-portability-yaml) and the source-of-truth
// TS emitter server/src/services/company-portability-yaml.ts. The Rust binary
// mirrors buildMarkdown / buildYamlFile / stripEmptyValues byte-for-byte;
// YAML parsing stays in TS. No mocks: every case spawns the real release
// binary built fresh in beforeAll (cold CI runners included).

import { beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildMarkdown, buildYamlFile, stripEmptyValues } from "../services/company-portability-yaml.js";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const rustBin = join(repoRoot, "crates/portability-yaml/target/release/paperclip-portability-yaml");

beforeAll(() => {
  const which = String(spawnSync("which", ["cargo"], { encoding: "utf8" }).stdout ?? "").trim();
  const cargoBin = process.env.CARGO || which || join(homedir(), ".cargo/bin/cargo");
  execFileSync(cargoBin, ["build", "--release", "--manifest-path", join(repoRoot, "crates/portability-yaml/Cargo.toml")], { encoding: "utf8" });
}, 120_000);

type Fm = Record<string, unknown>;
interface MarkdownCase { name: string; frontmatter: Fm; body: string }
interface YamlCase { name: string; value: Fm | unknown[] | unknown; preserve?: boolean }

function runRustRaw(command: string, rawJson: string): Record<string, unknown> {
  const proc = spawnSync(rustBin, [command], { input: rawJson, encoding: "utf8" });
  if (proc.error) throw proc.error;
  expect(proc.status).toBe(0);
  expect(String(proc.stderr)).toBe("");
  return JSON.parse(proc.stdout) as Record<string, unknown>;
}

function runRust(command: string, input: unknown): Record<string, unknown> {
  return runRustRaw(command, JSON.stringify(input));
}

const markdownCases: MarkdownCase[] = [
  { name: "simple frontmatter and body", frontmatter: { name: "alpha", description: "first agent", version: "1.0.0" }, body: "hello world" },
  { name: "all priority keys then unknown keys", frontmatter: Object.fromEntries(["zebra", "metadata", "name", "budgetMonthlyCents", "adapter", "slug", "description", "permissions", "runtime", "icon", "role", "requirements", "includes", "tags", "homepage", "authors", "license", "version", "schedule", "project", "assignee", "owner", "skills", "reportsTo", "kind", "schema", "title", "capabilities", "brandColor", "logoPath"].map((k) => [k, k === "budgetMonthlyCents" ? 100 : k])), body: "b" },
  { name: "empty frontmatter and empty body", frontmatter: {}, body: "" },
  { name: "empty frontmatter with body", frontmatter: {}, body: "solo body" },
  { name: "body CRLF normalized", frontmatter: { name: "crlf" }, body: "line1\r\nline2\r\nline3" },
  { name: "body whitespace only behaves as empty", frontmatter: { name: "ws" }, body: "   \n\t \r\n " },
  { name: "multiline body preserved", frontmatter: { name: "multi" }, body: "para one\n\npara two\n\n- item\n- item2" },
  { name: "body trailing whitespace trimmed", frontmatter: { name: "trim" }, body: "content\n\n\n" },
  { name: "top-level null entries skipped", frontmatter: { name: "n", owner: null, description: "kept" }, body: "" },
  { name: "nested object rendered", frontmatter: { schedule: { cron: "0 9 * * *", timezone: "Asia/Seoul", nested: { deep: true } } }, body: "" },
  { name: "nested array of strings", frontmatter: { skills: ["rust", "ts", "sql"] }, body: "" },
  { name: "array of objects", frontmatter: { permissions: [{ tool: "fs", mode: "rw" }, { tool: "net", mode: "r" }] }, body: "" },
  { name: "array of arrays", frontmatter: { includes: [["a", "b"], ["c"]] }, body: "" },
  { name: "empty array rendered inline", frontmatter: { tags: [], name: "e" }, body: "" },
  { name: "empty object rendered inline", frontmatter: { metadata: {}, name: "e" }, body: "" },
  { name: "nested null rendered as null", frontmatter: { schedule: { cron: null, timezone: "KST" } }, body: "" },
  { name: "strings with quotes and backslashes", frontmatter: { description: "she said \"hi\" \\ path", name: "q" }, body: "" },
  { name: "strings with newline and tab", frontmatter: { description: "line1\nline2\tend", name: "w" }, body: "" },
  { name: "strings with control chars", frontmatter: { description: "\u0001bell\u001funit\u007fdel", name: "c" }, body: "" },
  { name: "unicode values korean and emoji", frontmatter: { description: "한글 설명 🚀 지원", name: "u" }, body: "본문 내용\n두 번째 줄" },
  { name: "integer numbers", frontmatter: { budgetMonthlyCents: 1500, zero: 0, negative: -3, big: 1000000 }, body: "" },
  { name: "decimal numbers", frontmatter: { ratio: 1.5, tiny: 0.1, price: 3.75, debt: -0.25 }, body: "" },
  { name: "number exponent thresholds", frontmatter: { a: 1e20, b: 1e21, c: 1e-6, d: 1e-7, e: -0, f: 123456789012, g: 1.25e-8 }, body: "" },
  { name: "boolean values", frontmatter: { enabled: true, disabled: false, name: "b" }, body: "" },
  { name: "unknown key ICU ordering", frontmatter: { userRole: 1, user_role: 2, User_Role: 3, userName: 4, "a b": 5, "a-b": 6, ab: 7, b_x: 8, "b-x": 9, B2: 10, budgetMonthlyCents: 11, _id: 12, "10": 13, "2": 14, name: 15 }, body: "" },
  { name: "deep nesting three levels", frontmatter: { runtime: { env: { NODE_ENV: "production", nested: { deeper: [1, [2, [3]]] } } } }, body: "" },
  { name: "mixed scalar array", frontmatter: { tags: ["a", "", 1, true, null, [], {}, "b"] }, body: "" },
  { name: "body with yaml special chars", frontmatter: { name: "y" }, body: "key: value # not yaml\n- list\n{json: like}" },
  { name: "frontmatter value empty string rendered", frontmatter: { description: "", name: "s" }, body: "" },
  { name: "long realistic frontmatter", frontmatter: { name: "writer", description: "writes docs", version: "2.1.0", schedule: { cron: "0 * * * *" }, skills: ["write", "review"], budgetMonthlyCents: 5000, owner: "team-a", tags: ["docs"], zebra: "last" }, body: "# Report\n\ndone" },
  // JS trim removes U+FEFF (BOM) — Rust str::trim does not.
  { name: "body BOM trimmed like JS", frontmatter: { name: "t" }, body: "\uFEFFcontent\uFEFF" },
  // JS trim keeps U+0085 (NEL) — Rust str::trim strips it.
  { name: "body NEL preserved unlike Rust trim", frontmatter: { name: "t" }, body: "\u0085content\u0085" },
  { name: "body NEL-only stays truthy", frontmatter: { name: "t" }, body: "\u0085" },
  // ICU localeCompare sorts accented Latin at the base letter (é<z, Ö<Z).
  { name: "accented keys ICU ordering", frontmatter: { "étag": 1, "zzz": 2, "Öland": 3, "Zulu": 4, "apple": 5 }, body: "" },
];

const yamlCases: YamlCase[] = [
  { name: "simple object", value: { name: "alpha", count: 2 } },
  { name: "strips empty strings arrays objects nulls", value: { name: "x", note: "", tags: [], meta: {}, draft: null, keep: 1 } },
  { name: "preserveEmptyStrings keeps empty strings", value: { name: "x", note: "", keep: 1 }, preserve: true },
  { name: "all empty becomes empty yaml", value: { note: "", tags: [], meta: {}, draft: null } },
  { name: "top-level empty object", value: {} },
  { name: "top-level array becomes empty yaml", value: ["", [], {}] },
  { name: "top-level scalar becomes empty yaml", value: "just a string" },
  { name: "array elements filtered after strip", value: { items: ["keep", "", null, [], {}, "also"] } },
  { name: "zeros and false survive strip", value: { zero: 0, off: false, empty: "", ok: 1 } },
  { name: "parent dropped when children all stripped", value: { outer: { inner: "" }, real: "stays" } },
  { name: "priority then unknown key ordering", value: { zebra: 1, name: 2, adapter: 3, apple: 4, metadata: 5 } },
  { name: "deep nesting", value: { l1: { l2: { l3: { l4: { leaf: "v", arr: [[1], ["x", "y"]] } } } } } },
  { name: "unicode values", value: { title: "한글 제목", desc: "emoji 🎉 mix", plain: "ascii" } },
  { name: "number formats preserved", value: { a: 1e20, b: 1e21, c: 1e-6, d: 1e-7, e: 3.75, f: -12, g: 0 } },
  { name: "whitespace-only string is not empty", value: { pad: " ", keep: true } },
  { name: "nested arrays of objects and scalars", value: { permissions: [{ tool: "fs" }, "raw", 3, [1, 2]] } },
];

const stripCases: YamlCase[] = [
  { name: "mixed strip", value: { a: "", b: [], c: {}, d: null, e: 0, f: "x" } },
  { name: "array filter", value: ["keep", "", null, 7] },
  { name: "preserve strings", value: { s: "", n: 1 }, preserve: true },
  { name: "cascade to nothing", value: { only: { deep: "" } } },
];

describe("portability-yaml stage1 rust parity", () => {
  for (const c of markdownCases) {
    it(`buildMarkdown: ${c.name}`, () => {
      const rust = runRust("build-markdown", { frontmatter: c.frontmatter, body: c.body });
      expect(rust.markdown).toBe(buildMarkdown(c.frontmatter, c.body));
    });
  }

  for (const c of yamlCases) {
    it(`buildYamlFile: ${c.name}`, () => {
      const rust = runRust("build-yaml-file", { value: c.value, preserveEmptyStrings: c.preserve });
      expect(rust.yaml).toBe(buildYamlFile(c.value, { preserveEmptyStrings: c.preserve }));
    });
  }

  for (const c of stripCases) {
    it(`stripEmptyValues: ${c.name}`, () => {
      const ts = stripEmptyValues(c.value, { preserveEmptyStrings: c.preserve });
      const expected = ts === undefined ? null : ts; // TS undefined === Rust null on the wire
      expect(runRust("strip-empty-values", { value: c.value, preserveEmptyStrings: c.preserve }).value).toEqual(expected);
    });
  }

  // Raw JSON keeps digit literals that JSON.stringify would rewrite — serde_json
  // float_roundtrip must parse them to the same doubles as V8 (1e+21, 8.6e+77).
  it("buildYamlFile: float literals round-trip like JS parse", () => {
    const raw = '{"value":{"big":999999999999999900000,"exp":86e76}}';
    const ts = buildYamlFile((JSON.parse(raw) as { value: Fm }).value);
    expect(runRustRaw("build-yaml-file", raw).yaml).toBe(ts);
  });

  // i64/u64 literals beyond 2^53 must emit the parsed double, not the literal
  // digits — serde_json integers route through as_f64 like V8 JSON.parse.
  it("buildYamlFile: big integer literals emit the parsed double", () => {
    for (const [literal, expected] of [
      ["9007199254740993", "9007199254740992"],
      ["-9007199254740993", "-9007199254740992"],
      ["9223372036854775807", "9223372036854776000"],
      ["9223372036854775808", "9223372036854776000"],
      ["18446744073709551615", "18446744073709552000"],
    ]) {
      const raw = `{"value":{"n":${literal}}}`;
      const ts = buildYamlFile((JSON.parse(raw) as { value: Fm }).value);
      expect(ts).toContain(`n: ${expected}`);
      expect(runRustRaw("build-yaml-file", raw).yaml).toBe(ts);
    }
  });
});
