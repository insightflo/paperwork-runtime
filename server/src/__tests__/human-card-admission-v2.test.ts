// [Admission v2 2026-11-21] 원인 분류기 + terminal report 카드 admission 게이트 회귀.
//   - classifyHumanCardCause: 구조화 cause 클래스(순수, DB 없음).
//   - evaluateHumanCardAdmission: v1 계약(cause/runId) 보존 + v2 분류 근거 추가.
//   - emitTerminalMissionHumanOperatorReport → ensure 카드: terminal report 는 여전히
//     발신되지만 원천의 자동 복구 원인에는 사람 결정 카드가 억제된다(fail-closed 유지).
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  missions,
  operatorDecisions,
  type Db,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { classifyHumanCardCause } from "../services/missions/human-card-cause-classifier.js";
import {
  evaluateHumanCardAdmission,
  type SourceTerminalRun,
} from "../services/missions/human-card-admission.js";
import { emitTerminalMissionHumanOperatorReport } from "../services/missions/terminal-mission-human-operator-alert.js";

const CARD_SUPPRESSED_ACTION = "mission.owner.human_input_card_suppressed";

describe("classifyHumanCardCause (structured cause classes)", () => {
  it.each([
    // 구조화 error_code exact match — 어느 클래스든 텍스트보다 우선한다.
    [{ errorCode: "adapter_failed" }, "provider_transient", true, "retry"],
    [{ errorCode: "stale_queued" }, "provider_transient", true, "retry"],
    [{ errorCode: "issue_status_blocked" }, "provider_transient", true, "retry"],
    [{ errorCode: "token_expired" }, "auth_refreshable", true, "refresh"],
    [{ errorCode: "auth_refreshable" }, "auth_refreshable", true, "refresh"],
    [{ errorCode: "quota_exceeded" }, "quota", false, "budget"],
    [{ errorCode: "budget_exhausted" }, "quota", false, "budget"],
    [{ errorCode: "insufficient_quota" }, "quota", false, "budget"],
    [{ errorCode: "assertion_failed" }, "internal_bug", false, "human"],
    [{ errorCode: "invariant_violation" }, "internal_bug", false, "human"],
    [{ errorCode: "schema_violation" }, "internal_bug", false, "human"],
    [{ errorCode: "unhandled_exception" }, "internal_bug", false, "human"],
    [{ errorCode: "workflow_run_failed" }, "unknown", false, "human"],
    [{ errorCode: "process_lost" }, "unknown", false, "human"],
    [{ errorCode: "commandcode_permission_denied" }, "unknown", false, "human"],
    [{ errorCode: null }, "unknown", false, "human"],
  ])("%o → %s", (input, causeClass, autoRecoverable, recoveryOwner) => {
    expect(classifyHumanCardCause(input)).toMatchObject({ causeClass, autoRecoverable, recoveryOwner });
  });

  it.each([
    // 등록된 error_code 는 텍스트보다 우선 — adapter_failed 는 문구와 무관하게 transient.
    [{ errorCode: "adapter_failed", error: "assertion failed inside worker" }, "provider_transient"],
    // 텍스트 보조 신호(error_code 미등록) — transient 어휘.
    [{ errorCode: "unexpected", error: "provider request failed: HTTP 429 rate limit" }, "provider_transient"],
    [{ errorCode: "unexpected", error: "request timed out after 300s" }, "provider_transient"],
    [{ errorCode: "unexpected", error: "connect ECONNRESET 10.0.0.1:443" }, "provider_transient"],
    [{ errorCode: "unexpected", error: "503 Service Unavailable" }, "provider_transient"],
    [{ errorCode: "unexpected", error: "upstream temporarily overloaded" }, "provider_transient"],
    // 우선순위: quota > provider_transient(429 라도 쿼터 소진은 재시도 무의미).
    [{ errorCode: "unexpected", error: "HTTP 429: insufficient_quota exceeded" }, "quota"],
    [{ errorCode: "unexpected", error: "billing hard limit reached" }, "quota"],
    // auth_refreshable: 갱신으로 회복되는 인증만 — generic 401/permission denied 는 아님.
    [{ errorCode: "unexpected", error: "401 Unauthorized: token_expired" }, "auth_refreshable"],
    [{ errorCode: "unexpected", error: "access token expired, refresh required" }, "auth_refreshable"],
    [{ errorCode: "unexpected", error: "401 Unauthorized" }, "unknown"],
    [{ errorCode: "unexpected", error: "permission denied on /srv/x" }, "unknown"],
    // 우선순위: internal_bug 어휘가 transient 어휘를 이긴다(fail-closed).
    [{ errorCode: "unexpected", error: "unhandled_exception: socket timeout" }, "internal_bug"],
    [{ errorCode: "unexpected", error: "schema_violation in adapter payload" }, "internal_bug"],
    // run status timed_out 은 timeout(transient) 신호 — 등록 코드가 있으면 코드가 우선.
    [{ status: "timed_out" }, "provider_transient"],
    [{ status: "timed_out", errorCode: "assertion_failed" }, "internal_bug"],
    [{ status: "timed_out", errorCode: "unexpected", error: "quota exceeded" }, "quota"],
  ])("precedence %o → %s", (input, causeClass) => {
    expect(classifyHumanCardCause(input).causeClass).toBe(causeClass);
  });
});

