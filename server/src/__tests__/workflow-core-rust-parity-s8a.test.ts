import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { forwardReachable } from "../services/workflow/resume/graph.js";
import {
  normalizeWorkflowStepContract,
  normalizeWorkflowStepMachineChecks,
} from "../services/workflow/step-contract.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const rustBin = path.join(repoRoot, "crates/workflow-core/target/release/paperclip-workflow-core");

beforeAll(() => {
  execFileSync(process.env.CARGO || "cargo",
    ["build", "--release", "--manifest-path", path.join(repoRoot, "crates/workflow-core/Cargo.toml")],
    { stdio: "inherit" });
}, 120_000);

function rust(sub: string, payload: unknown): unknown {
  const stdout = execFileSync(rustBin, [sub], { input: JSON.stringify(payload), encoding: "utf8" });
  return JSON.parse(stdout);
}
// JSON 도메인 정규화 — -0→0, undefined 값 키 제거(Rust 측은 이미 직렬화된 텍스트).
const j = (v: unknown) => JSON.parse(JSON.stringify(v));
function parity(sub: string, payload: unknown, ts: () => unknown) {
  expect(rust(sub, payload)).toEqual(j(ts()));
}
function parityThrow(sub: string, payload: unknown, ts: () => unknown) {
  expect(ts).toThrow();
  expect(() => rust(sub, payload)).toThrow();
}

type ReachIn = { nodes?: unknown; startId?: unknown };
const reachOf = (input: ReachIn) =>
  ({ reachable: forwardReachable(input.nodes as never, input.startId as never) });
const reach = (input: ReachIn) => parity("forward-reachable", input, () => reachOf(input));
const reachThrow = (input: unknown) =>
  parityThrow("forward-reachable", input, () => reachOf(input as ReachIn));
const contract = (value: unknown) =>
  parity("normalize-step-contract", { value }, () => ({ contract: normalizeWorkflowStepContract(value) }));
const checks = (value: unknown) =>
  parity("normalize-step-machine-checks", { value },
    () => ({ machineChecks: normalizeWorkflowStepMachineChecks(value) ?? null }));

const ok = (over: Record<string, unknown> = {}) =>
  ({ id: "a", dependencies: [], conditionalDependencies: [], ...over });

