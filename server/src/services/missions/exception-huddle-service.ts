import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import {
  agentWakeupRequests,
  collabChannels,
  collabMessages,
  collabThreads,
  type Db,
} from "@paperclipai/db";
import {
  exceptionHuddleMetadataSchema,
  exceptionHuddleRoleSchema,
  type ExceptionHuddleDecision,
} from "@paperclipai/shared/validators/exception-huddle";
import { HttpError, notFound } from "../../errors.js";
import { classifyExceptionHuddleEligibility } from "./exception-huddle-classifier.js";
import { createInitialExceptionHuddleState, evaluateHuddleDecision, evaluateHuddleTurn, type ExceptionHuddleState } from "./exception-huddle-state.js";
import { recordExceptionHuddleExecutionPlan } from "./exception-huddle-decision-audit.js";

const roundTurnsSchema = z.object({
  "1": z.array(exceptionHuddleRoleSchema),
  "2": z.array(exceptionHuddleRoleSchema),
}).strict();

export type ExceptionHuddleView = ExceptionHuddleState & { failureSummary: string };

export interface ConveneExceptionHuddleInput {
  companyId: string;
  missionId: string;
  workflowRunId: string;
  sourceStepId: string;
  sourceIssueId?: string | null;
  ownerAgentId: string;
  producerAgentId: string;
  validatorAgentId: string;
  workProductLinks: string[];
  failureSummary: string;
  errorCode?: string | null;
  errorSummary?: string | null;
  verdict?: string | null;
  stepRole?: string | null;
  failureKind?: string | null;
  qaFailureCount?: number | null;
  now?: Date;
  maxRounds?: number;
  timeoutMs?: number;
}

function uniqueAgentIds(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

function huddleTitle(sourceStepId: string, failureSummary: string): string {
  const summary = failureSummary.replace(/\s+/g, " ").trim();
  const title = `[Huddle] ${sourceStepId}: ${summary}`;
  return title.length <= 160 ? title : `${title.slice(0, 157)}...`;
}

function invalidHuddleState(): never {
  throw new HttpError(409, "huddle_state_invalid", { code: "huddle_state_invalid" });
}

function serializeHuddleMetadata(state: ExceptionHuddleState, failureSummary: string): Record<string, unknown> {
  const { roundTurns, ...metadataInput } = state;
  const metadata = exceptionHuddleMetadataSchema.parse(metadataInput);
  const turns = roundTurnsSchema.parse(roundTurns);
  return { ...metadata, roundTurns: turns, failureSummary };
}

function parseHuddleMetadata(value: unknown): ExceptionHuddleView | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== "workflow.exception-huddle.v1") return null;
  const { roundTurns, failureSummary, ...metadataInput } = record;
  const metadata = exceptionHuddleMetadataSchema.safeParse(metadataInput);
  const turns = roundTurnsSchema.safeParse(roundTurns);
  if (!metadata.success || !turns.success || typeof failureSummary !== "string" || failureSummary.trim() === "") {
    invalidHuddleState();
  }
  return {
    ...metadata.data,
    roundTurns: turns.data as unknown as ExceptionHuddleState["roundTurns"],
    failureSummary,
  };
}

function splitHuddle(view: ExceptionHuddleView): { state: ExceptionHuddleState; failureSummary: string } {
  const { failureSummary, ...state } = view;
  return { state: state as ExceptionHuddleState, failureSummary };
}

