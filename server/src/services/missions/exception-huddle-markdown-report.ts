import type { ExceptionHuddleMetadata } from "@paperclipai/shared/validators/exception-huddle";

export type ExceptionHuddleReportItem = {
  threadId: string;
  title: string;
  updatedAt: string;
  huddle: ExceptionHuddleMetadata;
};

const DEFAULT_MAX_ITEMS = 50;

function normalizeMaxItems(value: number | undefined): number {
  const requested = value ?? DEFAULT_MAX_ITEMS;
  if (requested === Infinity) return Number.MAX_SAFE_INTEGER;
  if (!Number.isFinite(requested)) return 0;
  return Math.max(0, Math.floor(requested));
}

function escapeTableCell(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/\n/g, "<br>")
    .replace(/\|/g, "\\|");
}

function formatThread(item: ExceptionHuddleReportItem): string {
  return `${item.title} (${item.threadId})`;
}

function formatRound(item: ExceptionHuddleReportItem): string {
  return `${item.huddle.currentRound}/${item.huddle.maxRounds}`;
}

function formatDecision(item: ExceptionHuddleReportItem): string {
  return item.huddle.decision?.kind ?? "-";
}

function tableRow(item: ExceptionHuddleReportItem): string {
  return [
    formatThread(item),
    item.huddle.status,
    formatRound(item),
    formatDecision(item),
    item.updatedAt,
  ].map(escapeTableCell).join(" | ");
}

export function renderExceptionHuddleGovernanceReport(input: {
  missionTitle?: string;
  items: readonly ExceptionHuddleReportItem[];
  maxItems?: number;
}): string {
  const counts = { open: 0, timed_out: 0, decided: 0, cancelled: 0 };
  for (const item of input.items) counts[item.huddle.status] += 1;

  const maxItems = normalizeMaxItems(input.maxItems);
  const visibleItems = input.items.slice(0, maxItems);
  const overflowCount = input.items.length - visibleItems.length;
  const lines = [
    "# Exception Huddle Governance Summary",
    "",
    ...(input.missionTitle !== undefined ? [`Mission: ${input.missionTitle}`, ""] : []),
    `Total: ${input.items.length} | Open: ${counts.open} | Timed Out: ${counts.timed_out} | Decided: ${counts.decided} | Cancelled: ${counts.cancelled}`,
    "",
  ];

  if (input.items.length === 0) {
    lines.push("No exception huddles recorded.");
    return lines.join("\n");
  }

  lines.push(
    "| Thread | Status | Round | Decision | Updated |",
    "| --- | --- | --- | --- | --- |",
    ...visibleItems.map((item) => `| ${tableRow(item)} |`),
  );
  if (overflowCount > 0) lines.push("", `... and ${overflowCount} more`);
  return lines.join("\n");
}
