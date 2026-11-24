#!/usr/bin/env node
/** ci-vitest-shard.mjs — deterministic LPT-weighted vitest sharding + manifest gate (F2).
 * `vitest --shard` splits by file COUNT; measured 60-182s suites pinned one shard. LPT over
 * measured weights + exact pre/post selection proofs + per-shard manifests let
 * verify-tests-full-gate prove 0 omitted / 0 duplicated / 0 unexpected per commit.
 * Zero external deps. Tests: server/src/__tests__/ci-vitest-shard.test.ts. */
import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

// Measured suite seconds (CI run 45284990771), keyed by repo-relative path; others = 1.
export const DEFAULT_SLOW_WEIGHTS = {
  "server/src/__tests__/c02-claim.test.ts": 182, "server/src/__tests__/qa-correction-commit-validation.test.ts": 164,
  "server/src/__tests__/runtime-shutdown-process.integration.test.ts": 117, "server/src/__tests__/qa-correction-commit-source.test.ts": 109,
  "server/src/__tests__/heartbeat-context-budget-preflight.test.ts": 90, "server/src/__tests__/workflow-qa-byte-transport.test.ts": 90,
  "server/src/__tests__/c02-attempt.test.ts": 85, "server/src/__tests__/workflow-publication-result.test.ts": 85,
  "server/src/__tests__/c02-qa-artifact-request.test.ts": 79, "server/src/__tests__/qa-remediation-reconcile.test.ts": 77,
  "server/src/__tests__/c02-producer-attempt.test.ts": 76, "server/src/__tests__/c02-delivery-public.test.ts": 73,
  "server/src/__tests__/qa-correction-commit-candidate.test.ts": 72, "server/src/__tests__/c02-cascade-child-liveness.test.ts": 71,
  "server/src/__tests__/workflow-publication-verify.test.ts": 70, "server/src/__tests__/qa-correction-storage.test.ts": 66,
  "server/src/__tests__/c02-delivery-root.test.ts": 65, "server/src/__tests__/c02-consumption.test.ts": 64,
  "server/src/__tests__/c02-consumption-proof.test.ts": 60,
};

const toRel = (root, p) => relative(root, isAbsolute(p) ? p : resolve(root, p)).split(sep).join("/");
const uniqSorted = (xs) => [...new Set(xs)].sort();

export function partitionTestFiles(files, totalShards, weights = {}) {
  if (!Number.isInteger(totalShards) || totalShards < 1) throw new Error(`invalid totalShards ${totalShards}`);
  const w = (f) => weights[f] ?? 1;
  const queue = uniqSorted(files).sort((a, b) => w(b) - w(a) || (a < b ? -1 : 1));
  const shards = Array.from({ length: totalShards }, () => []), load = Array(totalShards).fill(0);
  for (const f of queue) { // LPT: heaviest first onto the lightest shard (lowest index on ties)
    let best = 0;
    for (let i = 1; i < totalShards; i++) if (load[i] < load[best]) best = i;
    shards[best].push(f); load[best] += w(f);
  }
  const flat = shards.flat();
  if (flat.length !== queue.length || new Set(flat).size !== flat.length) throw new Error("partition lost or duplicated files");
  return shards.map((s) => s.sort());
}

export function assertExactSelection(expectedFiles, selectedFiles) {
  for (const [label, xs] of [["expected", expectedFiles], ["selected", selectedFiles]])
    if (new Set(xs).size !== xs.length) throw new Error(`${label} file list contains duplicate entries`);
  const want = new Set(expectedFiles), got = new Set(selectedFiles);
  const extra = [...got].filter((f) => !want.has(f)).sort(), missing = [...want].filter((f) => !got.has(f)).sort();
  if (extra.length || missing.length) throw new Error(`selection mismatch — extra: [${extra.join(", ")}] missing: [${missing.join(", ")}]`);
}

export function resolveSpawnExitCode(result, label) {
  if (result.status === 0 && !result.error && !result.signal) return 0;
  const why = result.error ? `${result.error.code || result.error.message}` : result.signal ? `signal ${result.signal}` : `exit ${result.status}`;
  console.error(`${label} failed: ${why}`);
  return typeof result.status === "number" && result.status !== 0 ? result.status : 1;
}

