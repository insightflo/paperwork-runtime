import { describe, expect, it } from "vitest";

import { formatConcurrencyOpsDigestMarkdown } from "../services/heartbeat-ops-digest-md.js";

const healthyInput = {
  capturedAtIso: "2026-01-15T09:30:00.000Z",
  utilizationPercent: 62.5,
  totalSlots: 8,
  totalRunning: 5,
  totalQueued: 0,
  jainFairnessIndex: 0.925,
  deadlockCount: 0,
  coolingDownProviders: [],
} as const;

describe("formatConcurrencyOpsDigestMarkdown", () => {
  it("경고와 권장 조치가 없는 정상 브리핑을 렌더링한다", () => {
    const markdown = formatConcurrencyOpsDigestMarkdown(healthyInput);

    expect(markdown).toBe([
      "## 동시 실행 운영 브리핑",
      "",
      "- 수집 시각: 2026-01-15T09:30:00.000Z",
      "- 동시 실행 슬롯: 5/8 사용 중 (62.5%)",
      "- 대기 큐: 0건",
      "- 공정성: 92.5%",
    ].join("\n"));
    expect(markdown).not.toContain("데드록");
    expect(markdown).not.toContain("쿨다운");
    expect(markdown).not.toContain("권장 조치");
  });

  it("경고, 권장 조치 절단, 줄바꿈 정규화를 함께 렌더링한다", () => {
    const markdown = formatConcurrencyOpsDigestMarkdown({
      capturedAtIso: "2026-01-15T10:00:00.000Z",
      utilizationPercent: 97.25,
      totalSlots: 10,
      totalRunning: 10,
      totalQueued: 14,
      jainFairnessIndex: 0.4312,
      deadlockCount: 2,
      coolingDownProviders: ["openai", "anthropic"],
      recommendations: [
        {
          agentName: "alpha\noperator",
          actionLabel: "실행\r\n재시도",
          reason: "슬롯 고갈로\n대기 중",
        },
        { agentName: "bravo", actionLabel: "큐 정리", reason: "오래된 대기" },
        { agentName: "charlie", actionLabel: "공정성 조정", reason: "점유 편중" },
        { agentName: "delta", actionLabel: "쿨다운 대기", reason: "공급자 제한" },
        { agentName: "echo", actionLabel: "데드록 해제", reason: "상호 대기" },
        { agentName: "foxtrot", actionLabel: "숨김 후보", reason: "6번째" },
        { agentName: "golf", actionLabel: "숨김 후보", reason: "7번째" },
      ],
    });

    expect(markdown).toContain("- 데드록 경고: 2건 감지");
    expect(markdown).toContain("- 프로바이더 쿨다운 경고: openai, anthropic");
    expect(markdown).toContain("- 동시 실행 슬롯: 10/10 사용 중 (97.3%)");
    expect(markdown).toContain("- 공정성: 43.1%");
    expect(markdown).toContain("- **alpha operator** — 실행 재시도: 슬롯 고갈로 대기 중");
    expect(markdown).toContain("- **echo** — 데드록 해제: 상호 대기");
    expect(markdown).not.toContain("foxtrot");
    expect(markdown).not.toContain("golf");
    expect(markdown).toContain("- +2건 더 있음");
    expect(markdown.match(/^- \*\*/gm)).toHaveLength(5);
    expect(markdown).not.toMatch(/alpha\noperator|실행\r\n재시도|슬롯 고갈로\n대기 중/);
  });
});
