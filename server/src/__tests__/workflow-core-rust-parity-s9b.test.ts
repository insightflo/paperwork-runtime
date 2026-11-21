import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { validateDag } from "../services/workflow/dag-validation.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const rustBin = path.join(repoRoot, "crates/workflow-core/target/release/paperclip-workflow-core");

beforeAll(() => {
  execFileSync(process.env.CARGO || "cargo",
    ["build", "--release", "--manifest-path", path.join(repoRoot, "crates/workflow-core/Cargo.toml")],
    { stdio: "inherit" });
}, 120_000);

function rustDag(steps: unknown[]): { valid: boolean; errors: string[]; warnings: string[] } {
  const stdout = execFileSync(rustBin, ["validate-dag"], {
    input: JSON.stringify({ steps }), encoding: "utf8",
  });
  return JSON.parse(stdout);
}
const j = (v: unknown) => JSON.parse(JSON.stringify(v));
const dag = (steps: unknown[]) =>
  expect(rustDag(steps)).toEqual(j(validateDag(steps as never)));

// 공통 fixture — work_product_json source 가 step "a" 를 가리키는 단일 조건.
const src = (over: Record<string, unknown> = {}) =>
  ({ kind: "work_product_json", stepId: "a", path: "$.x", title: "t", ...over });
const cnd = (stepId: unknown, over: Record<string, unknown> = {}) => ({
  source: { kind: "work_product_json", stepId, path: "$.x", title: "t" },
  dataType: "number", operator: "greater_than", rightValue: 1, ...over,
});
const grp = (conditions: unknown[]) => ({ combinator: "all", conditions });
const a = { id: "a", dependencies: [] };
// IF 가 요구하는 condition_true/false 출력 edge 두 개.
const fan = (ifId: string) => [
  { id: `${ifId}T`, dependencies: [], conditionalDependencies: [{ stepId: ifId, when: "condition_true" }] },
  { id: `${ifId}F`, dependencies: [], conditionalDependencies: [{ stepId: ifId, when: "condition_false" }] },
];
const withGroup = (conditionGroup: unknown) =>
  [a, { id: "if1", type: "if", dependencies: ["a"], conditionGroup }, ...fan("if1")];
const core = () => [...withGroup(grp([cnd("a")]))];
const done = (ifId: string) => ({
  id: "done", type: "complete", dependencies: [],
  conditionalDependencies: [{ stepId: ifId, when: "condition_true" }],
});

