#!/usr/bin/env node
/**
 * [F1 2026-11-24] 워크스페이스 typecheck 를 토폴로지 순서 + 증분 tsbuildinfo 로 실행한다.
 *
 * 왜: `pnpm -r typecheck` 는 각 패키지 스크립트 안의 `pnpm --filter @paperclipai/(shared|plugin-sdk) build`
 *   선행 빌드를 패키지마다 반복 실행한다(중복 빌드). plugin-sdk 의 build 스크립트가 shared 빌드를
 *   포함하므로 plugin-sdk 하나만 프리빌드하면 둘 다 정확히 한 번 빌드되고,
 *   안전한 `tsc --noEmit` 계열은 `.cache/tsbuildinfo` 아래 증분 검사로 바꾼다.
 *   executor 는 비동기 spawn 이라 준비된 작업이 concurrency(4)까지 실제 병렬 실행된다.
 * fail-closed: 스크립트 패턴 불일치, pretypecheck/posttypecheck 훅, 임의 커스텀 스크립트는
 *   원래 `pnpm --filter <name> typecheck` 실행으로 되돌리고, 워크스페이스 의존 사이클은
 *   프리빌드 전에 즉시 실패시킨다.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// plugin-sdk 의 build 가 `pnpm --filter @paperclipai/shared build` 를 내장하므로 shared 를 따로
// 프리빌드하면 두 번 빌드된다. plugin-sdk 만 프리빌드해 shared 를 정확히 한 번 빌드한다.
const PREBUILD = ["@paperclipai/plugin-sdk"];
const DEP_KEYS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
const INCREMENTAL = /^tsc --noEmit$|^pnpm --filter @paperclipai\/(shared|plugin-sdk) build && tsc --noEmit$/;

const sanitize = (name) => name.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "");

/** `pkg@ver` | `@scope/pkg@ver` -> `pkg` | `@scope/pkg` (버전 접미를 뗀 별칭 대상 이름). */
function aliasName(target) {
  if (target.startsWith("@")) {
    const at = target.indexOf("@", 1);
    return at === -1 ? target : target.slice(0, at);
  }
  return target.split("@", 1)[0];
}

/** 매니페스트의 워크스페이스 의존 간선(패키지 이름 집합)을 돌려준다. */
function depEdges(manifest, pkgDir, byName, byDir) {
  const edges = new Set();
  for (const key of DEP_KEYS) {
    for (const [dep, spec] of Object.entries(manifest[key] || {})) {
      if (byName.has(dep)) { edges.add(dep); continue; }
      if (typeof spec !== "string" || !/^(npm|workspace):/.test(spec)) continue;
      const rest = spec.slice(spec.indexOf(":") + 1);
      if (rest.startsWith(".") || path.isAbsolute(rest)) {
        const target = byDir.get(path.resolve(pkgDir, rest));
        if (target && target !== manifest.name) edges.add(target);
      } else {
        const name = aliasName(rest);
        if (byName.has(name) && name !== manifest.name) edges.add(name);
      }
    }
  }
  return edges;
}

/** 워크스페이스 의존 그래프가 비순환인지 검증하고 위상 순서(이름 배열)를 돌려준다. */
function topoOrder(tasks) {
  const byName = new Map(tasks.map((t) => [t.name, t]));
  const state = new Map(); // 1=방문 중(사이클 후보) 2=완료
  const order = [];
  const visit = (name, trail) => {
    const s = state.get(name);
    if (s === 2) return;
    if (s === 1) throw new Error(`workspace dependency cycle detected: ${[...trail, name].join(" -> ")}`);
    state.set(name, 1);
    for (const d of byName.get(name).deps) visit(d, [...trail, name]);
    state.set(name, 2);
    order.push(name);
  };
  for (const t of tasks) visit(t.name, []);
  return order;
}

/**
 * 워크스페이스 전체를 `pnpm -r list --depth -1 --json`(pnpm 공식 목록)으로 열거해
 * typecheck 작업 계획을 세운다. 루트 매니페스트(path === repoRoot)는 제외하고,
 * typecheck 가 없는 패키지도 통과 노드로 남겨 간선 순서를 보존한다.
 * -> { prebuilds: string[], tasks: { name, dir, cmd|null, deps: string[] }[] }
 */
