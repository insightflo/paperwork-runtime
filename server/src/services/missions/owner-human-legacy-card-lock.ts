import { and, eq } from "drizzle-orm";
import { heartbeatRuns, issues, missions, workflowRuns, workflowStepRuns, workflowTransitionEvents } from "@paperclipai/db";
import type { CreateOperatorDecisionInput } from "@paperclipai/shared/types/operator-decision";
import { operatorDecisionSourceContextSchema } from "@paperclipai/shared/validators/operator-decision";
import { unprocessable } from "../../errors.js";
import { MISSION_OWNER_HUMAN_INPUT_SOURCE_TYPE } from "../operator-decision-currentness.js";
import { MISSION_OWNER_DECISION_EVENT_TYPE, MISSION_OWNER_DECISION_SOURCE, MISSION_OWNER_RECOVERY_LAYER }
  from "./mission-owner-decision-contract.js";
import type { OwnerHumanTx } from "./owner-human-request-contract.js";

const ownerUnblockOrigin = "mission_main_executor_unblock";
const TERMINAL_REPORT_EVENT_TYPE = "terminal_mission_human_operator_report";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function invalidScope(): never {
  throw unprocessable("Legacy human request target is not bound to its company mission", {
    code: "owner_human_target_scope_unproven",
  });
}

