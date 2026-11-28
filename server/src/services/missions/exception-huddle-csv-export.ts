import type { ExceptionHuddleMetadata } from "@paperclipai/shared/validators/exception-huddle";

export interface ExceptionHuddleCsvRow {
  threadId: string;
  channelId: string;
  title: string;
  updatedAt: string;
  huddle: ExceptionHuddleMetadata;
}

const CSV_HEADER = "threadId,channelId,missionId,sourceStepId,status,round,maxRounds,decisionKind,title,updatedAt";
const FORMULA_INJECTION_START = /^[=+\-@\t\r]/;
const CSV_ESCAPABLE = /[",\r\n]/;

export function escapeCsvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (FORMULA_INJECTION_START.test(text)) text = `'${text}`;
  if (!CSV_ESCAPABLE.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

export function exportExceptionHuddlesToCsv(rows: readonly ExceptionHuddleCsvRow[]): string {
  const lines = rows.map((row) => [
    row.threadId,
    row.channelId,
    row.huddle.missionId,
    row.huddle.sourceStepId,
    row.huddle.status,
    row.huddle.currentRound,
    row.huddle.maxRounds,
    row.huddle.decision?.kind ?? null,
    row.title,
    row.updatedAt,
  ].map(escapeCsvCell).join(","));
  return [CSV_HEADER, ...lines].map((line) => `${line}\r\n`).join("");
}
