import { resolveQualityVerdictRoutingViaRust } from "./verdict-core-client.js";

export type QualityVerdictRouting =
  | { kind: "none" }
  | { kind: "evidence"; reason: string | null; requiredEvidenceSurfaces: string[] }
  | {
      kind: "correction";
      verdict: "fail" | "request_changes";
      reason: string | null;
      failureType: string | null;
    };

function normalizeRequiredEvidenceSurfaces(surfaces: readonly string[] | undefined): string[] {
  if (!surfaces) return [];
  return surfaces.map((surface) => surface.trim()).filter(Boolean);
}

export function resolveQualityVerdictRouting(input: {
  verdict: string;
  reason?: string | null;
  failureType?: string | null;
  requiredEvidenceSurfaces?: readonly string[];
}): QualityVerdictRouting {
  // [이유] opt-in Rust 팔(게이트: PAPERCLIP_VERDICT_CORE_BIN). 폐쇄·실패 시 null 이므로
  //   기존 TS 본문이 그대로 parity 의 최종 출처가 된다 — 호출부 시그니처는 불변이다.
  const viaRust = resolveQualityVerdictRoutingViaRust(input);
  if (viaRust !== null) return viaRust;
  if (input.verdict === "needs_evidence") {
    return {
      kind: "evidence",
      reason: input.reason ?? null,
      requiredEvidenceSurfaces: normalizeRequiredEvidenceSurfaces(input.requiredEvidenceSurfaces),
    };
  }

  if (input.verdict === "fail" || input.verdict === "request_changes") {
    return {
      kind: "correction",
      verdict: input.verdict,
      reason: input.reason ?? null,
      failureType: input.failureType ?? null,
    };
  }

  return { kind: "none" };
}
