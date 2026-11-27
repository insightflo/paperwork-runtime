import type { EndpointBotPairingService, LocalTaskKind } from "./endpoint-bot-pairing.js";

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
export function dispatchChannelMessageToEndpoint(input: {
  companyId: string;
  messageText: string;
  store: Pick<EndpointBotPairingService, "listEndpoints" | "enqueueLocalTask">;
  nowMs?: number;
}): EndpointChannelDispatchResult {
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
  try {
    const task = input.store.enqueueLocalTask({
      companyId: input.companyId, deviceId: endpoint.deviceId, kind: parsed.kind, targetPath: parsed.targetPath,
      ...(parsed.kind === "shell_exec" ? { command: parsed.command } : {}), nowMs,
    });
    return { matched: true, ok: true, deviceId: endpoint.deviceId, taskId: task.taskId,
      replyText: `Queued task ${task.taskId} for @${endpoint.botName}.` };
  } catch {
    return { matched: true, ok: false, reason: "policy_denied",
      replyText: `@${endpoint.botName} could not accept this task. Check the allowed path and folder permissions.` };
  }
}
