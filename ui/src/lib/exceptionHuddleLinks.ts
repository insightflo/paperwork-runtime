export type ExceptionHuddleLinkTarget = {
  companyPrefix?: string | null;
  channelId: string;
  threadId: string;
  focusDecision?: boolean;
};

const HUDDLE_DECISION_FOCUS = "huddle-decision";

function replaceUnpairedSurrogates(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        result += value[index]! + value[index + 1]!;
        index += 1;
      } else {
        result += "\ufffd";
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      result += "\ufffd";
    } else {
      result += value[index]!;
    }
  }
  return result;
}

function encodeValue(value: string): string {
  return encodeURIComponent(replaceUnpairedSurrogates(value));
}

function trimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function prefixSegment(companyPrefix: string | null | undefined): string {
  const trimmed = trimmedString(companyPrefix).replace(/^\/+|\/+$/g, "").trim();
  return trimmed ? `/${encodeValue(trimmed)}` : "";
}

export function buildExceptionHuddlePath(target: ExceptionHuddleLinkTarget): string {
  const params = [
    `channelId=${encodeValue(trimmedString(target.channelId))}`,
    `threadId=${encodeValue(trimmedString(target.threadId))}`,
  ];
  if (target.focusDecision) params.push(`focus=${HUDDLE_DECISION_FOCUS}`);
  return `${prefixSegment(target.companyPrefix)}/channels?${params.join("&")}`;
}

export function parseExceptionHuddleSearch(search: string): {
  channelId: string | null;
  threadId: string | null;
  focusDecision: boolean;
} {
  const params = new URLSearchParams(trimmedString(search));
  const channelId = trimmedString(params.get("channelId"));
  const threadId = trimmedString(params.get("threadId"));
  return {
    channelId: channelId || null,
    threadId: threadId || null,
    focusDecision: trimmedString(params.get("focus")) === HUDDLE_DECISION_FOCUS,
  };
}