export function planTypecheckTasks(repoRoot) {
  const root = fs.realpathSync(repoRoot);
  const raw = execFileSync("pnpm", ["-r", "list", "--depth", "-1", "--json"], { cwd: root, encoding: "utf8", maxBuffer: 1 << 26 });
  const pkgs = JSON.parse(raw)
    .filter((p) => fs.realpathSync(p.path) !== root)
    .map((p) => ({ name: p.name, dir: fs.realpathSync(p.path), manifest: JSON.parse(fs.readFileSync(path.join(p.path, "package.json"), "utf8")) }));
  const byName = new Map(pkgs.map((p) => [p.name, p]));
  const byDir = new Map(pkgs.map((p) => [p.dir, p.name]));
  const tasks = pkgs.map((p) => {
    const scripts = p.manifest.scripts || {};
    const deps = [...depEdges(p.manifest, p.dir, byName, byDir)].sort();
    let cmd = null;
    if (scripts.typecheck) {
      const info = path.join(root, ".cache", "tsbuildinfo", `${sanitize(p.name)}.tsbuildinfo`);
      const diag = process.env.CI_TYPECHECK_DIAGNOSTICS === "1" ? " --extendedDiagnostics" : "";
      cmd = INCREMENTAL.test(scripts.typecheck) && !scripts.pretypecheck && !scripts.posttypecheck
        ? `pnpm --filter ${p.name} exec tsc --noEmit --incremental --tsBuildInfoFile ${info}${diag}`
        : `pnpm --filter ${p.name} typecheck`;
    }
    return { name: p.name, dir: p.dir, cmd, deps };
  });
  const rank = new Map(topoOrder(tasks).map((n, i) => [n, i]));
  tasks.sort((a, b) => rank.get(a.name) - rank.get(b.name));
  return { prebuilds: PREBUILD.filter((n) => byName.has(n)), tasks };
}

/**
 * deps 가 모두 success 인 작업부터 concurrency 개까지 병렬 실행한다.
 * cmd=null(통과 노드)은 executor 없이 즉시 성공 처리하고, 실패/차단된 dep 를 둔 작업은
 * 절대 시작하지 않는다(blocked). -> { ok: boolean, results: { name, status, ms }[] }
 */
export async function runTopologicalTasks(tasks, executor, concurrency = 4) {
  const status = new Map(tasks.map((t) => [t.name, "pending"]));
  const results = [];
  const running = new Set();
  const finish = (t, st, ms, error) => {
    status.set(t.name, st);
    results.push({ name: t.name, status: st, ms, ...(error ? { error: String(error && error.message ? error.message : error) } : {}) });
  };
  while ([...status.values()].includes("pending")) {
    for (const t of tasks) {
      if (status.get(t.name) !== "pending") continue;
      if (t.deps.some((d) => status.get(d) === "failed" || status.get(d) === "blocked")) { finish(t, "blocked", 0); continue; }
      if (running.size >= concurrency || !t.deps.every((d) => status.get(d) === "success")) continue;
      status.set(t.name, "running");
      const t0 = Date.now();
      const p = Promise.resolve().then(async () => {
        try { if (t.cmd) await executor(t); finish(t, "success", Date.now() - t0); }
        catch (e) { finish(t, "failed", Date.now() - t0, e); }
        finally { running.delete(p); }
      });
      running.add(p);
    }
    if (running.size === 0) {
      for (const t of tasks) if (status.get(t.name) === "pending") finish(t, "blocked", 0);
      break;
    }
    await Promise.race(running);
  }
  return { ok: results.every((r) => r.status === "success"), results };
}

async function main() {
  const root = fs.realpathSync(process.cwd());
  const plan = planTypecheckTasks(root);
  fs.mkdirSync(path.join(root, ".cache", "tsbuildinfo"), { recursive: true });
  for (const name of plan.prebuilds) {
    const t0 = Date.now();
    execFileSync("pnpm", ["--filter", name, "build"], { cwd: root, stdio: "inherit" });
    console.log(`prebuild ${name} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
  // execSync 는 이벤트 루프를 막아 병렬 슬롯이 직렬로 굳는다. 비동기 spawn 으로 실제 병렬 실행한다.
  const executor = (t) => new Promise((resolve, reject) => {
    const t0 = Date.now();
    let settled = false;
    const done = (ok, err) => {
      if (settled) return;
      settled = true;
      console.log(`${t.name}${ok ? "" : " FAILED"} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      ok ? resolve() : reject(err);
    };
    const child = spawn(t.cmd, { cwd: root, stdio: "inherit", shell: true });
    child.on("error", (e) => done(false, e));
    child.on("exit", (code, signal) => done(code === 0, new Error(`exit ${code ?? signal}`)));
  });
  const { ok, results } = await runTopologicalTasks(plan.tasks, executor, 4);
  for (const r of results) if (r.status === "blocked") console.log(`${r.name} blocked (upstream failure)`);
  if (!ok) { console.error("ci-typecheck: failed"); process.exit(1); }
  console.log(`ci-typecheck: ${results.filter((r) => r.status === "success").length} tasks passed`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(`ci-typecheck: ${e.message}`); process.exit(1); });
}
