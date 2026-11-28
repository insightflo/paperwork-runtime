const MAX_RECOMMENDATIONS = 5;

export interface OpsDigestInput {
  capturedAtIso: string;
  utilizationPercent: number;
  totalSlots: number;
  totalRunning: number;
  totalQueued: number;
  jainFairnessIndex: number;
  deadlockCount: number;
  coolingDownProviders: readonly string[];
  recommendations?: ReadonlyArray<{
    agentName: string;
    actionLabel: string;
    reason: string;
  }>;
}

function sanitizeInline(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function formatPercent(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
}

export function formatConcurrencyOpsDigestMarkdown(input: OpsDigestInput): string {
  const lines = [
    "## 동시 실행 운영 브리핑",
    "",
    `- 수집 시각: ${sanitizeInline(input.capturedAtIso)}`,
    `- 동시 실행 슬롯: ${input.totalRunning}/${input.totalSlots} 사용 중 (${formatPercent(input.utilizationPercent)})`,
    `- 대기 큐: ${input.totalQueued}건`,
    `- 공정성: ${formatPercent(input.jainFairnessIndex * 100)}`,
  ];

  if (input.deadlockCount > 0) {
    lines.push(`- 데드록 경고: ${input.deadlockCount}건 감지`);
  }

  if (input.coolingDownProviders.length > 0) {
    const providers = input.coolingDownProviders.map(sanitizeInline).join(", ");
    lines.push(`- 프로바이더 쿨다운 경고: ${providers}`);
  }

  const recommendations = input.recommendations ?? [];
  if (recommendations.length > 0) {
    lines.push("", "### 우선 권장 조치");
    for (const recommendation of recommendations.slice(0, MAX_RECOMMENDATIONS)) {
      const agentName = sanitizeInline(recommendation.agentName);
      const actionLabel = sanitizeInline(recommendation.actionLabel);
      const reason = sanitizeInline(recommendation.reason);
      lines.push(`- **${agentName}** — ${actionLabel}: ${reason}`);
    }

    const remaining = recommendations.length - MAX_RECOMMENDATIONS;
    if (remaining > 0) {
      lines.push(`- +${remaining}건 더 있음`);
    }
  }

  return lines.join("\n");
}