const sourceRun = (over: Partial<SourceTerminalRun>): SourceTerminalRun => ({
  id: "run-1",
  status: "failed",
  errorCode: null,
  error: null,
  settledAt: new Date(),
  ...over,
});

describe("evaluateHumanCardAdmission (v2 classifier-backed, v1 contract)", () => {
  it("rejects auto-recoverable causes with the same auto_recoverable_error_code contract", () => {
    for (const errorCode of ["adapter_failed", "stale_queued", "issue_status_blocked", "token_expired", "auth_refreshable"]) {
      const admission = evaluateHumanCardAdmission(sourceRun({ errorCode }));
      expect(admission.admit).toBe(false);
      expect(admission.cause).toBe("auto_recoverable_error_code");
      expect(admission.runId).toBe("run-1");
    }
    expect(evaluateHumanCardAdmission(sourceRun({ errorCode: "adapter_failed" })).causeClass).toBe("provider_transient");
    expect(evaluateHumanCardAdmission(sourceRun({ errorCode: "token_expired" })).causeClass).toBe("auth_refreshable");
  });

  it("suppresses timed_out runs and generic codes carrying transient text (429)", () => {
    expect(evaluateHumanCardAdmission(sourceRun({ status: "timed_out" })).admit).toBe(false);
    const rateLimited = evaluateHumanCardAdmission(sourceRun({
      errorCode: "workflow_run_failed",
      error: "provider request failed: HTTP 429 rate limit",
    }));
    expect(rateLimited.admit).toBe(false);
    expect(rateLimited.causeClass).toBe("provider_transient");
  });

  it("keeps settlement_pending for non-recoverable unsettled terminal runs", () => {
    const admission = evaluateHumanCardAdmission(sourceRun({ errorCode: "mystery_code", settledAt: null }));
    expect(admission).toMatchObject({ admit: false, cause: "settlement_pending", causeClass: "unknown" });
  });

  it("fails open for quota/internal_bug/unknown — no silent drop", () => {
    for (const errorCode of ["quota_exceeded", "budget_exhausted", "assertion_failed", "unhandled_exception", "mystery_code"]) {
      expect(evaluateHumanCardAdmission(sourceRun({ errorCode })).admit).toBe(true);
    }
    expect(evaluateHumanCardAdmission(sourceRun({ errorCode: "quota_exceeded" })).causeClass).toBe("quota");
    expect(evaluateHumanCardAdmission(sourceRun({ errorCode: "assertion_failed" })).causeClass).toBe("internal_bug");
    expect(evaluateHumanCardAdmission(sourceRun({ errorCode: "mystery_code" })).causeClass).toBe("unknown");
    expect(evaluateHumanCardAdmission(null).admit).toBe(true);
  });
});

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping admission-v2 DB tests: ${support.reason ?? "unsupported"}`);

describeDb("terminal report card admission gate (source admission)", () => {
  let db: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("hc-admission-v2-");
    db = createDb(tempDb.connectionString);
  }, 60_000);
  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  async function seed() {
    const ids = {
      companyId: randomUUID(), ownerAgentId: randomUUID(), missionId: randomUUID(),
      sourceIssueId: randomUUID(), ownerActionIssueId: randomUUID(),
    };
    await db.insert(companies).values({ id: ids.companyId, name: "Admission v2 Co", issuePrefix: randomUUID(), requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: ids.ownerAgentId, companyId: ids.companyId, name: "Owner", status: "active" });
    await db.insert(missions).values({ id: ids.missionId, companyId: ids.companyId, ownerAgentId: ids.ownerAgentId, title: "m", status: "active" });
    await db.insert(issues).values([
      { id: ids.sourceIssueId, companyId: ids.companyId, missionId: ids.missionId, title: "Source", status: "blocked" },
      { id: ids.ownerActionIssueId, companyId: ids.companyId, missionId: ids.missionId, title: "[Unblock] source",
        status: "blocked", assigneeAgentId: ids.ownerAgentId, originKind: "mission_main_executor_unblock", originId: ids.sourceIssueId },
    ]);
    return ids;
  }
  type Ids = Awaited<ReturnType<typeof seed>>;

  const seedSourceRun = (ids: Ids, run: { errorCode: string | null; error?: string | null; status?: string }) =>
    db.insert(heartbeatRuns).values({
      id: randomUUID(), companyId: ids.companyId, agentId: ids.ownerAgentId, issueId: ids.sourceIssueId,
      status: run.status ?? "failed", errorCode: run.errorCode, error: run.error ?? null,
      settledAt: new Date(), startedAt: new Date(), finishedAt: new Date(),
    });

  const emit = (ids: Ids, failedRunId = randomUUID()) => emitTerminalMissionHumanOperatorReport(db, {
    issue: {
      id: ids.ownerActionIssueId, companyId: ids.companyId, missionId: ids.missionId,
      originKind: "mission_main_executor_unblock", originId: ids.sourceIssueId, title: "[Unblock]", identifier: null,
    },
    expectedCompanyId: ids.companyId,
    expectedMissionId: ids.missionId,
    missionTitle: "m",
    sourceIssueIdentifier: "S",
    workflowRunId: null,
    failedRuns: [{ id: failedRunId, status: "failed", errorCode: "adapter_failed" }],
  });

  const cardCount = async (ids: Ids) => (await db
    .select({ id: operatorDecisions.id }).from(operatorDecisions)
    .where(eq(operatorDecisions.companyId, ids.companyId))).length;
  const suppressions = async (ids: Ids) => db.select().from(activityLog).where(and(
    eq(activityLog.companyId, ids.companyId), eq(activityLog.action, CARD_SUPPRESSED_ACTION)));

  it("repeated provider_transient terminal failures emit zero human cards (report still recorded)", async () => {
    const ids = await seed();
    await seedSourceRun(ids, { errorCode: "adapter_failed", error: "HTTP 429 rate limit" });
    const first = await emit(ids);
    expect(first.emitted).toBe(true); // terminal report(event/comment/inbox)는 감사로 남는다.
    expect(first.card).toEqual({ ensured: false, reason: "admission-suppressed:auto_recoverable_error_code" });

    // 반복된 일시 원인(다음 세대도 timeout 계열) — 새 스냅샷이어도 카드는 계속 0장.
    await seedSourceRun(ids, { status: "timed_out", errorCode: null });
    const second = await emit(ids);
    expect(second.card?.ensured).toBe(false);

    expect(await cardCount(ids)).toBe(0);
    const rows = await suppressions(ids);
    expect(rows.length).toBe(2);
    expect((rows[0]!.details as { causeClass?: string }).causeClass).toBe("provider_transient");
  });

  it("auth_refreshable terminal failure suppresses the card for refresh", async () => {
    const ids = await seed();
    await seedSourceRun(ids, { errorCode: "token_expired", error: "401 Unauthorized: token_expired" });
    const result = await emit(ids);
    expect(result.emitted).toBe(true);
    expect(result.card).toEqual({ ensured: false, reason: "admission-suppressed:auto_recoverable_error_code" });
    expect(await cardCount(ids)).toBe(0);
    expect((await suppressions(ids))[0]!.details).toMatchObject({ causeClass: "auth_refreshable", recoveryOwner: "refresh" });
  });

  it("internal_bug still emits the human card (fail-closed)", async () => {
    const ids = await seed();
    await seedSourceRun(ids, { errorCode: "assertion_failed", error: "invariant violated in runner" });
    const result = await emit(ids);
    expect(result.emitted).toBe(true);
    expect(result.card).toEqual({ ensured: true, reason: "card-created" });
    expect(await cardCount(ids)).toBe(1);
    expect(await suppressions(ids)).toHaveLength(0);
  });

  it("unknown causes still emit the human card (no silent drop)", async () => {
    const ids = await seed();
    await seedSourceRun(ids, { errorCode: "mystery_code", error: "unexplained terminal" });
    const result = await emit(ids);
    expect(result.card).toEqual({ ensured: true, reason: "card-created" });
    expect(await cardCount(ids)).toBe(1);
  });

  it("quota causes are not silently dropped — generic card remains the escalation surface", async () => {
    const ids = await seed();
    await seedSourceRun(ids, { errorCode: "quota_exceeded" });
    const result = await emit(ids);
    expect(result.card).toEqual({ ensured: true, reason: "card-created" });
    expect(await cardCount(ids)).toBe(1);
  });
});
