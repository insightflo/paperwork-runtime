import { describe, expect, it } from "vitest";
import {
  exportFleetQueueTelemetryCsv,
  formatFleetQueueTelemetryMarkdown,
  type QueueExportRow,
} from "../services/heartbeat-queue-metrics-export.js";

const HEADER = "agent_id,agent_name,max_slots,running,queued,utilization_ratio,saturated,oldest_wait_ms,starvation_warning,distinct_queued_issues";

function row(overrides: Partial<QueueExportRow> = {}): QueueExportRow {
  return {
    agentId: "agent-1",
    agentName: "Alpha",
    maxConcurrentRuns: 2,
    runningCount: 1,
    queuedCount: 3,
    utilizationRatio: 0.5,
    saturated: false,
    oldestQueuedWaitMs: 1200,
    starvationWarning: false,
    distinctQueuedIssues: 2,
    ...overrides,
  };
}

describe("exportFleetQueueTelemetryCsv", () => {
  it("emits only the CRLF-terminated header for empty rows", () => {
    expect(exportFleetQueueTelemetryCsv([])).toBe(`${HEADER}\r\n`);
  });

  it("exports the header and rows in the specified column order", () => {
    const csv = exportFleetQueueTelemetryCsv([
      row(),
      row({
        agentId: "agent-2",
        agentName: "Beta",
        maxConcurrentRuns: 4,
        runningCount: 4,
        queuedCount: 6,
        utilizationRatio: 1,
        saturated: true,
        oldestQueuedWaitMs: 60000,
        starvationWarning: true,
        distinctQueuedIssues: 5,
      }),
    ]);

    expect(csv).toBe(
      `${HEADER}\r\n` +
      "agent-1,Alpha,2,1,3,0.5,false,1200,false,2\r\n" +
      "agent-2,Beta,4,4,6,1,true,60000,true,5\r\n",
    );
  });

  it("preserves commas, quotes, and newlines with RFC 4180 escaping", () => {
    const csv = exportFleetQueueTelemetryCsv([
      row({ agentId: 'agent,"one"', agentName: 'Alpha\n"West"' }),
    ]);

    expect(csv).toBe(
      `${HEADER}\r\n` +
      '"agent,""one""","Alpha\n""West""",2,1,3,0.5,false,1200,false,2\r\n',
    );
  });

  it("neutralizes spreadsheet formula-leading agent identifiers and names", () => {
    const csv = exportFleetQueueTelemetryCsv([
      row({ agentId: "=CMD()", agentName: "safe" }),
      row({ agentId: "safe-2", agentName: "+1" }),
      row({ agentId: "@SUM", agentName: "-2" }),
      row({ agentId: "\t=cmd", agentName: "\r@cmd" }),
    ]);
    const lines = csv.split("\r\n");

    expect(lines[1]).toBe("'=CMD(),safe,2,1,3,0.5,false,1200,false,2");
    expect(lines[2]).toBe("safe-2,'+1,2,1,3,0.5,false,1200,false,2");
    expect(lines[3]).toBe("'@SUM,'-2,2,1,3,0.5,false,1200,false,2");
    expect(lines[4]).toBe("'\t=cmd,\"'\r@cmd\",2,1,3,0.5,false,1200,false,2");
  });

  it("does not mutate frozen input rows", () => {
    const input = Object.freeze([Object.freeze(row())]);
    const before = JSON.stringify(input);

    expect(exportFleetQueueTelemetryCsv(input)).toContain("agent-1");
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe("formatFleetQueueTelemetryMarkdown", () => {
  it("renders a deterministic bilingual summary, totals, and starving-agent highlight", () => {
    const markdown = formatFleetQueueTelemetryMarkdown([
      row(),
      row({
        agentId: "agent-2",
        agentName: "Beta",
        runningCount: 2,
        queuedCount: 2,
        utilizationRatio: 1,
        saturated: true,
        oldestQueuedWaitMs: 60000,
        starvationWarning: true,
      }),
    ], { generatedAtIso: "2026-11-28T12:00:00.000Z" });

    expect(markdown).toBe([
      "# Fleet Queue Ops Snapshot / 큐 운영 스냅샷",
      "",
      "Generated / 생성 시각: 2026-11-28T12:00:00.000Z",
      "",
      "Totals / 합계: 2 agents | 4 slots | 3 running | 5 queued | 4 distinct queued issues",
      "Utilization / 사용률: 75% | Saturated / 포화: 1 | Starvation warnings / 기아 경고: 1 ⚠️ | Oldest wait / 최장 대기: 60000 ms",
      "",
      "| Agent / 에이전트 | Slots | Running | Queued | Utilization | Saturated | Oldest wait (ms) | Starving | Distinct issues |",
      "| --- | ---: | ---: | ---: | ---: | :---: | ---: | :---: | ---: |",
      "| Alpha (agent-1) | 2 | 1 | 3 | 50% | no | 1200 | no | 2 |",
      "| ⚠️ Beta (agent-2) | 2 | 2 | 2 | 100% | yes | 60000 | ⚠️ yes | 2 |",
    ].join("\n"));
  });

  it("renders zero totals and an empty notice without a table", () => {
    expect(formatFleetQueueTelemetryMarkdown([])).toBe([
      "# Fleet Queue Ops Snapshot / 큐 운영 스냅샷",
      "",
      "Totals / 합계: 0 agents | 0 slots | 0 running | 0 queued | 0 distinct queued issues",
      "Utilization / 사용률: 0% | Saturated / 포화: 0 | Starvation warnings / 기아 경고: 0 | Oldest wait / 최장 대기: 0 ms",
      "",
      "No queue telemetry rows. / 큐 원격 측정 행이 없습니다.",
    ].join("\n"));
  });

  it("escapes pipes and replaces newlines inside Markdown table cells", () => {
    const markdown = formatFleetQueueTelemetryMarkdown([
      row({ agentId: "id|1", agentName: "Bad | name\nnext" }),
    ]);

    expect(markdown).toContain("Bad \\| name<br>next (id\\|1)");
    expect(markdown).not.toContain("Bad | name");
  });

  it("does not mutate frozen input rows", () => {
    const input = Object.freeze([Object.freeze(row({ starvationWarning: true }))]);
    const before = JSON.stringify(input);

    expect(formatFleetQueueTelemetryMarkdown(input)).toContain("⚠️ Alpha");
    expect(JSON.stringify(input)).toBe(before);
  });
});
