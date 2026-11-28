import type { Db } from "@paperclipai/db";
import { ensurePersonalEndpointTables, listEndpointsDb, enqueueLocalTaskDb } from "./endpoint-bot-db-store.js";
import type { EndpointBotPairingService, LocalTask, LocalTaskKind } from "./endpoint-bot-pairing.js";

type EndpointStore = Pick<EndpointBotPairingService, "listEndpoints" | "enqueueLocalTask">;
type AsyncTaskStore = Omit<EndpointStore, "enqueueLocalTask"> & {
  enqueueLocalTask(input: Parameters<EndpointStore["enqueueLocalTask"]>[0]): Promise<LocalTask>;
};
type DispatchInput<Store> = { companyId: string; messageText: string; store: Store; nowMs?: number };
const endpointTablesReady = new WeakMap<Db, Promise<void>>();

type ReadKind = Extract<LocalTaskKind, "list_dir" | "read_file">;
export type EndpointMentionCommand = { botName: string; targetPath: string } & (
  | { kind: ReadKind }
  | { kind: Extract<LocalTaskKind, "shell_exec">; command: string }
);
type DispatchFailure = "endpoint_not_found" | "endpoint_offline" | "policy_denied";
export type EndpointChannelDispatchResult =
  | { matched: false }
  | { matched: true; ok: false; reason: DispatchFailure; replyText: string }
  | { matched: true; ok: true; deviceId: string; taskId: string; replyText: string };

/** Only a complete, single-line command addressed at the start of a message is actionable. */
export function parseEndpointMentionCommand(messageText: string): EndpointMentionCommand | null {
  const match = /^@([a-zA-Z0-9._-]+)[ \t]+(list|read|run)[ \t]+([^\r\n]+)$/i.exec(messageText.trim());
  if (!match) return null;
  const [, botName, verb, body] = match;
  const target = body!.trim();
  if (!target) return null;
  if (verb!.toLowerCase() !== "run") {
    return { botName: botName!, kind: verb!.toLowerCase() === "list" ? "list_dir" : "read_file", targetPath: target };
  }
  const run = /^(.+?)[ \t]+--[ \t]+(.+)$/.exec(target);
  if (!run) return null;
  const targetPath = run[1]!.trim(), command = run[2]!.trim();
  if (!targetPath || !command) return null;
  return { botName: botName!, kind: "shell_exec", targetPath, command };
}

/** Callers must authorize the channel sender before invoking this pure routing bridge. */
export function dispatchChannelMessageToEndpoint(input: DispatchInput<EndpointStore>): EndpointChannelDispatchResult;
export function dispatchChannelMessageToEndpoint(input: DispatchInput<AsyncTaskStore>):
  EndpointChannelDispatchResult | Promise<EndpointChannelDispatchResult>;
export function dispatchChannelMessageToEndpoint(input: DispatchInput<EndpointStore | AsyncTaskStore>):
  EndpointChannelDispatchResult | Promise<EndpointChannelDispatchResult> {
  const parsed = parseEndpointMentionCommand(input.messageText);
  if (!parsed) return { matched: false };
  const nowMs = input.nowMs ?? Date.now();
  const endpoint = input.store.listEndpoints(input.companyId, nowMs)
    .find((candidate) => candidate.botName.toLowerCase() === parsed.botName.toLowerCase());
  if (!endpoint) {
    return { matched: true, ok: false, reason: "endpoint_not_found",
      replyText: `No paired endpoint named @${parsed.botName} was found in this company.` };
  }
  if (!endpoint.online) {
    return { matched: true, ok: false, reason: "endpoint_offline",
      replyText: `@${endpoint.botName} is offline. Reconnect the device and try again.` };
  }
  const queued = (task: LocalTask): EndpointChannelDispatchResult => ({
    matched: true, ok: true, deviceId: endpoint.deviceId, taskId: task.taskId,
    replyText: `Queued task ${task.taskId} for @${endpoint.botName}.`,
  });
  const denied = (): EndpointChannelDispatchResult => ({
    matched: true, ok: false, reason: "policy_denied",
    replyText: `@${endpoint.botName} could not accept this task. Check the allowed path and folder permissions.`,
  });
  try {
    const task = input.store.enqueueLocalTask({
      companyId: input.companyId, deviceId: endpoint.deviceId, kind: parsed.kind, targetPath: parsed.targetPath,
      ...(parsed.kind === "shell_exec" ? { command: parsed.command } : {}), nowMs,
    });
    return task instanceof Promise ? task.then(queued, denied) : queued(task);
  } catch {
    return denied();
  }
}

/** Live dispatch uses durable endpoints/tasks while sharing the synchronous routing guards and replies. */
export async function dispatchChannelMessageToEndpointDb(
  db: Db, input: Omit<DispatchInput<EndpointStore>, "store">,
): Promise<EndpointChannelDispatchResult> {
  if (!parseEndpointMentionCommand(input.messageText)) return { matched: false };
  let ready = endpointTablesReady.get(db);
  if (!ready) {
    ready = ensurePersonalEndpointTables(db);
    endpointTablesReady.set(db, ready);
  }
  await ready;
  const nowMs = input.nowMs ?? Date.now();
  const endpoints = await listEndpointsDb(db, input.companyId, nowMs);
  return dispatchChannelMessageToEndpoint({
    ...input, nowMs,
    store: { listEndpoints: () => endpoints, enqueueLocalTask: (task) => enqueueLocalTaskDb(db, task) },
  });
}