export function discoverTestFiles(repoRoot, filterArgs = [], spawn = spawnSync) {
  // --json MUST be the last arg: cac reads a positional after --json as an output FILE path, which
  // would eat a filter argument and overwrite a repo file instead of printing to stdout.
  const res = spawn("pnpm", ["exec", "vitest", "list", "--filesOnly", ...filterArgs, "--json"], { cwd: repoRoot, env: process.env, encoding: "utf8" });
  const code = resolveSpawnExitCode(res, "vitest list");
  if (code !== 0) throw new Error(`vitest list failed (exit ${code})`);
  let list;
  try { list = JSON.parse(String(res.stdout)); }
  catch (e) { throw new Error(`vitest list --json output unparsable: ${e.message}`); }
  if (!Array.isArray(list) || list.some((e) => !e || typeof e.file !== "string" || !e.file))
    throw new Error("vitest list --json output is not a [{file, projectName}] array");
  return uniqSorted(list.map((e) => toRel(repoRoot, e.file))); // vitest 3 --json: [{file: "<abs>", projectName}]
}

export function extractExecutedFilesFromJsonReport(reportPath, repoRoot) {
  let report;
  try { report = JSON.parse(readFileSync(reportPath, "utf8")); }
  catch (e) { throw new Error(`unreadable vitest JSON report ${reportPath}: ${e.message}`); }
  if (!report || !Array.isArray(report.testResults)) throw new Error(`invalid vitest JSON report ${reportPath}: missing testResults[]`);
  const files = report.testResults.map((t) => {
    if (!t || typeof t.name !== "string" || !t.name) throw new Error(`invalid testResults entry in ${reportPath}`);
    return toRel(repoRoot, t.name);
  });
  if (new Set(files).size !== files.length) throw new Error(`duplicate file entries in vitest JSON report ${reportPath}`);
  return uniqSorted(files);
}

export function verifyShardManifests(manifests, { expectedSha, expectedShards } = {}) {
  manifests.forEach((m, i) => {
    const bad = (why) => { throw new Error(`shard manifest[${i}]: ${why}`); };
    if (m?.schemaVersion !== 1) bad("schemaVersion !== 1");
    if (typeof m.commitSha !== "string" || !m.commitSha) bad("commitSha missing");
    if (!Number.isInteger(m.shardIndex) || !Number.isInteger(m.totalShards) || m.shardIndex < 1 || m.shardIndex > m.totalShards) bad("shardIndex/totalShards invalid");
    for (const k of ["discoveredFiles", "executedFiles"]) {
      if (!Array.isArray(m[k]) || m[k].some((f) => typeof f !== "string" || !f)) bad(`${k} invalid`);
      if (new Set(m[k]).size !== m[k].length) bad(`${k} has duplicate entries`);
    }
  });
  if (!manifests.length) throw new Error("no shard manifests");
  const total = manifests[0].totalShards;
  if (manifests.length !== total || !manifests.every((m) => m.totalShards === total) || (expectedShards !== undefined && total !== expectedShards))
    throw new Error(`inconsistent shard set: count=${manifests.length} totalShards=${total} expected=${expectedShards}`);
  const covered = manifests.map((m) => m.shardIndex).sort((a, b) => a - b);
  if (!covered.every((v, i) => v === i + 1)) throw new Error(`shard coverage ${covered} != 1..${total}`);
  const sha = manifests[0].commitSha;
  if (!manifests.every((m) => m.commitSha === sha)) throw new Error("commitSha mismatch across manifests");
  if (expectedSha !== undefined && sha !== expectedSha) throw new Error(`commitSha ${sha} != expected ${expectedSha}`);
  const want = uniqSorted(manifests[0].discoveredFiles);
  if (!want.length) throw new Error("discoveredFiles is empty");
  const sameFiles = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]); // element-wise; join() conflates "\n" in names
  if (!manifests.every((m) => sameFiles(uniqSorted(m.discoveredFiles), want))) throw new Error("discoveredFiles mismatch across shards");
  const wantSet = new Set(want), seen = new Set(), dups = new Set(), unexpected = new Set();
  for (const m of manifests) for (const f of m.executedFiles) {
    if (!wantSet.has(f)) unexpected.add(f);
    (seen.has(f) ? dups : seen).add(f);
  }
  const omitted = want.filter((f) => !seen.has(f));
  if (omitted.length || dups.size || unexpected.size)
    throw new Error(`executed coverage — omitted: [${omitted.join(", ")}] duplicated: [${[...dups].join(", ")}] unexpected: [${[...unexpected].join(", ")}]`);
}

const gitSha = (root) => execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();