async function ensureHuddleChannel(db: Db, input: ConveneExceptionHuddleInput) {
  const slug = `mission-huddle-${input.missionId.slice(0, 8)}`;
  const scope = and(
    eq(collabChannels.companyId, input.companyId),
    eq(collabChannels.slug, slug),
    isNull(collabChannels.archivedAt),
  );
  const [existing] = await db.select().from(collabChannels).where(scope).limit(1);
  if (existing) return existing;
  const memberAgentIds = uniqueAgentIds([input.ownerAgentId, input.producerAgentId, input.validatorAgentId]);
  const [inserted] = await db.insert(collabChannels).values({
    companyId: input.companyId,
    slug,
    name: `Mission Huddle ${input.missionId.slice(0, 8)}`,
    description: "Structured exception huddle channel",
    memberAgentIds,
    leadAgentId: input.ownerAgentId,
  }).onConflictDoNothing().returning();
  if (inserted) return inserted;
  const [reread] = await db.select().from(collabChannels).where(scope).limit(1);
  if (reread) return reread;
  throw new HttpError(409, "huddle_channel_unavailable", { code: "huddle_channel_unavailable" });
}

async function loadHuddleRecord(db: Db, companyId: string, threadId: string, lock: boolean) {
  const threadQuery = db.select().from(collabThreads).where(and(
    eq(collabThreads.companyId, companyId),
    eq(collabThreads.id, threadId),
  )).limit(1);
  const [thread] = lock ? await threadQuery.for("update") : await threadQuery;
  if (!thread) return null;
  const messages = await db.select().from(collabMessages).where(and(
    eq(collabMessages.companyId, companyId),
    eq(collabMessages.threadId, threadId),
  )).orderBy(desc(collabMessages.createdAt));
  for (const message of messages) {
    const view = parseHuddleMetadata(message.metadata);
    if (view) return { thread, stateMessage: message, view };
  }
  return null;
}

async function loadHuddleOrThrow(db: Db, companyId: string, threadId: string, lock: boolean) {
  const record = await loadHuddleRecord(db, companyId, threadId, lock);
  if (!record) throw notFound("Huddle not found");
  return record;
}

export async function conveneExceptionHuddle(db: Db, input: ConveneExceptionHuddleInput) {
  const eligibility = classifyExceptionHuddleEligibility(input);
  if (!eligibility.eligible) return { convened: false as const, eligibility };
  const now = input.now ?? new Date();
  const participants = {
    ownerAgentId: input.ownerAgentId,
    producerAgentId: input.producerAgentId,
    validatorAgentId: input.validatorAgentId,
  };
  const state = createInitialExceptionHuddleState({
    missionId: input.missionId,
    workflowRunId: input.workflowRunId,
    sourceStepId: input.sourceStepId,
    sourceIssueId: input.sourceIssueId ?? null,
    workProductLinks: input.workProductLinks,
    participants,
    now,
    maxRounds: input.maxRounds,
    timeoutMs: input.timeoutMs,
  });
  const failureSummary = input.failureSummary.trim();
  const huddle: ExceptionHuddleView = { ...state, failureSummary };

  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    const channel = await ensureHuddleChannel(txDb, input);
    const [thread] = await tx.insert(collabThreads).values({
      companyId: input.companyId,
      channelId: channel.id,
      title: huddleTitle(input.sourceStepId, failureSummary),
      status: "open",
      ownerAgentId: input.ownerAgentId,
      rootIssueId: input.sourceIssueId ?? null,
      createdByActorType: "agent",
      createdByActorId: input.ownerAgentId,
    }).returning();
    const [seedMessage] = await tx.insert(collabMessages).values({
      companyId: input.companyId,
      channelId: channel.id,
      threadId: thread.id,
      authorType: "system",
      authorId: null,
      actionKind: "message",
      body: `Exception huddle convened for ${input.sourceStepId}. Owner chair must submit a structured decision.`,
      expectsReply: true,
      metadata: serializeHuddleMetadata(state, failureSummary),
    }).returning();
    for (const agentId of uniqueAgentIds([input.ownerAgentId, input.producerAgentId, input.validatorAgentId])) {
      await tx.insert(agentWakeupRequests).values({
        companyId: input.companyId,
        agentId,
        source: "on_demand",
        triggerDetail: "exception_huddle_convened",
        reason: "exception_huddle_convened",
        requestedByActorType: "system",
        requestedByActorId: null,
        idempotencyKey: `exception-huddle-convened:${thread.id}:${agentId}`,
        missionId: input.missionId,
        issueId: input.sourceIssueId ?? null,
        workflowRunId: input.workflowRunId,
        payload: {
          channelId: channel.id,
          threadId: thread.id,
          messageId: seedMessage.id,
          missionId: input.missionId,
          workflowRunId: input.workflowRunId,
          sourceStepId: input.sourceStepId,
          sourceIssueId: input.sourceIssueId ?? null,
        },
      });
    }
    return { convened: true as const, eligibility, channelId: channel.id, threadId: thread.id, huddle };
  });
}

