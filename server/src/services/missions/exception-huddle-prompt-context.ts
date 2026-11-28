import {
  exceptionHuddleMetadataSchema,
  type ExceptionHuddleDecision,
  type ExceptionHuddleMetadata,
} from "@paperclipai/shared/validators/exception-huddle";

export interface ExceptionHuddlePromptContextOptions {
  recipientRole: "owner_chair" | "producer" | "validator";
  maxChars?: number;
}

export interface ExceptionHuddlePromptContextResult {
  markdown: string;
  truncated: boolean;
  status: ExceptionHuddleMetadata["status"];
  decisionKind: string | null;
}

const DEFAULT_MAX_CHARS = 2000;
const MIN_MAX_CHARS = 200;
const TRUNCATION_MARKER = "... [truncated]";

function normalizeMaxChars(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_CHARS;
  return Math.max(MIN_MAX_CHARS, Math.floor(value));
}

function normalizeRecipientRole(value: string): ExceptionHuddlePromptContextOptions["recipientRole"] {
  if (value === "owner_chair" || value === "producer" || value === "validator") return value;
  throw new TypeError(`Invalid exception huddle recipient role: ${value}`);
}

function code(value: string): string {
  return `\`${value}\``;
}

function literal(value: string): string {
  return JSON.stringify(value);
}

function identifierLines(metadata: ExceptionHuddleMetadata): string[] {
  const lines = [
    `- Status: ${code(metadata.status)}`,
    `- Round: ${code(`${metadata.currentRound}/${metadata.maxRounds}`)}`,
    `- Timeout at: ${code(metadata.timeoutAt)}`,
    `- Mission ID: ${code(metadata.missionId)}`,
    `- Workflow run ID: ${code(metadata.workflowRunId)}`,
    `- Source step ID: ${code(metadata.sourceStepId)}`,
  ];
  if (metadata.sourceIssueId !== null) {
    lines.push(`- Source issue ID: ${code(metadata.sourceIssueId)}`);
  }
  lines.push(
    `- Participants: owner_chair=${code(metadata.participants.ownerAgentId)}, producer=${code(metadata.participants.producerAgentId)}, validator=${code(metadata.participants.validatorAgentId)}`,
  );
  if (metadata.workProductLinks.length === 0) {
    lines.push("- Work product links: none");
  } else {
    lines.push("- Work product links:");
    lines.push(...metadata.workProductLinks.map((link) => `  - ${code(link)}`));
  }
  return lines;
}

function openDirective(recipientRole: ExceptionHuddlePromptContextOptions["recipientRole"], maxRounds: number): string[] {
  if (recipientRole === "owner_chair") {
    return [
      "You hold sole decision authority for this exception huddle.",
      "Use `exception_huddle_decide` with a structured decision; thread prose is evidence only and is never decision authority.",
    ];
  }
  return [
    `Provide concise structured evidence within the ${maxRounds}-round / 5-minute budget.`,
    "Do not decide or execute resolution yourself; the owner chair alone decides through `exception_huddle_decide`.",
  ];
}

function timedOutDirective(recipientRole: ExceptionHuddlePromptContextOptions["recipientRole"]): string[] {
  if (recipientRole === "owner_chair") {
    return [
      "The huddle timed out and requires an immediate Chair decision.",
      "Use `exception_huddle_decide` now; do not reopen or extend the discussion.",
    ];
  }
  return [
    "The huddle is frozen pending the Chair decision.",
    "Do not add further turns or take resolution action unless the structured decision directs it.",
  ];
}

function decisionAction(decision: ExceptionHuddleDecision): string {
  if (decision.kind === "retry_with_guidance") {
    return "Retry the affected work with the structured guidance as the implementation focus.";
  }
  if (decision.kind === "accept_with_waiver") {
    return "Accept only the scope covered by the waiver condition; all requirements outside that scope remain unchanged.";
  }
  if (decision.kind === "replan_remaining") {
    return "Replan the remaining work from the structured summary before any further execution.";
  }
  return "Stop the current execution path and hand off through the escalation route; do not retry locally.";
}

