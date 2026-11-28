import { describe, expect, it } from "vitest";
import {
  buildConcurrencyAlertPayload,
  type ConcurrencyAlertInput,
  type ConcurrencyAlertKind,
} from "../services/heartbeat-alert-payload.js";

function inputFor(kind: ConcurrencyAlertKind, overrides: Partial<ConcurrencyAlertInput> = {}): ConcurrencyAlertInput {
  return {
    companyId: "company-1",
    kind,
    severity: "critical",
    targetId: "target-1",
    targetLabel: "대상 1",
    summary: "운영 경보 요약",
    occurredAtIso: "2026-11-28T12:34:56.000Z",
    ...overrides,
  };
}

describe("buildConcurrencyAlertPayload", () => {
  it.each([
    ["queue_starvation", "장기 대기 경보", "/agents/target-1"],
    ["wait_deadlock", "순환 대기 감지", "/agents/target-1"],
    ["provider_circuit_open", "프로바이더 서킷 차단", "/agents/target-1"],
    ["mission_budget_exhausted", "미션 예산 소진", "/missions/target-1"],
  ] as const)("builds the %s payload contract", (kind, titlePrefix, deepLink) => {
    const input = inputFor(kind);

    expect(buildConcurrencyAlertPayload(input)).toEqual({
      dedupKey: `company-1:${kind}:target-1`,
      companyId: input.companyId,
      kind,
      severity: input.severity,
      title: `${titlePrefix}: 대상 1`,
      body: input.summary,
      deepLink,
      occurredAtIso: input.occurredAtIso,
    });
  });

  it("keeps dedup keys deterministic for repeated identical input", () => {
    const input = inputFor("queue_starvation", {
      targetId: "agent/shared workspace?&=한글",
    });

    const first = buildConcurrencyAlertPayload(input);
    const second = buildConcurrencyAlertPayload(input);

    expect(first.dedupKey).toBe("company-1:queue_starvation:agent/shared workspace?&=한글");
    expect(second.dedupKey).toBe(first.dedupKey);
    expect(second).toEqual(first);
  });

  it("URL-encodes deep-link target identifiers", () => {
    const targetId = "agent/shared workspace?&=한글";
    const payload = buildConcurrencyAlertPayload(inputFor("wait_deadlock", { targetId }));

    expect(payload.deepLink).toBe(`/agents/${encodeURIComponent(targetId)}`);
    expect(payload.deepLink).not.toContain(targetId);
  });

  it("routes only mission budget exhaustion to mission deep links", () => {
    const targetId = "mission/shared workspace?&=한글";
    const payload = buildConcurrencyAlertPayload(inputFor("mission_budget_exhausted", { targetId }));

    expect(payload.deepLink).toBe(`/missions/${encodeURIComponent(targetId)}`);
  });

  it("prefixes a trimmed base URL without trailing slashes", () => {
    const payload = buildConcurrencyAlertPayload(inputFor("provider_circuit_open", {
      baseUrl: "  https://ops.example.com/alerts///  ",
    }));

    expect(payload.deepLink).toBe("https://ops.example.com/alerts/agents/target-1");
  });

  it("supports every alert kind with and without a base URL", () => {
    for (const kind of [
      "queue_starvation",
      "wait_deadlock",
      "provider_circuit_open",
      "mission_budget_exhausted",
    ] as const) {
      const plain = buildConcurrencyAlertPayload(inputFor(kind));
      const prefixed = buildConcurrencyAlertPayload(inputFor(kind, { baseUrl: "https://ops.example.com/" }));

      expect(plain.deepLink.startsWith("/")).toBe(true);
      expect(prefixed.deepLink).toBe(`https://ops.example.com${plain.deepLink}`);
    }
  });
});