const defaultExecute = ({ repoRoot, files }, spawn = spawnSync) => {
  const out = join(tmpdir(), `vitest-shard-${process.pid}-${Date.now()}.json`);
  try {
    const res = spawn("pnpm", ["exec", "vitest", "run", "--reporter=default", "--reporter=json", `--outputFile=${out}`, ...files],
      { cwd: repoRoot, env: process.env, stdio: "inherit" });
    const code = resolveSpawnExitCode(res, "vitest run");
    if (code !== 0) throw new Error(`vitest run failed (exit ${code})`);
    return extractExecutedFilesFromJsonReport(out, repoRoot);
  } finally { rmSync(out, { force: true }); }
};

export function listShard({ repoRoot, shardIndex, totalShards, discover = discoverTestFiles, weights = DEFAULT_SLOW_WEIGHTS }) {
  if (!Number.isInteger(shardIndex) || !Number.isInteger(totalShards) || shardIndex < 1 || shardIndex > totalShards)
    throw new Error(`invalid shard ${shardIndex}/${totalShards} (need 1..${totalShards})`);
  const allFiles = discover(repoRoot);
  if (!allFiles.length) throw new Error("unfiltered discovery returned 0 test files — refusing to silently pass");
  return partitionTestFiles(allFiles, totalShards, weights)[shardIndex - 1];
}

export function runShard({ repoRoot, shardIndex, totalShards, manifestOut, commitSha, discover = discoverTestFiles, execute, spawn, weights = DEFAULT_SLOW_WEIGHTS }) {
  if (!Number.isInteger(shardIndex) || !Number.isInteger(totalShards) || shardIndex < 1 || shardIndex > totalShards)
    throw new Error(`invalid shard ${shardIndex}/${totalShards} (need 1..${totalShards})`);
  const allFiles = discover(repoRoot);
  if (!allFiles.length) throw new Error("unfiltered discovery returned 0 test files — refusing to silently pass");
  const shardFiles = partitionTestFiles(allFiles, totalShards, weights)[shardIndex - 1];
  const sha = commitSha ?? gitSha(repoRoot); // commitSha override is for unit tests only; CLI never passes it
  const writeManifest = (executedFiles) => {
    if (manifestOut) writeFileSync(manifestOut, JSON.stringify({ schemaVersion: 1, commitSha: sha, shardIndex, totalShards, discoveredFiles: allFiles, executedFiles }, null, 2) + "\n");
  };
  if (!shardFiles.length) {
    console.log(`shard ${shardIndex}/${totalShards}: 0 of ${allFiles.length} files assigned — skipping`);
    writeManifest([]); return 0;
  }
  assertExactSelection(shardFiles, discover(repoRoot, shardFiles)); // pre-execution selection proof
  const executedFiles = (execute ?? ((o) => defaultExecute(o, spawn)))({ repoRoot, files: shardFiles });
  assertExactSelection(shardFiles, executedFiles); // post-execution report proof
  writeManifest(executedFiles);
  return 0;
}

function cli(argv) {
  const repoRoot = process.cwd(), flag = (f) => { const i = argv.indexOf(f); return i === -1 ? undefined : argv[i + 1]; };
  const shard = () => {
    const m = /^(\d+)\/(\d+)$/.exec(argv[1] || "");
    if (!m || +m[1] < 1 || +m[1] > +m[2]) throw new Error(`invalid shard "${argv[1]}" — need k/n with 1 <= k <= n`);
    return { shardIndex: +m[1], totalShards: +m[2] };
  };
  if (argv[0] === "--verify-manifests") {
    const n = flag("--expected-shards"), manifests = readdirSync(argv[1]).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(argv[1], f), "utf8")));
    verifyShardManifests(manifests, { expectedSha: flag("--expected-sha"), expectedShards: n === undefined ? undefined : +n });
    console.log(`verified ${manifests.length} shard manifests in ${argv[1]}`);
    return 0;
  }
  if (argv[0] === "--list-shard") for (const f of listShard({ repoRoot, ...shard() })) console.log(f);
  else if (argv[0] === "--run-shard") return runShard({ repoRoot, ...shard(), manifestOut: flag("--manifest-out") });
  else throw new Error("usage: ci-vitest-shard.mjs --list-shard k/n | --run-shard k/n [--manifest-out p] | --verify-manifests dir [--expected-sha sha] [--expected-shards n]");
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = cli(process.argv.slice(2)); }
  catch (e) { console.error(e.stack ?? String(e)); process.exitCode = 1; }
}