describe("paperclip-workflow-core Rust parity (s8a: resume graph + step contract)", () => {
  it("forward-reachable: linear/fork/conditional edges, dedup, UTF-16 sort", () => {
    const graph = [
      { id: "a", dependencies: [], conditionalDependencies: [] },
      { id: "b", dependencies: ["a"], conditionalDependencies: [] },
      { id: "c", dependencies: ["b"], conditionalDependencies: [{ stepId: "a" }] },
      { id: "d", dependencies: [], conditionalDependencies: [{ stepId: "c" }] },
      { id: "z", dependencies: [], conditionalDependencies: [] }, // 비연결이어도 무사이클이면 허용
    ];
    reach({ nodes: graph, startId: "a" }); // a→b→c→d 전부 도달
    reach({ nodes: graph, startId: "d" });
    reach({ nodes: graph, startId: "z" });
    // 같은 from→to 중복(ordinary+conditional 걸쳐)은 dedup — 거부 아님
    reach({ nodes: [
      ok(),
      { id: "b", dependencies: ["a", "a"], conditionalDependencies: [{ stepId: "a", when: "x" }] },
    ], startId: "a" });
    // JS sort() = UTF-16 code-unit — 비BMP 쌍(D83D…)이 U+E000 보다 앞선다
    reach({ nodes: [
      { id: "s", dependencies: [], conditionalDependencies: [] },
      { id: "\u{1F600}", dependencies: ["s"], conditionalDependencies: [] },
      { id: "\uE000z", dependencies: ["s"], conditionalDependencies: [] },
      { id: "a", dependencies: ["s"], conditionalDependencies: [] },
    ], startId: "s" });
  });

  it("forward-reachable: missing/non-iterable dep fields throw (for..of TypeError)", () => {
    reachThrow({ nodes: [{ id: "a", conditionalDependencies: [] }], startId: "a" });
    reachThrow({ nodes: [{ id: "a", dependencies: [] }], startId: "a" });
    for (const deps of [null, 5, true, {}])
      reachThrow({ nodes: [{ id: "a", dependencies: deps, conditionalDependencies: [] }], startId: "a" });
    for (const conds of [null, 5, true, {}])
      reachThrow({ nodes: [{ id: "a", dependencies: [], conditionalDependencies: conds }], startId: "a" });
    // deps 문자열 — code-point 순회; 미상 문자는 reject, 알려진 id 는 간선
    reachThrow({ nodes: [ok({ dependencies: "ab" })], startId: "a" });
    reachThrow({ nodes: [ok({ dependencies: [["a"]] })], startId: "a" });
    reach({ nodes: [
      { id: "a", dependencies: [], conditionalDependencies: [] },
      { id: "b", dependencies: [], conditionalDependencies: [] },
      { id: "c", dependencies: "ab", conditionalDependencies: "" },
    ], startId: "a" });
    reach({ nodes: [ok({ dependencies: "", conditionalDependencies: "" })], startId: "a" });
    // conditionalDeps 비어있지 않은 문자열 — 첫 char 의 .stepId 는 undefined → reject
    reachThrow({ nodes: [ok({ conditionalDependencies: "a" })], startId: "a" });
  });

  it("forward-reachable: malformed nodes/ids/start targets reject", () => {
    reachThrow({ nodes: [], startId: "a" });
    reachThrow({ nodes: [null], startId: "a" }); // null.id — TypeError
    for (const n of [5, "x", true, ["a"]])
      reachThrow({ nodes: [n], startId: "a" });
    for (const id of ["", 5, null, ["a"], {}])
      reachThrow({ nodes: [{ id, dependencies: [], conditionalDependencies: [] }], startId: "a" });
    reachThrow({ nodes: [ok(), ok()], startId: "a" }); // duplicate id
    reachThrow({ nodes: [ok()], startId: "ghost" });
    reachThrow({ nodes: [ok()] }); // startId 부재
    for (const s of [5, null, ["a"], {}])
      reachThrow({ nodes: [ok()], startId: s });
    reachThrow({ nodes: [ok({ dependencies: ["ghost"] })], startId: "a" });
    reachThrow({ nodes: [ok({ dependencies: [5] })], startId: "a" });
    reachThrow({ nodes: [ok({ dependencies: [null] })], startId: "a" });
    reachThrow({ nodes: [ok({ conditionalDependencies: [{ stepId: "ghost" }] })], startId: "a" });
    reachThrow({ nodes: [ok({ conditionalDependencies: [null] })], startId: "a" }); // TypeError
    reachThrow({ nodes: [ok({ conditionalDependencies: [5] })], startId: "a" });
    reachThrow({ nodes: [ok({ conditionalDependencies: [["a"]] })], startId: "a" });
    reachThrow({ nodes: [ok({ conditionalDependencies: [{ stepId: 5 }] })], startId: "a" });
    reachThrow({ nodes: [ok({ conditionalDependencies: [{}] })], startId: "a" });
  });

  it("forward-reachable: self-edge and cycles (incl. disconnected) reject", () => {
    reachThrow({ nodes: [ok({ dependencies: ["a"] })], startId: "a" });
    reachThrow({ nodes: [ok({ conditionalDependencies: [{ stepId: "a" }] })], startId: "a" });
    const cyc = [
      { id: "a", dependencies: [], conditionalDependencies: [] },
      { id: "b", dependencies: ["c"], conditionalDependencies: [] },
      { id: "c", dependencies: ["b"], conditionalDependencies: [] },
    ];
    reachThrow({ nodes: cyc, startId: "a" }); // 비연결 컴포넌트 사이클도 reject
    reachThrow({ nodes: cyc, startId: "b" });
    reachThrow({ nodes: [
      { id: "a", dependencies: ["c"], conditionalDependencies: [] },
      { id: "b", dependencies: ["a"], conditionalDependencies: [] },
      { id: "c", dependencies: ["b"], conditionalDependencies: [] },
    ], startId: "a" });
  });

  it("forward-reachable: non-iterable nodes container rejects", () => {
    for (const input of [{}, { nodes: null }, { nodes: 5 }, { nodes: true },
      { nodes: {} }, { nodes: "ab" }, null, 5, "x"])
      reachThrow(input);
    reachThrow({ nodes: "", startId: "a" });
  });

  it("normalize-step-contract: non-object and section filtering", () => {
    for (const v of [null, 5, "x", true, [1], [], {}]) contract(v);
    contract({ preconditions: ["  a  ", " ", "b"], postconditions: [] });
    contract({ preconditions: [5, null, " x ", {}, ["y"], ""] });
    contract({ postconditions: "not-array", undefinedBehaviors: [1, "u"] });
    contract({ preconditions: [], postconditions: null }); // → null
    // JS trim — FEFF·ZS 공백은 제거, U+0085(NEL)는 유지
    contract({ preconditions: ["\uFEFFok\uFEFF", " n ", "　sp　", "\u0085k\u0085"] });
    contract({ machineChecks: "x" }); // 비배열 → 섹션 없음 → null
    contract({ preconditions: ["a"], machineChecks: [{ kind: "nope" }] });
    contract({ machineChecks: [{ kind: "file_exists", path: " /p " }] });
  });

  it("normalize-step-machine-checks: raw filtering and kind dispatch", () => {
    for (const v of [null, 5, "x", true, {}, { 0: { kind: "file_exists", path: "p" } }])
      checks(v);
    checks([]);
    checks([5, "x", null, [1], true]);
    checks([{ kind: "FILE_EXISTS", path: "p" }, { kind: "nope" }, { kind: 5 }, {}]);
    checks([{ kind: " file_exists ", path: "p" }]); // kind 자체도 trim
  });

  it("normalize-step-machine-checks: per-kind field/length/int gates", () => {
    checks([{ kind: "file_exists", path: "p" }]);
    checks([{ kind: "file_exists" }, { kind: "file_exists", path: " " },
      { kind: "file_exists", path: 5 }]); // 전부 drop → null
    checks([{ kind: "file_exists", path: "x".repeat(500) }]);
    checks([{ kind: "file_exists", path: "x".repeat(501) }]);
    checks([{ kind: "file_exists", path: "\u{1F600}".repeat(250) }]); // 500 UTF-16 units
    checks([{ kind: "file_exists", path: "\u{1F600}".repeat(251) }]); // 502 → null
    checks([{ kind: "file_glob", dir: "d", glob: "g" }]); // minCount default 1
    checks([{ kind: "file_glob", dir: "d", glob: "g", minCount: 3 }]);
    checks([{ kind: "file_glob", dir: "d", glob: "g", minCount: 1e300 }]);
    for (const minCount of [0, -1, 2.5, "3", null, true, []])
      checks([{ kind: "file_glob", dir: "d", glob: "g", minCount }]);
    checks([{ kind: "file_glob", glob: "g" }, { kind: "file_glob", dir: "d" }]); // → null
    checks([{ kind: "min_size_bytes", path: "p", minBytes: 0 }]);
    checks([{ kind: "min_size_bytes", path: "p", minBytes: -0 }]); // -0 도 ≥0 — JSON 출력은 0
    for (const minBytes of [-1, 0.5, "5", null])
      checks([{ kind: "min_size_bytes", path: "p", minBytes }]);
    checks([{ kind: "min_size_bytes", minBytes: 5 }]); // path 없음 → null
    const hex = (c: string, n: number) => ({ kind: "content_sha256", path: "p", sha256: c.repeat(n) });
    checks([hex("a", 64), hex("A", 64)]);
    checks([{ kind: "content_sha256", path: "p", sha256: `  ${"b".repeat(64)}  ` }]); // trim 후 hex
    checks([hex("g", 64), hex("a", 63), hex("a", 65)]); // → null
    checks(Array.from({ length: 25 }, () => ({ kind: "file_exists", path: "p" }))); // 20 cap
  });
});
