/**
 * Telegram Command Handler
 *
 * Handles incoming Telegram commands: /status, /mission, /approve, /assign.
 * Wires up with channel registry via registerTelegramHandler().
 */

import type { Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { agents, approvals, issues, missions } from "@paperclipai/db";
import { getChannelRegistry } from "../index.js";
import { persistChatId, registerChatId } from "./outbound.js";
import {
  formatMissionStatus,
  formatMissionCreated,
  formatError,
  formatHelp,
  formatSuccess,
} from "./formatter.js";
import type { TelegramMessage } from "./types.js";
import { missionService } from "../../services/missions.js";
import type { MissionDetail } from "../../services/missions.js";
import { issueService } from "../../services/issues.js";
import { approvalService } from "../../services/approvals.js";
import { heartbeatService } from "../../services/heartbeat.js";

/**
 * System actor ID used when Telegram acts on behalf of the system
 * (no authenticated user context available via Telegram).
 */
const TELEGRAM_SYSTEM_USER_ID = "telegram:system";

/**
 * Parse command arguments from message text.
 * Handles formats like "/cmd", "/cmd arg", "/cmd arg1 arg2".
 */
function parseArgs(text: string | undefined): { command: string; args: string[] } {
  if (!text || !text.startsWith("/")) {
    return { command: "", args: [] };
  }
  const parts = text.slice(1).split(/\s+/);
  const command = parts[0]?.split(/@/)[0] ?? "";
  const args = parts.slice(1).filter(Boolean);
  return { command, args };
}

/**
 * Build a TelegramMessageHandler for a given company.
 */
export function buildTelegramHandler(db: Db, _companyId: string) {
  return async function handleMessage(
    message: TelegramMessage,
    context: { companyId: string; botJwt: string },
  ): Promise<void> {
    const chatId = message.chat.id;
    // Register this chat for outbound notifications (and persist for restart survival)
    registerChatId(context.companyId, chatId);
    await persistChatId(db, context.companyId, chatId);

    const sender = getChannelRegistry().getTelegramSender(context.companyId);
    if (!sender) {
      return;
    }

    const { command, args } = parseArgs(message.text);

    try {
      if (!command) {
        await cmdOpsConversation(sender, chatId, message, db, context.companyId);
        return;
      }

      switch (command) {
        case "status":
          await cmdStatus(sender, chatId, context.companyId);
          break;
        case "mission":
          await cmdMission(sender, chatId, args, db, context.companyId);
          break;
        case "approve":
          await cmdApprove(sender, chatId, args, db, context.companyId);
          break;
        case "assign":
          await cmdAssign(sender, chatId, args, db, context.companyId);
          break;
        case "help":
          await sender(chatId, formatHelp());
          break;
        default:
          await sender(chatId, formatError(`Unknown command: /${command}. Use /help for available commands.`));
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await sender(chatId, formatError(error));
    }
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readNestedString(value: unknown, path: string[]): string | null {
  let cursor: unknown = value;
  for (const key of path) {
    const record = asRecord(cursor);
    if (!record) return null;
    cursor = record[key];
  }
  return typeof cursor === "string" && cursor.trim() ? cursor.trim() : null;
}

async function findOperationsAgent(db: Db, companyId: string, botUsername?: string | null) {
  const rows = await db
    .select({
      id: agents.id,
      name: agents.name,
      status: agents.status,
      adapterType: agents.adapterType,
      runtimeConfig: agents.runtimeConfig,
    })
    .from(agents)
    .where(eq(agents.companyId, companyId));

  const activeRows = rows.filter((row) => row.status !== "terminated" && row.status !== "pending_approval");
  const normalizedBot = botUsername?.toLowerCase() ?? null;
  return activeRows.find((row) => {
    const runtimeBot = readNestedString(row.runtimeConfig, ["telegram", "botUsername"])?.toLowerCase() ?? null;
    const domain = readNestedString(row.runtimeConfig, ["domain"]);
    const mode = readNestedString(row.runtimeConfig, ["operatingMode"]);
    const telegram = asRecord(asRecord(row.runtimeConfig)?.telegram);
    return (
      domain === "operations" ||
      mode === "chief_of_staff_liaison" ||
      mode === "independent_management_operator" ||
      telegram?.directConversation === true ||
      (normalizedBot !== null && runtimeBot === normalizedBot)
    );
  }) ?? null;
}

async function cmdOpsConversation(
  sender: (chatId: number, text: string) => Promise<void>,
  chatId: number,
  message: TelegramMessage,
  db: Db,
  companyId: string,
): Promise<void> {
  const text = message.text?.trim();
  if (!text) return;

  const agent = await findOperationsAgent(db, companyId, "inflo_research_bot");
  if (!agent) {
    await sender(chatId, formatError("Operations Manager is not configured for this company."));
    return;
  }

  const senderLabel = message.from?.username
    ? `@${message.from.username}`
    : message.from?.first_name ?? `telegram:${message.from?.id ?? "unknown"}`;

  const run = await heartbeatService(db).wakeup(agent.id, {
    source: "on_demand",
    triggerDetail: "telegram_ops_chat",
    reason: "telegram_ops_chat_message",
    payload: {
      telegramChatId: chatId,
      telegramMessageId: message.message_id,
    },
    idempotencyKey: `telegram:${companyId}:${chatId}:${message.message_id}`,
    requestedByActorType: "user",
    requestedByActorId: senderLabel,
    contextSnapshot: {
      taskKey: `telegram-ops:${chatId}`,
      forceFreshSession: false,
      telegramOperatorMessage: true,
      telegramChatId: chatId,
      telegramMessageId: message.message_id,
      telegramFromId: message.from?.id ?? null,
      telegramFromUsername: message.from?.username ?? null,
      currentMessage: text,
      instructions: [
        "Default to a concise Telegram operations answer: 3-6 short bullets or 1-2 short paragraphs.",
        "This is a free-form operations chat, not a mission or issue assignment.",
        "Do not create an issue for this message unless the operator explicitly asks you to create one.",
        "Use live Paperclip state when answering questions about prior work, artifacts, agents, missions, workflow runs, scheduler state, or issue status.",
        "If you take an action, name the exact issue, mission, run, workflow, or agent changed.",
      ],
    },
  });

  const agentLabel = agent.name || "Operations Manager";
  await sender(
    chatId,
    formatSuccess(
      run
        ? `${agentLabel}가 응답을 준비 중입니다.`
        : "현재 실행 큐 정책에 의해 응답 실행이 보류되었습니다.",
    ),
  );
}

/**
 * Register all Telegram command handlers for a company.
 * Called from the app startup after channel registry is initialized.
 */
export function registerTelegramCommands(db: Db, companyId: string): void {
  const handler = buildTelegramHandler(db, companyId);
  getChannelRegistry().registerTelegramHandler(companyId, handler);
}

// ---------------------------------------------------------------------------
// Command implementations
// ---------------------------------------------------------------------------

async function cmdStatus(
  sender: (chatId: number, text: string) => Promise<void>,
  chatId: number,
  companyId: string,
): Promise<void> {
  const lines: string[] = [];
  lines.push("*Papercompany Bot*");
  lines.push("Status: Online");
  lines.push("Company: " + companyId.slice(0, 8) + "...");
  lines.push("");
  lines.push("Use /help for available commands.");
  await sender(chatId, lines.join("\n"));
}

async function cmdMission(
  sender: (chatId: number, text: string) => Promise<void>,
  chatId: number,
  args: string[],
  db: Db,
  companyId: string,
): Promise<void> {
  if (args.length === 0) {
    await sender(chatId, formatError("Usage: /mission <id> or /mission create <title>"));
    return;
  }

  const subcommand = args[0].toLowerCase();

  if (subcommand === "create") {
    const title = args.slice(1).join(" ");
    if (!title) {
      await sender(chatId, formatError("Usage: /mission create <title>"));
      return;
    }
    await missionCreate(sender, chatId, title, db, companyId);
  } else {
    const missionId = subcommand;
    await missionShow(sender, chatId, missionId, db);
  }
}

async function missionCreate(
  sender: (chatId: number, text: string) => Promise<void>,
  chatId: number,
  title: string,
  db: Db,
  companyId: string,
): Promise<void> {
  // Find the first agent in the company to use as owner
  const [firstAgent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.companyId, companyId))
    .limit(1);

  if (!firstAgent) {
    await sender(chatId, formatError("No agents found in this company. Cannot create a mission."));
    return;
  }

  const missionsSvc = missionService(db);
  const mission = await missionsSvc.create({
    companyId,
    ownerAgentId: firstAgent.id,
    title,
    status: "planning",
  });

  await sender(chatId, formatMissionCreated({ missionId: mission.id, title: mission.title }));
}

async function missionShow(
  sender: (chatId: number, text: string) => Promise<void>,
  chatId: number,
  missionId: string,
  db: Db,
): Promise<void> {
  const missionsSvc = missionService(db);
  const missionsListSvc = missionService(db);

  // Try to find by ID first
  let mission: Awaited<ReturnType<typeof missionsSvc.getById>> | null = null;
  try {
    mission = await missionsSvc.getById(missionId);
  } catch {
    mission = null;
  }

  if (!mission) {
    // Try by identifier/title search
    const list = await missionsListSvc.list({ companyId: missionId, limit: 1 });
    if (list.length === 0) {
      await sender(chatId, formatError(`Mission not found: ${missionId}`));
      return;
    }
    try {
      mission = await missionsSvc.getById(list[0].id);
    } catch {
      mission = null;
    }
  }

  if (!mission) {
    await sender(chatId, formatError(`Mission not found: ${missionId}`));
    return;
  }

  // Get issue count for the mission (missionId FK on issues if available)
  let issueCount = 0;
  try {
    const issueRows = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.missionId, mission.id))
      .limit(100);
    issueCount = issueRows.length;
  } catch {
    // missionId column might not exist yet on issues table
  }

  const executorCount = mission.agents?.length ?? 0;

  const statusText = formatMissionStatus({
    missionId: mission.id,
    title: mission.title,
    status: mission.status ?? "unknown",
    ownerAgentId: mission.ownerAgentId,
    executorCount,
    issueCount,
    startedAt: mission.startedAt?.toISOString() ?? null,
    completedAt: mission.completedAt?.toISOString() ?? null,
  });

  await sender(chatId, statusText);
}

async function cmdApprove(
  sender: (chatId: number, text: string) => Promise<void>,
  chatId: number,
  args: string[],
  db: Db,
  companyId: string,
): Promise<void> {
  if (args.length < 1) {
    await sender(chatId, formatError("Usage: /approve <approvalId>"));
    return;
  }

  const approvalId = args[0];
  const approvalsSvc = approvalService(db);

  // Verify the approval exists and belongs to this company
  const approval = await approvalsSvc.getById(approvalId);
  if (!approval) {
    await sender(chatId, formatError(`Approval not found: ${approvalId}`));
    return;
  }

  if (approval.companyId !== companyId) {
    await sender(chatId, formatError("Approval does not belong to this company."));
    return;
  }

  if (approval.status !== "pending" && approval.status !== "revision_requested") {
    await sender(chatId, formatError(`Approval is already ${approval.status}. Only pending or revision_requested can be approved.`));
    return;
  }

  // Use the requester's user ID if available, otherwise use system ID
  const decidedBy = approval.requestedByUserId ?? TELEGRAM_SYSTEM_USER_ID;
  const result = await approvalsSvc.approve(approvalId, decidedBy, null);

  if (!result.applied) {
    await sender(chatId, formatError(`Approval was already ${result.approval.status}.`));
    return;
  }

  await sender(chatId, formatSuccess(`Approval ${approvalId} approved.`));
}

async function cmdAssign(
  sender: (chatId: number, text: string) => Promise<void>,
  chatId: number,
  args: string[],
  db: Db,
  companyId: string,
): Promise<void> {
  if (args.length < 2) {
    await sender(chatId, formatError("Usage: /assign <issueIdOrIdentifier> <agentName>"));
    return;
  }

  const [issueRef, agentName] = args;

  // Find the agent by name
  const [agentRow] = await db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(eq(agents.name, agentName))
    .limit(1);

  if (!agentRow) {
    await sender(chatId, formatError(`Agent not found: ${agentName}`));
    return;
  }

  // Find the issue by ID or identifier
  const issuesSvc = issueService(db);
  let issue;
  try {
    issue = await issuesSvc.getById(issueRef);
  } catch {
    issue = null;
  }

  if (!issue) {
    // Try by identifier
    try {
      issue = await issuesSvc.getByIdentifier(issueRef);
    } catch {
      issue = null;
    }
  }

  if (!issue) {
    await sender(chatId, formatError(`Issue not found: ${issueRef}`));
    return;
  }

  if (issue.companyId !== companyId) {
    await sender(chatId, formatError("Issue does not belong to this company."));
    return;
  }

  // Assign the agent
  await issuesSvc.update(issue.id, { assigneeAgentId: agentRow.id });

  await sender(chatId, formatSuccess(`Assigned to ${agentRow.name}.`));
}
