export type ConcurrencyAlertKind =
  | "queue_starvation"
  | "wait_deadlock"
  | "provider_circuit_open"
  | "mission_budget_exhausted";

export interface ConcurrencyAlertInput {
  companyId: string;
  kind: ConcurrencyAlertKind;
  severity: "warning" | "critical";
  targetId: string;
  targetLabel: string;
  summary: string;
  occurredAtIso: string;
  baseUrl?: string;
}

export interface ConcurrencyAlertPayload {
  dedupKey: string;
  companyId: string;
  kind: ConcurrencyAlertKind;
  severity: "warning" | "critical";
  title: string;
  body: string;
  deepLink: string;
  occurredAtIso: string;
}

const alertTitles: Record<ConcurrencyAlertKind, string> = {
  queue_starvation: "장기 대기 경보",
  wait_deadlock: "순환 대기 감지",
  provider_circuit_open: "프로바이더 서킷 차단",
  mission_budget_exhausted: "미션 예산 소진",
};

function normalizedBaseUrl(baseUrl: string | undefined): string {
  return (baseUrl ?? "").trim().replace(/\/+$/, "");
}

export function buildConcurrencyAlertPayload(
  input: ConcurrencyAlertInput,
): ConcurrencyAlertPayload {
  const encodedTargetId = encodeURIComponent(input.targetId);
  const path = input.kind === "mission_budget_exhausted"
    ? `/missions/${encodedTargetId}`
    : `/agents/${encodedTargetId}`;

  return {
    dedupKey: `${input.companyId}:${input.kind}:${input.targetId}`,
    companyId: input.companyId,
    kind: input.kind,
    severity: input.severity,
    title: `${alertTitles[input.kind]}: ${input.targetLabel}`,
    body: input.summary,
    deepLink: `${normalizedBaseUrl(input.baseUrl)}${path}`,
    occurredAtIso: input.occurredAtIso,
  };
}
