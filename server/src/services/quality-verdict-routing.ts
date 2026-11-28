// Thin Rust SSOT adapter — implementation lives exclusively in crates/verdict-core.
// Original TS implementation archived at tag: archive/ts-engines-pre-rust-removal-20261129.
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

export function resolveQualityVerdictRouting(input: {
  verdict: string;
  reason?: string | null;
  failureType?: string | null;
  requiredEvidenceSurfaces?: readonly string[];
}): QualityVerdictRouting {
  return resolveQualityVerdictRoutingViaRust(input);
}