export async function postExceptionHuddleTurn(
  db: Db,
  input: { companyId: string; threadId: string; actorAgentId: string; body: string; now?: Date },
) {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    const record = await loadHuddleOrThrow(txDb, input.companyId, input.threadId, true);
    const { state, failureSummary } = splitHuddle(record.view);
    const result = evaluateHuddleTurn(state, { actorAgentId: input.actorAgentId, now });
    if (!result.ok) throw new HttpError(409, result.code, { code: result.code });
    const [message] = await tx.insert(collabMessages).values({
      companyId: input.companyId,
      channelId: record.thread.channelId,
      threadId: record.thread.id,
      authorType: "agent",
      authorId: input.actorAgentId,
      actionKind: "channel_reply",
      body: input.body,
      expectsReply: false,
    }).returning();
    await tx.update(collabMessages).set({
      metadata: serializeHuddleMetadata(result.state, failureSummary),
    }).where(eq(collabMessages.id, record.stateMessage.id));
    await tx.update(collabThreads).set({ updatedAt: now }).where(eq(collabThreads.id, record.thread.id));
    return { threadId: record.thread.id, huddle: { ...result.state, failureSummary }, message };
  });
}

export async function decideExceptionHuddle(
  db: Db,
  input: { companyId: string; threadId: string; actorAgentId: string; decision: ExceptionHuddleDecision; now?: Date },
) {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    const record = await loadHuddleOrThrow(txDb, input.companyId, input.threadId, true);
    const { state, failureSummary } = splitHuddle(record.view);
    const result = evaluateHuddleDecision(state, { actorAgentId: input.actorAgentId, decision: input.decision, now });
    if (!result.ok) {
      throw new HttpError(result.code === "huddle_chair_only_decision" ? 403 : 409, result.code, { code: result.code });
    }
    await tx.update(collabMessages).set({
      metadata: serializeHuddleMetadata(result.state, failureSummary),
    }).where(eq(collabMessages.id, record.stateMessage.id));
    const decision = result.state.decision;
    await tx.insert(collabMessages).values({
      companyId: input.companyId,
      channelId: record.thread.channelId,
      threadId: record.thread.id,
      authorType: "system",
      authorId: null,
      actionKind: "channel_result",
      body: `Exception huddle decided: ${decision?.kind ?? "unknown"}.`,
      expectsReply: false,
      metadata: {
        decision,
        decidedByAgentId: result.state.decidedByAgentId,
        decidedAt: result.state.decidedAt,
      },
    });
    await tx.update(collabThreads).set({ status: "resolved", updatedAt: now }).where(eq(collabThreads.id, record.thread.id));
    const audit = await recordExceptionHuddleExecutionPlan(txDb, {
      companyId: input.companyId, threadId: record.thread.id, huddle: result.state, now,
    });
    return {
      threadId: record.thread.id,
      huddle: { ...result.state, failureSummary },
      nextAction: result.state.decision!.kind,
      executionPlan: audit.recorded ? audit.plan : null,
    };
  });
}

export async function getExceptionHuddle(db: Db, companyId: string, threadId: string) {
  const record = await loadHuddleRecord(db, companyId, threadId, false);
  if (!record) return null;
  const messages = await db.select().from(collabMessages).where(and(
    eq(collabMessages.companyId, companyId),
    eq(collabMessages.threadId, threadId),
  )).orderBy(asc(collabMessages.createdAt));
  return { thread: record.thread, huddle: record.view, messages };
}
