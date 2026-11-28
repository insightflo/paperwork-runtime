// Thin Rust SSOT adapter — implementation lives exclusively in crates/verdict-core.
// Original TS implementation archived at tag: archive/ts-engines-pre-rust-removal-20261129.
import { readExplicitValidationVerdictViaRust } from "./verdict-core-client.js";

export type ValidationVerdict = "pass" | "request_changes";

export interface ReadExplicitValidationVerdictOptions {
  allowLeadingVerdict?: boolean;
}

export function readExplicitValidationVerdict(
  value: string | null | undefined,
  options: ReadExplicitValidationVerdictOptions = {},
): ValidationVerdict | null {
  if (!value) return null;
  return readExplicitValidationVerdictViaRust(value, options).verdict;
}
