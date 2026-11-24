/**
 * [F1 2026-11-24] scripts/ci-typecheck.mjs 계획·실행 + pr.yml ci-merge-gate 인라인 bash 시험.
 *
 * 왜: 타입체크 스케줄러가 패키지를 누락하거나 의존 순서를 어기면 (a) plugin-sdk/shared 중복 빌드가
 *   남아 최적화가 무의미해지고 (b) 실패 전파/사이클 거부가 무너져 깨진 워크스페이스가 머지된다.
 *   그래서 스크립트와 독립적으로 `pnpm -r list`+package.json 을 다시 읽어 전체 목록과 간선을 고정한다.
 * tsbuildinfo 는 파일 위치 기준 상대 경로를 저장하므로 "깨끗한 체크아웃"은 같은 경로에서 재현한다.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { planTypecheckTasks, runTopologicalTasks } from "../../../scripts/ci-typecheck.mjs";

const repoRoot = realpathSync(resolve(import.meta.dirname, "../../.."));
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "ci-tc-")));
const TSC = createRequire(import.meta.url).resolve("typescript/bin/tsc");
const DEP_KEYS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

type Plan = ReturnType<typeof planTypecheckTasks>;
const task = (plan: Plan, name: string) => plan.tasks.find((t) => t.name === name)!;

/** 스크립트와 독립적으로 워크스페이스 목록·typecheck 유무·의존 간선을 재구성한다. */
function independentGraph(root: string) {
  const list = JSON.parse(execFileSync("pnpm", ["-r", "list", "--depth", "-1", "--json"], { cwd: root, encoding: "utf8" })) as { name: string; path: string }[];
  const pkgs = list.filter((p) => realpathSync(p.path) !== root);
  const byName = new Set(pkgs.map((p) => p.name));
  const byDir = new Map(pkgs.map((p) => [realpathSync(p.path), p.name]));
  const alias = (t: string) => {
    if (!t.startsWith("@")) return t.split("@", 1)[0];
    const at = t.indexOf("@", 1);
    return at === -1 ? t : t.slice(0, at);
  };
  const graph = new Map<string, { typecheck: boolean; deps: string[] }>();
  for (const p of pkgs) {
    const m = JSON.parse(readFileSync(join(p.path, "package.json"), "utf8"));
    const deps = new Set<string>();
    for (const key of DEP_KEYS) {
      for (const [d, spec] of Object.entries(m[key] || {})) {
        if (byName.has(d)) { deps.add(d); continue; }
        if (typeof spec !== "string" || !/^(npm|workspace):/.test(spec)) continue;
        const rest = spec.slice(spec.indexOf(":") + 1);
        const target = rest.startsWith(".") || rest.startsWith("/") ? byDir.get(resolve(p.path, rest)) : byName.has(alias(rest)) ? alias(rest) : undefined;
        if (target) deps.add(target);
      }
    }
    graph.set(p.name, { typecheck: Boolean(m.scripts?.typecheck), deps: [...deps].sort() });
  }
  return graph;
}