describe("paperclip-workflow-core Rust parity (s9b: control-node validation residue)", () => {
  it("conditionGroup zod: strict keys, combinator, count bounds, condition fields", () => {
    for (const g of [
      grp([cnd("a")]),                          // 기준 유효
      { ...grp([cnd("a")]), extra: 1 },          // strict 그룹 키
      { combinator: "all" },                     // conditions 필수
      { combinator: "any", conditions: [] },     // min(1)
      grp(Array.from({ length: 20 }, () => cnd("a"))),   // max 경계 유효
      grp(Array.from({ length: 21 }, () => cnd("a"))),   // max 초과
      grp([{ ...cnd("a"), extra: 1 }]),          // strict 조건 키
      grp([5]),                                  // 비객체 조건
      grp([{ ...cnd("a"), source: 5 }]),
      grp([{ ...cnd("a"), dataType: "STRING" }]),
      grp([{ ...cnd("a"), operator: "" }]),      // 빈 operator
      grp([{ ...cnd("a"), operator: "is_true" }]), // union 소속·family 밖
      grp([{ ...cnd("a"), operator: "nope" }]),
      grp([{ ...cnd("a"), rightValue: null }]),  // null 우항
      grp([{ ...cnd("a"), rightValue: undefined }]), // undefined = 부재 → binary 필수
      grp([{ ...cnd("a"), rightValue: "1" }]),   // number family 에 문자열 우항
      grp([{ ...cnd("a"), dataType: "boolean", operator: "is_true" }]),
      grp([{ ...cnd("a"), dataType: "boolean", operator: "is_true", rightValue: true }]),
      grp([{ ...cnd("a"), dataType: "boolean", operator: "is_true", rightValue: undefined }]),
      grp([{ ...cnd("a"), dataType: "string", operator: "contains", rightValue: "x" }]),
      grp([{ ...cnd("a"), dataType: "string", operator: "contains", rightValue: 5 }]),
      grp([{ ...cnd("a"), dataType: "array", operator: "contains", rightValue: true }]),
      grp([{ ...cnd("a"), dataType: "array", operator: "contains", rightValue: { v: 1 } }]),
      grp([{ ...cnd("a"), dataType: "object", operator: "has_key", rightValue: " k " }]),
      grp([{ ...cnd("a"), dataType: "object", operator: "has_key", rightValue: "   " }]),
      grp([{ ...cnd("a"), dataType: "date_time", operator: "after", rightValue: "2024-02-29T00:00:00Z" }]), // 윤년 ok
      grp([{ ...cnd("a"), dataType: "date_time", operator: "after", rightValue: "2025-02-29T00:00:00Z" }]), // 평년 2/29 거부
      grp([{ ...cnd("a"), dataType: "date_time", operator: "after", rightValue: "2026-01-01T00:00+0900" }]), // 콜론 없는 offset 허용
      grp([{ ...cnd("a"), dataType: "date_time", operator: "after", rightValue: "2026-01-01T00:00+09" }]),   // offset 2자리 거부
      grp([{ ...cnd("a"), dataType: "date_time", operator: "after", rightValue: "2026-01-01T00:00:00+99:99" }]), // offset 범위 무검사 → 유효
      grp([{ ...cnd("a"), dataType: "date_time", operator: "after", rightValue: "2026-13-01T00:00:00Z" }]),   // 월 13 거부
      5, "x", [cnd("a")], null, true,            // 비객체 그룹
      { conditions: [cnd("a")] },                // combinator 필수
    ]) dag(withGroup(g));
  });

  it("conditionGroup zod: source union — kind 분기, trim/길이, path 문법, prototype 세그먼트", () => {
    const cond = (source: unknown) => ({ source, dataType: "number", operator: "equals", rightValue: 1 });
    const tool = (over: Record<string, unknown> = {}) =>
      ({ kind: "tool_json", stepId: "a", path: "$.x", toolName: "m", ...over });
    for (const source of [
      src({}),                                       // 유효 wp_json
      src({ extra: 1 }),                             // strict source 키
      { kind: "work_product_json", stepId: "a", path: "$.x" }, // title 필수
      src({ title: "  " }), src({ title: "x".repeat(256) }), src({ title: "x".repeat(255) }),
      src({ stepId: "  " }), src({ stepId: "x".repeat(121) }), src({ stepId: "x".repeat(120) }),
      src({ stepId: "\u{1F600}".repeat(61) }),       // UTF-16 122 > 120
      src({ stepId: "\u{1F600}".repeat(60) }),       // UTF-16 120 경계
      src({ path: "x" }), src({ path: "$." }), src({ path: "$..a" }),
      src({ path: "$[0]" }), src({ path: "$[00]" }), src({ path: "$[01]" }),
      src({ path: "$.a_b.C9" }), src({ path: "$.a-b" }),
      src({ path: "$.__proto__.x" }), src({ path: "$[0].prototype" }),
      src({ path: "$.constructor.x" }), src({ path: "$.constructorX" }), // 세그먼트 일치만 거부
      src({ path: "$." + "a".repeat(1023) }),        // 1025 > 1024
      src({ path: "$." + "a".repeat(1022) }),        // 1024 경계
      tool({}),                                      // 유효 tool_json
      tool({ parameters: {} }), tool({ parameters: { p: 1 } }),
      tool({ parameters: [1] }), tool({ parameters: null }), tool({ parameters: "x" }),
      tool({ toolName: "  " }), tool({ extra: 1 }),
      tool({ title: "t" }),                          // wp_json 키 누출 → strict 거부
      { kind: "bogus", stepId: "a", path: "$.x", title: "t" },
      { stepId: "a", path: "$.x", title: "t" },      // kind 부재
      { kind: 5, stepId: "a", path: "$.x", title: "t" },
      5, "x", null, [1], { kind: "work_product_json" },
    ]) dag(withGroup(grp([cond(source)])));
  });

  it("condition source: 자기참조/존재/forward-ancestor 규칙 (raw conditions 기준)", () => {
    const ifStep = (conditionGroup: unknown, over: Record<string, unknown> = {}) =>
      ({ id: "if1", type: "if", dependencies: ["a"], conditionGroup, ...over });
    dag(withGroup(grp([cnd("a")])));                                // legacy dep ancestor — 유효
    dag([a, { ...ifStep(grp([cnd("a")])), dependsOn: ["a"], dependencies: [] }, ...fan("if1")]); // dependsOn 도 ancestor
    dag(withGroup(grp([cnd("if1")])));                              // 자기참조
    dag(withGroup(grp([cnd("ghost")])));                            // 미존재
    dag([a, { id: "sib", dependencies: [] }, ifStep(grp([cnd("sib")])), ...fan("if1")]); // 존재·비ancestor
    dag(withGroup(grp([cnd("if1T")])));                             // 후손은 ancestor 아님
    dag(withGroup(grp([cnd("a"), cnd("ghost"), cnd("if1")])));      // 조건 순서대로 오류
    dag([a, { ...ifStep(grp([{ source: src({ stepId: "x" }), dataType: "number", operator: "equals", rightValue: 1 }])),
      conditionalDependencies: [{ stepId: "x", when: "qa_request_changes", isBackEdge: true, maxIterations: 2 }] },
      { id: "x", dependencies: [] }, ...fan("if1")]);               // back-edge 선행은 ancestor 아님
    dag([a, ifStep({ combinator: "bogus", conditions: [cnd("ghost")] }), ...fan("if1")]); // 무효 그룹 + ghost source 병행
    dag([a, ifStep([cnd("a")]), ...fan("if1")]);                    // 배열 그룹 → source 오류 없음
    dag([a, ifStep(grp([5, { source: {}, dataType: "x", operator: "y" }])), ...fan("if1")]); // 비객체+source 없음
    // JS trim 은 U+0085(NEL)를 유지 — Rust trim 과 다른 지점(agent/tool 지정 판정).
    dag([a, ifStep(grp([cnd("a")]), { agentId: " \u{85} " }), ...fan("if1")]);
    dag([a, ifStep(grp([cnd("a")]), { toolName: "\u{85}\u{85}" }), ...fan("if1")]);
    dag([a, { id: "done", type: "complete", dependencies: [], agentName: "\uFEFFx\uFEFF",
      conditionalDependencies: [{ stepId: "a", when: "condition_true" }] }]);
  });

  it("parallel-branch guard: allowed = IF ancestors + condition 갈래 후손 + complete 자신", () => {
    dag([...core(), done("if1")]);                                  // 유효 수렴
    dag([...core(), done("if1"), { id: "par", dependencies: ["a"] }]); // 별도 병렬 → "par"
    dag([...core(), { id: "par", dependencies: ["a"] }, done("if1"), { id: "par2", dependencies: ["a"] }]); // 첫 위반자 "par"
    dag([...core(), done("if1"), { id: "post", dependencies: ["if1F"] }]); // F 갈래 후손 → 허용
    dag([...core(), done("if1"), { id: "post0", dependencies: ["if1T"] }, { id: "deep", dependencies: ["post0"] }]); // 깊은 후손 → 허용
    dag([...core(), done("if1"), { id: "par", dependencies: ["if1"] }]); // IF 의 legacy 부속 → guard + IF-legacy 오류 병행
    dag([...core(), done("if1"), { id: "par", dependencies: ["done"] }]); // complete 후손 → 허용
    dag([a, done("a")]);                                            // 비-IF 진입 → origin 오류, guard 위반 없음
    dag([a, done("a"), { id: "par", dependencies: ["a"] }]);        // 비-IF 진입 + guard "par"
    dag([a, { id: "done", type: "complete", dependencies: [] }]);   // 진입 edge 없음 → guard 건너뜀
    dag([a, { id: "done", type: "complete", dependencies: [],
      conditionalDependencies: [{ stepId: "a", when: "condition_true", isBackEdge: true, maxIterations: 2 }] }]); // back-edge 진입 → 건너뜀
    dag([...core(), done("if1"), { id: "ret", dependencies: [],
      conditionalDependencies: [{ stepId: "if1", when: "qa_request_changes", isBackEdge: true, maxIterations: 2 }] }]); // back-edge 소속 step 은 별도 병렬
    dag([...core(), done("if1"), { id: "par", dependencies: ["a"] },
      { id: "done2", type: "complete", dependencies: [],
        conditionalDependencies: [{ stepId: "if1F", when: "condition_true" }] }]); // complete 두 개 — 순서대로 각각 판정
  });

  it("exact error strings for the ported rules", () => {
    expect(rustDag(withGroup(grp([cnd("ghost")]))).errors)
      .toContain('IF step "if1" condition source "ghost" does not exist');
    expect(rustDag(withGroup(grp([cnd("if1")]))).errors)
      .toContain('IF step "if1" cannot read its own output as a condition source');
    expect(rustDag([a, { id: "sib", dependencies: [] },
      { id: "if1", type: "if", dependencies: ["a"], conditionGroup: grp([cnd("sib")]) },
      ...fan("if1")]).errors)
      .toContain('IF step "if1" condition source "sib" is not a forward ancestor');
    expect(rustDag(withGroup(grp([{ dataType: "number", operator: "equals", rightValue: 1 }]))).errors)
      .toContain('IF step "if1" has a condition without a source stepId');
    expect(rustDag([...core(), done("if1"), { id: "par", dependencies: ["a"] }]).errors)
      .toContain('Complete step "done" would leave a separately reachable parallel branch active (step "par")');
  });
});
