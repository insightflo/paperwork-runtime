export interface QueueExportRow {
  agentId: string;
  agentName: string;
  maxConcurrentRuns: number;
  runningCount: number;
  queuedCount: number;
  utilizationRatio: number;
  saturated: boolean;
  oldestQueuedWaitMs: number;
  starvationWarning: boolean;
  distinctQueuedIssues: number;
}

const CSV_HEADER = "agent_id,agent_name,max_slots,running,queued,utilization_ratio,saturated,oldest_wait_ms,starvation_warning,distinct_queued_issues";
const FORMULA_INJECTION_START = /^[=+\-@\t\r]/;
const CSV_ESCAPABLE = /[",\r\n]/;

function escapeCsvValue(value: string | number | boolean): string {
  const text = String(value);
  if (!CSV_ESCAPABLE.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function escapeCsvText(value: string): string {
  return escapeCsvValue(FORMULA_INJECTION_START.test(value) ? `'${value}` : value);
}

export function exportFleetQueueTelemetryCsv(rows: readonly QueueExportRow[]): string {
  const lines = rows.map((row) => [
    escapeCsvText(row.agentId),
    escapeCsvText(row.agentName),
    escapeCsvValue(row.maxConcurrentRuns),
    escapeCsvValue(row.runningCount),
    escapeCsvValue(row.queuedCount),
    escapeCsvValue(row.utilizationRatio),
    escapeCsvValue(row.saturated),
    escapeCsvValue(row.oldestQueuedWaitMs),
    escapeCsvValue(row.starvationWarning),
    escapeCsvValue(row.distinctQueuedIssues),
  ].join(","));
  return [CSV_HEADER, ...lines].map((line) => `${line}\r\n`).join("");
}

function escapeMarkdownCell(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/\n/g, "<br>")
    .replace(/\|/g, "\\|");
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return "0%";
  return `${Number((value * 100).toFixed(1))}%`;
}

function formatNumber(value: number): string {
  return Number.isFinite(value) ? String(value) : "0";
}

function sum(rows: readonly QueueExportRow[], select: (row: QueueExportRow) => number): number {
  return rows.reduce((total, row) => total + select(row), 0);
}

function markdownRow(row: QueueExportRow): string {
  const agent = `${row.starvationWarning ? "⚠️ " : ""}${row.agentName} (${row.agentId})`;
  return `| ${[
    agent,
    formatNumber(row.maxConcurrentRuns),
    formatNumber(row.runningCount),
    formatNumber(row.queuedCount),
    formatPercent(row.utilizationRatio),
    row.saturated ? "yes" : "no",
    formatNumber(row.oldestQueuedWaitMs),
    row.starvationWarning ? "⚠️ yes" : "no",
    formatNumber(row.distinctQueuedIssues),
  ].map(escapeMarkdownCell).join(" | ")} |`;
}

export function formatFleetQueueTelemetryMarkdown(
  rows: readonly QueueExportRow[],
  opts?: { generatedAtIso?: string },
): string {
  const totalSlots = sum(rows, (row) => row.maxConcurrentRuns);
  const totalRunning = sum(rows, (row) => row.runningCount);
  const totalQueued = sum(rows, (row) => row.queuedCount);
  const totalDistinctIssues = sum(rows, (row) => row.distinctQueuedIssues);
  const saturatedCount = rows.filter((row) => row.saturated).length;
  const starvingCount = rows.filter((row) => row.starvationWarning).length;
  const oldestWaitMs = rows.reduce((oldest, row) => Math.max(oldest, row.oldestQueuedWaitMs), 0);
  const utilization = totalSlots > 0 ? totalRunning / totalSlots : 0;
  const lines = [
    "# Fleet Queue Ops Snapshot / 큐 운영 스냅샷",
    "",
    ...(opts?.generatedAtIso ? [`Generated / 생성 시각: ${opts.generatedAtIso}`, ""] : []),
    `Totals / 합계: ${rows.length} agents | ${formatNumber(totalSlots)} slots | ${formatNumber(totalRunning)} running | ${formatNumber(totalQueued)} queued | ${formatNumber(totalDistinctIssues)} distinct queued issues`,
    `Utilization / 사용률: ${formatPercent(utilization)} | Saturated / 포화: ${saturatedCount} | Starvation warnings / 기아 경고: ${starvingCount}${starvingCount > 0 ? " ⚠️" : ""} | Oldest wait / 최장 대기: ${formatNumber(oldestWaitMs)} ms`,
    "",
  ];

  if (rows.length === 0) {
    lines.push("No queue telemetry rows. / 큐 원격 측정 행이 없습니다.");
    return lines.join("\n");
  }

  lines.push(
    "| Agent / 에이전트 | Slots | Running | Queued | Utilization | Saturated | Oldest wait (ms) | Starving | Distinct issues |",
    "| --- | ---: | ---: | ---: | ---: | :---: | ---: | :---: | ---: |",
    ...rows.map(markdownRow),
  );
  return lines.join("\n");
}
