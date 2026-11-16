import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { toolDefinitions, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import {
  PREVIEW_NOW,
  cleanupPreviewTables,
  loadCapturedDefinition,
  previewResume,
  previewScope,
  seedPreviewGraph,
  startExecutionDefinitionFixture,
  type ExecutionDefinitionFixture,
} from "./helpers/workflow-resume-preview-fixture.js";
import { hashStructuredValue } from "../services/issue-execution-cards/hash.js";
import { resumeStepsHash } from "../services/workflow/resume/preview-policy.js";
import type { ReviewedResumePolicy } from "../services/workflow/resume/reviewed-policy.js";

/**
 * [purpose] stepsHash 안정 매칭(2026-11-15)의 결합 검증. definitionHash 가 run 마다 유일
 *   (payload 에 workflowRunId 포함)해서 exact 매칭만으로는 동일 그래프 형태의 새 run 을
 *   재개할 수 없었다. policyMissing 해소(stepsHash 매치) · 바인딩 불일치 unknown 복귀 ·
 *   모순 매니페스트 fail-closed · exact definitionHash 우선순위를 실제 DB/해시로 검증한다.
 *   REVIEWED_RESUME_POLICIES 는 컴파일 타임 불변 레지스트리라 테스트 주입은 모듈 경계
 *   (vi.mock)에서만 하고, 실제 매니페스트 검증은 vi.importActual 로 원본을 읽는다.
 */

const policyRegistry = vi.hoisted(() => ({ policies: [] as ReviewedResumePolicy[] }));

vi.mock("../services/workflow/resume/reviewed-policy.js", () => ({
  REVIEWED_RESUME_POLICIES: policyRegistry.policies,
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEP = embeddedPostgresSupport.supported ? describe : describe.skip;

const SHA256_RE = /^[0-9a-f]{64}$/u;

/** type=tool 단일 스텝 그래프 — effect unknown 이 external_effect_unknown 으로 나타나는 종류. */
const TOOL_STEP = [
  { id: "sh-tool", name: "Tool step", type: "tool", toolName: "resume-shape-tool", dependencies: [] },
];

function shapePolicy(
  graph: { companyId: string; definitionHash: string },
  captured: { executionMode: string; steps: unknown[] },
  steps: ReviewedResumePolicy["steps"],
): ReviewedResumePolicy {
  return {
    schemaVersion: 1,
    companyId: graph.companyId,
    definitionHash: "ab".repeat(32), // exact 매칭되지 않는 대표 해시(형식만 유효)
    stepsHash: resumeStepsHash(captured),
    steps,
    requiredGateStepIds: [],
    publicationStepIds: [],
    generationStepIds: [],
  };
}

describeEP("resume stepsHash 안정 매칭 — preview 결합", () => {
  let fixture: Extract<ExecutionDefinitionFixture, { supported: true }>;
  let db: Db;

  beforeAll(async () => {
    const started = await startExecutionDefinitionFixture("resume-steps-hash-");
    if (!started.supported) throw new Error(started.reason);
    fixture = started;
    db = fixture.db;
  }, 60_000);

  afterEach(async () => {
    policyRegistry.policies.length = 0;
    await cleanupPreviewTables(db);
  });

  afterAll(async () => {
    if (fixture?.supported) await fixture.cleanup();
  });

  function signer() {
    return { key: Buffer.from("cd".repeat(32), "hex"), now: () => PREVIEW_NOW };
  }

  it("exact definitionHash 불일치여도 stepsHash 가 같으면 policyMissing 이 해소된다", async () => {
    const graph = await seedPreviewGraph(fixture.sql, db, { stepsJson: TOOL_STEP });
    const captured = await loadCapturedDefinition(db, graph.runId);
    const [toolRow] = await db.insert(toolDefinitions).values({
      companyId: graph.companyId,
      name: "resume-shape-tool",
      adapterType: "builtin",
      adapterConfig: { kind: "stub" },
      inputSchema: { type: "object" },
    }).returning();
    policyRegistry.policies.push(shapePolicy(graph, captured, {
      "sh-tool": {
        effect: "read_only",
        toolBindings: [{
          id: toolRow!.id,
          updatedAt: toolRow!.updatedAt.toISOString(),
          configHash: hashStructuredValue({
            name: toolRow!.name, enabled: toolRow!.enabled, adapterType: toolRow!.adapterType,
            adapterConfig: toolRow!.adapterConfig, inputSchema: toolRow!.inputSchema,
          }),
        }],
      },
    }));
    const result = await previewResume(db, previewScope(graph), signer());
    expect(result.preview.eligible).toBe(true);
    expect(result.preview.blockers).toEqual([]);
    expect(result.preview.token).not.toBeNull();
  });

  it("같은 이름 다른 설정 — binding configHash 불일치 시 스텝 effect 는 unknown 으로 fail-closed", async () => {
    const graph = await seedPreviewGraph(fixture.sql, db, { stepsJson: TOOL_STEP });
    const captured = await loadCapturedDefinition(db, graph.runId);
    const [toolRow] = await db.insert(toolDefinitions).values({
      companyId: graph.companyId,
      name: "resume-shape-tool",
      adapterType: "builtin",
      adapterConfig: { kind: "stub" },
      inputSchema: { type: "object" },
    }).returning();
    policyRegistry.policies.push(shapePolicy(graph, captured, {
      "sh-tool": {
        effect: "read_only",
        toolBindings: [{
          id: toolRow!.id,
          updatedAt: toolRow!.updatedAt.toISOString(),
          configHash: hashStructuredValue({
            name: toolRow!.name, enabled: toolRow!.enabled, adapterType: toolRow!.adapterType,
            adapterConfig: { kind: "stub" }, inputSchema: toolRow!.inputSchema,
          }),
        }],
      },
    }));
    // 등록 시점과 같은 이름·다른 adapterConfig — stepsHash 매치여도 binding 대조 실패.
    await db.update(toolDefinitions).set({ adapterConfig: { kind: "changed" } }).where(eq(toolDefinitions.id, toolRow!.id));
    const result = await previewResume(db, previewScope(graph), signer());
    expect(result.preview.eligible).toBe(false);
    expect(result.preview.blockers.map((blocker) => blocker.code)).toEqual(["external_effect_unknown"]);
    expect(result.preview.token).toBeNull();
  });

  it("동일 stepsHash 엔트리 2건(모순 매니페스트)은 policy 부재로 fail-closed", async () => {
    const graph = await seedPreviewGraph(fixture.sql, db, { stepsJson: TOOL_STEP });
    const captured = await loadCapturedDefinition(db, graph.runId);
    const first = shapePolicy(graph, captured, { "sh-tool": { effect: "none", toolBindings: [] } });
    const second = shapePolicy(graph, captured, { "sh-tool": { effect: "read_only", toolBindings: [] } });
    policyRegistry.policies.push(first, second);
    const result = await previewResume(db, previewScope(graph), signer());
    expect(result.preview.eligible).toBe(false);
    // 전역 policyMissing 블로커 + tool 스텝 effect unknown 블로커가 둘 다 발생한다.
    expect(result.preview.blockers.map((blocker) => blocker.code))
      .toEqual(["external_effect_unknown", "external_effect_unknown"]);
  });

  it("stepsHash 를 선언하지 않은 엔트리는 형태 매칭에 참여하지 않는다(legacy exact 전용)", async () => {
    const graph = await seedPreviewGraph(fixture.sql, db, { stepsJson: TOOL_STEP });
    policyRegistry.policies.push({
      schemaVersion: 1,
      companyId: graph.companyId,
      definitionHash: "12".repeat(32), // 다른 run 의 exact 해시 — 이 run 과는 불일치
      steps: { "sh-tool": { effect: "none", toolBindings: [] } },
      requiredGateStepIds: [],
      publicationStepIds: [],
      generationStepIds: [],
    });
    const result = await previewResume(db, previewScope(graph), signer());
    expect(result.preview.eligible).toBe(false);
    // 전역 policyMissing 블로커 + tool 스텝 effect unknown 블로커가 둘 다 발생한다.
    expect(result.preview.blockers.map((blocker) => blocker.code))
      .toEqual(["external_effect_unknown", "external_effect_unknown"]);
  });

  it("exact definitionHash 매치가 stepsHash 매치보다 우선한다", async () => {
    const graph = await seedPreviewGraph(fixture.sql, db, { stepsJson: TOOL_STEP });
    const captured = await loadCapturedDefinition(db, graph.runId);
    // exact 엔트리: binding 없이 none → 적격이어야 한다.
    const exact: ReviewedResumePolicy = {
      schemaVersion: 1,
      companyId: graph.companyId,
      definitionHash: graph.definitionHash,
      steps: { "sh-tool": { effect: "none", toolBindings: [] } },
      requiredGateStepIds: [],
      publicationStepIds: [],
      generationStepIds: [],
    };
    // stepsHash 엔트리: 고장 binding(과거 updatedAt) — 참조되면 실패해야 한다.
    const byShape = shapePolicy(graph, captured, {
      "sh-tool": {
        effect: "read_only",
        toolBindings: [{ id: "00000000-0000-4000-8000-000000000000", updatedAt: "2020-01-01T00:00:00.000Z", configHash: "0".repeat(64) }],
      },
    });
    policyRegistry.policies.push(exact, byShape);
    const result = await previewResume(db, previewScope(graph), signer());
    expect(result.preview.eligible).toBe(true);
    expect(result.preview.blockers).toEqual([]);
  });
});

describe("실제 매니페스트 stepsHash 계약(원본 — 모의 없음)", () => {
  it("stepsHash 엔트리는 sha256 형식이고 (companyId, stepsHash) 가 유일하다", async () => {
    const actual = await vi.importActual<typeof import("../services/workflow/resume/reviewed-policy.js")>(
      "../services/workflow/resume/reviewed-policy.js",
    );
    const withShape = actual.REVIEWED_RESUME_POLICIES.filter((policy) => policy.stepsHash !== undefined);
    expect(withShape.length).toBeGreaterThanOrEqual(5); // 기존 2 + 초안 3
    const keys = withShape.map((policy) => `${policy.companyId}:${policy.stepsHash}`);
    for (const policy of withShape) expect(policy.stepsHash).toMatch(SHA256_RE);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("2026-11-15 초안 3형태가 게시 매핑과 external 발행 스텝을 선언한다", async () => {
    const actual = await vi.importActual<typeof import("../services/workflow/resume/reviewed-policy.js")>(
      "../services/workflow/resume/reviewed-policy.js",
    );
    const drafts = new Map(actual.REVIEWED_RESUME_POLICIES
      .filter((policy) => policy.stepsHash !== undefined)
      .map((policy) => [policy.stepsHash, policy] as const));
    // service-onboarding(53e4efae…) — 최근 7일 실패 8건 전부 + 현재 정의 형태.
    const service = drafts.get("53e4efaed26ec6c0234a026375b35e8eca4c7a55029dec16c0263747da161c8a");
    expect(service?.steps["publish-onboarding-manual"]?.effect).toBe("external");
    expect(service?.publicationStepIds).toContain("publish-onboarding-manual");
    expect(Object.keys(service?.steps ?? {})).toHaveLength(9);
    // agent-team-concept-radar(3e9719e4…) — 실패 2건 + 현재 정의 형태(14스텝).
    const radar = drafts.get("3e9719e40d6f3cbd39bb08adf9e7ebb6771f92c4335e3579b11a1c362c4cc15f");
    expect(radar?.steps["publish-concept-conditionally"]?.effect).toBe("external");
    expect(radar?.publicationStepIds).toContain("publish-concept-conditionally");
    expect(Object.keys(radar?.steps ?? {})).toHaveLength(14);
    // youtube-report 현행(b1f937ca…) — 2026-11-15 04:01 정의 수정 이후 형태.
    const youtube = drafts.get("b1f937ca9c92fa6186475397798134355ffd47d9d10bfa7bdd2e83231b7e2e43");
    expect(youtube?.steps["publish-onboarding-manual"]?.effect).toBe("external");
    expect(Object.keys(youtube?.steps ?? {})).toHaveLength(9);
    // n8n 수집기 2종은 2026-11-16 n8n API 실확인(지속 저장 노드 없음)으로 read_only 강등됐다.
    expect(radar?.steps["collect-arxiv-candidates"]?.effect).toBe("read_only");
    expect(radar?.steps["scout-social-ai-concepts"]?.effect).toBe("read_only");
  });
});