function decisionDetailLine(decision: ExceptionHuddleDecision): string {
  const fields = {
    retry_with_guidance: ["Guidance", decision.guidance],
    accept_with_waiver: ["Waiver condition", decision.waiverCondition],
    replan_remaining: ["Replan summary", decision.replanSummary],
    escalate: ["Escalation reason", decision.escalationReason],
  } as const;
  const [label, value] = fields[decision.kind];
  if (value === undefined) throw new Error(`Missing structured huddle decision field for ${decision.kind}`);
  return `- ${label}: ${literal(value)}`;
}

function decidedDirective(metadata: ExceptionHuddleMetadata): string[] {
  const decision = metadata.decision;
  if (!decision) {
    return [
      "The huddle is marked decided, but no structured decision is present.",
      "Fail closed: do not act until structured decision metadata exists.",
    ];
  }
  const lines = [
    "The huddle is decided. Execute only the structured decision below; thread prose is not execution authority.",
    "",
    "### Structured Decision",
    `- Kind: ${code(decision.kind)}`,
    `- Rationale: ${literal(decision.rationale)}`,
    decisionDetailLine(decision),
    `- Forced by chair: ${code(String(decision.forcedByChair))}`,
  ];
  if (metadata.decidedByAgentId !== null) {
    lines.push(`- Decided by agent ID: ${code(metadata.decidedByAgentId)}`);
  }
  if (metadata.decidedAt !== null) {
    lines.push(`- Decided at: ${code(metadata.decidedAt)}`);
  }
  lines.push(`- Required action: ${decisionAction(decision)}`);
  return lines;
}

function directiveLines(
  metadata: ExceptionHuddleMetadata,
  recipientRole: ExceptionHuddlePromptContextOptions["recipientRole"],
): string[] {
  if (metadata.status === "open") return openDirective(recipientRole, metadata.maxRounds);
  if (metadata.status === "timed_out") return timedOutDirective(recipientRole);
  if (metadata.status === "decided") return decidedDirective(metadata);
  return [
    "This exception huddle was cancelled.",
    "Do not act on this huddle; wait for the active control-plane path.",
  ];
}

function truncateMarkdown(markdown: string, maxChars: number): { markdown: string; truncated: boolean } {
  if (markdown.length <= maxChars) return { markdown, truncated: false };
  const budget = maxChars - TRUNCATION_MARKER.length - 1;
  let cut = markdown.slice(0, budget);
  const lastNewline = cut.lastIndexOf("\n");
  if (lastNewline > 0) {
    const lineCut = cut.slice(0, lastNewline);
    if (lineCut.length >= Math.floor(budget * 0.5)) {
      cut = lineCut;
    } else {
      const lastWhitespace = Math.max(cut.lastIndexOf(" "), cut.lastIndexOf("\t"));
      if (lastWhitespace > 0) cut = cut.slice(0, lastWhitespace);
    }
  }
  cut = cut.trimEnd();
  return { markdown: `${cut}\n${TRUNCATION_MARKER}`, truncated: true };
}

export function buildExceptionHuddlePromptContext(
  huddle: ExceptionHuddleMetadata,
  options: ExceptionHuddlePromptContextOptions,
): ExceptionHuddlePromptContextResult {
  const metadata = exceptionHuddleMetadataSchema.parse(huddle);
  const recipientRole = normalizeRecipientRole(options.recipientRole);
  const maxChars = normalizeMaxChars(options.maxChars);
  const compiled = [
    "## Exception Huddle Context",
    "",
    ...identifierLines(metadata),
    `- Recipient role: ${code(recipientRole)}`,
    "",
    "### Directive",
    ...directiveLines(metadata, recipientRole),
  ].join("\n");
  const bounded = truncateMarkdown(compiled, maxChars);
  return {
    markdown: bounded.markdown,
    truncated: bounded.truncated,
    status: metadata.status,
    decisionKind: metadata.decision?.kind ?? null,
  };
}