function isPayload(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Keep the existing owner-decision producer heartbeat-bound while recognizing the two
 * system producers whose structured event contracts intentionally have no heartbeat.
 * The exact recovery reader remains narrower and continues to require its own authority.
 */
function hasSupportedEventBinding(event: {
  eventType: string; layer: string; reason: string | null; reasonCode: string | null;
  decision: string | null; correlationId: string | null; workflowRunId: string | null;
  issueId: string | null; payload: unknown; heartbeatRunId: string | null;
}, issueId: string, sourceIssueId: string): boolean {
  if (!isPayload(event.payload)) return false;
  const payload = event.payload;

  if (event.eventType === MISSION_OWNER_DECISION_EVENT_TYPE) {
    return event.layer === MISSION_OWNER_RECOVERY_LAYER
      && event.reason === MISSION_OWNER_DECISION_SOURCE
      && event.reasonCode === MISSION_OWNER_DECISION_SOURCE
      && event.heartbeatRunId !== null
      && payload.kind === MISSION_OWNER_DECISION_EVENT_TYPE
      && payload.source === MISSION_OWNER_DECISION_SOURCE
      && payload.ownerActionIssueId === issueId
      && payload.sourceIssueId === sourceIssueId
      && payload.decision === event.decision;
  }

  if (event.eventType === TERMINAL_REPORT_EVENT_TYPE) {
    // [교차 이슈 앵커 2026-11-21] terminal report 행은 claim 당시의 owner-action 이슈에
    //   issueId·correlationId·payload.ownerActionIssueId 를 모두 맞춰 쓴다. 스냅샷 재사용으로
    //   카드가 새 owner-action 이슈에 붙을 수 있으므로 카드 앵커와의 동등 비교 대신 행 내부
    //   정합성(세 결속이 같은 이슈를 가리킴)을 증명한다 — 실제 결속 이슈의 자격은 호출부의
    //   owner-action 검증이 보장한다. 다른 생산자의 비교는 그대로다.
    return event.layer === "workflow_validation"
      && event.reason === "terminal_mission_no_continuation"
      && event.reasonCode === event.eventType
      && event.decision === "escalate"
      && event.correlationId === event.issueId
      && payload.ownerActionIssueId === event.issueId
      && payload.workflowRunId === event.workflowRunId
      && payload.status === "reported";
  }

  if (event.eventType === "mission_owner_dead_target_escalation") {
    return event.layer === "mission_owner_recovery"
      && event.reasonCode === event.eventType
      && event.decision === "escalate"
      && payload.kind === event.eventType
      && payload.ownerActionIssueId === issueId
      && payload.anchorIssueId === issueId
      && payload.sourceIssueId === sourceIssueId;
  }

  return false;
}

/** Serialize supported legacy owner-unblock cards under their existing mission prefix. */
export async function lockLegacyOwnerHumanCardMission(
  tx: OwnerHumanTx,
  companyId: string,
  input: CreateOperatorDecisionInput,
): Promise<void> {
  if (input.sourceType !== MISSION_OWNER_HUMAN_INPUT_SOURCE_TYPE || input.requestKey.startsWith("moi2:")) return;
  if (input.issueId === null) {
    if (input.requestKey.startsWith("moi1:")) invalidScope();
    return;
  }

  const [observedOwner] = await tx.select({ companyId: issues.companyId, missionId: issues.missionId,
    originKind: issues.originKind }).from(issues).where(eq(issues.id, input.issueId));
  if (!observedOwner || observedOwner.companyId !== companyId || observedOwner.originKind !== ownerUnblockOrigin) return;
  const ownerMissionId = observedOwner.missionId;

  const context = operatorDecisionSourceContextSchema.safeParse(input.sourceContext);
  if (!context.success) invalidScope();
  const missionId = context.data.missionId;
  const snapshot = context.data.targetSnapshot;
  if (!missionId || !uuidPattern.test(missionId) || !ownerMissionId || missionId !== ownerMissionId
    || !snapshot || !snapshot.issueId || snapshot.issueId !== input.issueId
    || (snapshot.workflowRunStatus != null && snapshot.workflowRunId == null)
    || (snapshot.stepRunStatus != null && snapshot.stepRunId == null)
    || !uuidPattern.test(input.sourceId) || input.requestKey !== `moi1:${input.sourceId}`) invalidScope();

  const [mission] = await tx.select({ id: missions.id }).from(missions).where(and(
    eq(missions.id, missionId), eq(missions.companyId, companyId),
  )).for("update");
  if (!mission) invalidScope();

  const [owner] = await tx.select({ companyId: issues.companyId, missionId: issues.missionId,
    originKind: issues.originKind, originId: issues.originId }).from(issues).where(and(
    eq(issues.id, input.issueId), eq(issues.companyId, companyId),
  ));
  if (!owner || owner.missionId !== missionId || owner.originKind !== ownerUnblockOrigin
    || !owner.originId || !uuidPattern.test(owner.originId)) invalidScope();
  const [source] = await tx.select({ id: issues.id }).from(issues).where(and(
    eq(issues.id, owner.originId), eq(issues.companyId, companyId), eq(issues.missionId, missionId),
  ));
  if (!source) invalidScope();

  const [event] = await tx.select({ missionId: workflowTransitionEvents.missionId,
    issueId: workflowTransitionEvents.issueId, heartbeatRunId: workflowTransitionEvents.heartbeatRunId,
    workflowRunId: workflowTransitionEvents.workflowRunId,
    workflowStepRunId: workflowTransitionEvents.workflowStepRunId,
    eventType: workflowTransitionEvents.eventType, layer: workflowTransitionEvents.layer,
    reason: workflowTransitionEvents.reason, reasonCode: workflowTransitionEvents.reasonCode,
    decision: workflowTransitionEvents.decision, correlationId: workflowTransitionEvents.correlationId,
    payload: workflowTransitionEvents.payload }).from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.id, input.sourceId), eq(workflowTransitionEvents.companyId, companyId),
  ));
  if (!event || event.missionId !== missionId || !isPayload(event.payload)
    || !hasSupportedEventBinding(event, input.issueId, source.id)) invalidScope();
  // [교차 이슈 앵커 2026-11-21] 다른 moi1 생산자는 카드 앵커가 이벤트 행의 issue 와 같아야
  //   한다(기존 엄격 비교 유지). terminal report 만 예외: 이벤트가 묶인 owner-action 이
  //   종결돼 supervision 이 새 owner-action 을 고르면 스냅샷 재사용으로 카드가 새 이슈에 붙고
  //   행의 issue 와 어긋난다(132건의 422 폭주). 단, 그 경우에도 이벤트가 같은 회사·미션의
  //   owner-action 이슈에 실제로 묶여 있어야만 한다 — 그렇지 않으면 위조/교차 결속을 허용하게
  //   되므로 fail-closed 를 유지한다.
  const boundIssueId = event.eventType === TERMINAL_REPORT_EVENT_TYPE ? event.issueId : input.issueId;
  if (event.issueId !== input.issueId) {
    if (event.eventType !== TERMINAL_REPORT_EVENT_TYPE || !boundIssueId) invalidScope();
    const [boundIssue] = await tx.select({ id: issues.id }).from(issues).where(and(
      eq(issues.id, boundIssueId), eq(issues.companyId, companyId),
      eq(issues.missionId, missionId), eq(issues.originKind, ownerUnblockOrigin)));
    if (!boundIssue) invalidScope();
  }
  const payload = event.payload;
  if (event.heartbeatRunId) {
    if (!uuidPattern.test(event.heartbeatRunId)) invalidScope();
    const [heartbeat] = await tx.select({ issueId: heartbeatRuns.issueId }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, event.heartbeatRunId), eq(heartbeatRuns.companyId, companyId),
    ));
    if (!heartbeat || heartbeat.issueId !== boundIssueId) invalidScope();
  }
  const payloadOwner = payload.ownerActionIssueId;
  const payloadSource = payload.sourceIssueId;
  if ((payloadOwner !== undefined && payloadOwner !== boundIssueId)
    || (payloadSource !== undefined && payloadSource !== source.id)) invalidScope();

  const runIds = [context.data.workflowRunId, snapshot.workflowRunId, event.workflowRunId]
    .filter((id): id is string => typeof id === "string");
  if (runIds.some((id) => !uuidPattern.test(id)) || new Set(runIds).size > 1) invalidScope();
  const runId = runIds[0];
  if (runId) {
    const [run] = await tx.select({ id: workflowRuns.id }).from(workflowRuns).where(and(
      eq(workflowRuns.id, runId), eq(workflowRuns.companyId, companyId), eq(workflowRuns.missionId, missionId),
    ));
    if (!run) invalidScope();
  }

  const stepId = snapshot.stepRunId ?? event.workflowStepRunId;
  if (snapshot.stepRunId && event.workflowStepRunId && snapshot.stepRunId !== event.workflowStepRunId) invalidScope();
  if (stepId) {
    if (!uuidPattern.test(stepId) || (snapshot.executionGeneration != null && snapshot.stepRunId == null)) invalidScope();
    const [step] = await tx.select({ workflowRunId: workflowStepRuns.workflowRunId,
      executionGeneration: workflowStepRuns.executionGeneration, companyId: workflowRuns.companyId,
      missionId: workflowRuns.missionId }).from(workflowStepRuns)
      .innerJoin(workflowRuns, eq(workflowStepRuns.workflowRunId, workflowRuns.id))
      .where(eq(workflowStepRuns.id, stepId));
    if (!step || step.companyId !== companyId || step.missionId !== missionId
      || (runId !== undefined && step.workflowRunId !== runId)
      || (snapshot.executionGeneration != null && step.executionGeneration !== snapshot.executionGeneration)) invalidScope();
  } else if (snapshot.stepRunStatus != null || snapshot.executionGeneration != null) invalidScope();
}