function mkws(pkgs: Record<string, { scripts?: Record<string, string>; deps?: Record<string, Record<string, string>> }>) {
  const dir = realpathSync(mkdtempSync(join(sandbox, "ws-")));
  writeFileSync(join(dir, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n');
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture-root", private: true }));
  for (const [name, spec] of Object.entries(pkgs)) {
    const pd = join(dir, "packages", name);
    mkdirSync(pd, { recursive: true });
    writeFileSync(join(pd, "package.json"), JSON.stringify({ name, version: "0.0.0", ...spec.deps, ...(spec.scripts ? { scripts: spec.scripts } : {}) }));
  }
  return dir;
}

describe("planTypecheckTasks on the real repo", () => {
  const plan = planTypecheckTasks(repoRoot);
  const byName = new Map(plan.tasks.map((t) => [t.name, t]));
  it("covers 100% of typecheck packages and matches the real dependency graph", () => {
    const expected = independentGraph(repoRoot);
    expect(new Set(plan.tasks.map((t) => t.name))).toEqual(new Set(expected.keys()));
    for (const [name, want] of expected) {
      expect(byName.get(name)!.deps, name).toEqual(want.deps);
      expect(Boolean(byName.get(name)!.cmd), `${name} cmd presence`).toBe(want.typecheck);
    }
  });
  it("prebuilds plugin-sdk once (its build compiles shared) and splits incremental vs fallback correctly", () => {
    const sdkBuild = JSON.parse(readFileSync(join(repoRoot, "packages/plugins/sdk/package.json"), "utf8")).scripts.build;
    expect(sdkBuild).toContain("@paperclipai/shared build");
    expect(plan.prebuilds).toEqual(["@paperclipai/plugin-sdk"]);
    for (const n of ["@paperclipai/server", "@paperclipai/plugin-authoring-smoke-example", "@paperclipai/plugin-file-browser-example", "@paperclipai/plugin-hello-world-example", "@paperclipai/plugin-kitchen-sink-example"]) {
      expect(task(plan, n).cmd, n).toContain("tsc --noEmit --incremental --tsBuildInfoFile");
    }
    expect(task(plan, "@paperclipai/ui").cmd).toBe("pnpm --filter @paperclipai/ui typecheck");
    expect(task(plan, "@paperclipai/db").deps).toEqual(["@paperclipai/shared"]);
    expect(task(plan, "@paperclipai/server").deps).toContain("@paperclipai/db");
    expect(task(plan, "paperclipai").deps).toContain("@paperclipai/server");
  });
});

describe("planTypecheckTasks fixtures", () => {
  it("falls back to pnpm --filter <name> typecheck for custom scripts and hooks", () => {
    const plan = planTypecheckTasks(mkws({
      "a-hook": { scripts: { typecheck: "tsc --noEmit", pretypecheck: "echo pre", posttypecheck: "echo post" } },
      "b-custom": { scripts: { typecheck: "tsc --strict" } },
    }));
    expect(task(plan, "a-hook").cmd).toBe("pnpm --filter a-hook typecheck");
    expect(task(plan, "b-custom").cmd).toBe("pnpm --filter b-custom typecheck");
  });
  it("orders and blocks through pass-through nodes without typecheck", async () => {
    const plan = planTypecheckTasks(mkws({
      a: { scripts: { typecheck: "tsc --noEmit" }, deps: { dependencies: { b: "workspace:*" } } },
      b: { deps: { dependencies: { c: "workspace:*" } } },
      c: { scripts: { typecheck: "tsc --noEmit" } },
    }));
    expect(task(plan, "b").cmd).toBeNull();
    expect(task(plan, "a").deps).toEqual(["b"]);
    expect(task(plan, "b").deps).toEqual(["c"]);
    const ran: string[] = [];
    await runTopologicalTasks(plan.tasks, async (t) => { ran.push(t.name); }, 4);
    expect(ran).toEqual(["c", "a"]);
    const started: string[] = [];
    const res = await runTopologicalTasks(plan.tasks, async (t) => { started.push(t.name); throw new Error("boom"); }, 4);
    expect(res.ok).toBe(false);
    expect(started).toEqual(["c"]);
    expect(res.results.find((r) => r.name === "a")!.status).toBe("blocked");
  });
  it("resolves npm:/workspace: alias targets to workspace edges", () => {
    const plan = planTypecheckTasks(mkws({
      app: { scripts: { typecheck: "tsc --noEmit" }, deps: { dependencies: { a1: "npm:lib-pkg@*", a2: "workspace:lib-pkg@*" } } },
      "lib-pkg": { scripts: { typecheck: "tsc --noEmit" } },
    }));
    expect(task(plan, "app").deps).toEqual(["lib-pkg"]);
  });
  it("resolves relative workspace:../dir specifiers via package dirs", () => {
    const plan = planTypecheckTasks(mkws({
      app: { scripts: { typecheck: "tsc --noEmit" }, deps: { dependencies: { anything: "workspace:../other-package" } } },
      "other-package": { scripts: { typecheck: "tsc --noEmit" } },
    }));
    expect(task(plan, "app").deps).toEqual(["other-package"]);
  });
  it("edges uninstalled optional/peer deps by key name only", () => {
    const plan = planTypecheckTasks(mkws({
      app: { scripts: { typecheck: "tsc --noEmit" }, deps: { optionalDependencies: { "opt-pkg": "*" }, peerDependencies: { react: "*", "peer-pkg": "*" } } },
      "opt-pkg": { scripts: { typecheck: "tsc --noEmit" } },
      "peer-pkg": { scripts: { typecheck: "tsc --noEmit" } },
    }));
    expect(task(plan, "app").deps).toEqual(["opt-pkg", "peer-pkg"]);
  });
  it("rejects dependency cycles during planning, before any prebuild", () => {
    const dir = mkws({
      a: { scripts: { typecheck: "tsc --noEmit" }, deps: { dependencies: { b: "workspace:*" } } },
      b: { scripts: { typecheck: "tsc --noEmit" }, deps: { dependencies: { a: "workspace:*" } } },
    });
    expect(() => planTypecheckTasks(dir)).toThrow(/cycle/);
  });
  it("rejects cycles through file:../ aliases during planning, before any prebuild", () => {
    const dir = mkws({
      a: { scripts: { typecheck: "tsc --noEmit" }, deps: { dependencies: { "alias-b": "file:../b" } } },
      b: { scripts: { typecheck: "tsc --noEmit" }, deps: { dependencies: { "alias-a": "file:../a" } } },
    });
    expect(() => planTypecheckTasks(dir)).toThrow(/cycle/);
  });
});

it("never starts downstream tasks when an upstream task fails", async () => {
  const started: string[] = [];
  const res = await runTopologicalTasks(
    [{ name: "a", dir: "", cmd: "true", deps: [] }, { name: "b", dir: "", cmd: "true", deps: ["a"] }],
    async (t) => { started.push(t.name); if (t.name === "a") throw new Error("a failed"); }, 4);
  expect(started).toEqual(["a"]);
  expect(res.ok).toBe(false);
  expect(res.results.find((r) => r.name === "b")!.status).toBe("blocked");
});

it("waits for in-flight tasks so a slow independent failure reaches the final result", async () => {
  let slowDone = false;
  const res = await runTopologicalTasks(
    [{ name: "fast", dir: "", cmd: "true", deps: [] }, { name: "slow", dir: "", cmd: "true", deps: [] }],
    async (t) => {
      if (t.name === "slow") {
        await new Promise((r) => setTimeout(r, 50));
        slowDone = true;
        throw new Error("slow failed");
      }
      await new Promise((r) => setTimeout(r, 5));
    }, 4);
  expect(slowDone).toBe(true);
  expect(res.ok).toBe(false);
  expect(res.results.find((r) => r.name === "slow")!.status).toBe("failed");
});

describe("incremental .tsbuildinfo", () => {
  const TSCONFIG = JSON.stringify({ compilerOptions: { strict: true, module: "commonjs", moduleResolution: "node", skipLibCheck: true } });
  const tsc = (cwd: string, args: string[]) => spawnSync(process.execPath, [TSC, ...args], { cwd, encoding: "utf8" });
  const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
  it("reuses a warm .tsbuildinfo in a clean checkout and still catches new errors", () => {
    const proj = join(sandbox, "warm-proj");
    const bi = join(proj, "x.tsbuildinfo");
    const writeSrc = () => {
      mkdirSync(proj, { recursive: true });
      writeFileSync(join(proj, "tsconfig.json"), TSCONFIG);
      writeFileSync(join(proj, "a.ts"), "export const x: number = 1;\n");
    };
    writeSrc();
    expect(tsc(proj, ["--noEmit", "--incremental", "--tsBuildInfoFile", bi, "--extendedDiagnostics"]).status).toBe(0);
    const digest = sha(bi);
    const saved = readFileSync(bi);
    rmSync(proj, { recursive: true, force: true });
    writeSrc();
    writeFileSync(bi, saved); // 깨끗한 체크아웃에 .tsbuildinfo 만 복원
    const warm = tsc(proj, ["--noEmit", "--incremental", "--tsBuildInfoFile", bi, "--extendedDiagnostics"]);
    expect(warm.status).toBe(0);
    expect(warm.stdout).not.toContain("Check time"); // 재사용이면 의미 검사를 건너뛴다
    expect(sha(bi)).toBe(digest);
    writeFileSync(join(proj, "a.ts"), "export const x: number = 1;\nexport const bad: string = 1;\n");
    expect(tsc(proj, ["--noEmit", "--incremental", "--tsBuildInfoFile", bi]).status).not.toBe(0);
  });
  it("detects upstream type breakage through a restored .tsbuildinfo (clean tsc agrees)", () => {
    const proj = join(sandbox, "lib-app");
    const appBi = join(proj, "app", "app.tsbuildinfo");
    const write = (libVersion: "number" | "string", bi: Buffer | null) => {
      mkdirSync(join(proj, "lib", "src"), { recursive: true });
      mkdirSync(join(proj, "app"), { recursive: true });
      writeFileSync(join(proj, "lib", "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, declaration: true, outDir: "dist", module: "commonjs", skipLibCheck: true } }));
      writeFileSync(join(proj, "lib", "src", "index.ts"), `export const greet: ${libVersion} = ${libVersion === "number" ? "1" : '"x"'};\n`);
      writeFileSync(join(proj, "app", "tsconfig.json"), TSCONFIG);
      writeFileSync(join(proj, "app", "index.ts"), 'import { greet } from "../lib/dist/index";\nexport const n: number = greet;\n');
      if (bi) writeFileSync(appBi, bi);
    };
    write("number", null);
    expect(tsc(join(proj, "lib"), []).status).toBe(0); // lib 빌드 -> dist/index.d.ts
    expect(tsc(join(proj, "app"), ["--noEmit", "--incremental", "--tsBuildInfoFile", appBi]).status).toBe(0);
    const saved = readFileSync(appBi);
    rmSync(proj, { recursive: true, force: true });
    write("string", saved); // 깨끗한 디렉터리(dist 없음): 소스 + app .tsbuildinfo 만 복원 후 lib 타입 파괴
    expect(tsc(join(proj, "lib"), []).status).toBe(0);
    expect(tsc(join(proj, "app"), ["--noEmit", "--incremental", "--tsBuildInfoFile", appBi]).status).not.toBe(0);
    expect(tsc(join(proj, "app"), ["--noEmit"]).status).not.toBe(0);
  });
});

describe("pr.yml ci-merge-gate inline bash", () => {
  const yml = readFileSync(join(repoRoot, ".github/workflows/pr.yml"), "utf8");
  const jobBody = yml.slice(yml.indexOf("\n  ci-merge-gate:"));
  const script = jobBody.match(/ {8}run: \|\n((?: {10}[^\n]*\n)+)/)![1].replace(/^ {10}/gm, "");
  it("extracts a runnable script from the workflow", () => {
    expect(script).toContain("EVENT_NAME");
    expect(script).toContain("FULL_RES");
  });
  const cases: [string, string, string, string, string, number][] = [
    ["pull_request", "success", "success", "skipped", "skipped", 0],
    ["pull_request", "success", "skipped", "success", "skipped", 0],
    ["pull_request", "success", "skipped", "skipped", "success", 0],
    ["pull_request", "success", "success", "success", "skipped", 1],
    ["pull_request", "success", "skipped", "skipped", "skipped", 1],
    ["pull_request", "success", "success", "failure", "cancelled", 1],
    ["pull_request", "failure", "success", "skipped", "skipped", 1],
    ["workflow_dispatch", "success", "success", "skipped", "skipped", 0],
    ["workflow_dispatch", "success", "failure", "skipped", "skipped", 1],
  ];
  it.each(cases)("%s policy=%s full=%s reused=%s docs=%s -> exit %i", (ev, p, f, r, d, code) => {
    const res = spawnSync("bash", ["-c", script], { env: { PATH: process.env.PATH!, EVENT_NAME: ev, P_RES: p, FULL_RES: f, REUSE_RES: r, DOCS_RES: d } });
    expect(res.status, res.stderr + res.stdout).toBe(code);
  });
});
