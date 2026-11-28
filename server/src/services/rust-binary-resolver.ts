import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/**
 * Resolves a Rust SSOT engine binary path.
 * Priority:
 *   1. Explicit env override (must be an absolute path without NUL; relative/invalid throws)
 *   2. Workspace staged release binary: crates/<crateDir>/target/release/<binaryName>
 *   3. Workspace unified release binary: target/release/<binaryName>
 *   4. Workspace unified debug binary:   target/debug/<binaryName>
 */
export function resolveRustBinary(
  envKey: string,
  crateDir: string,
  binaryName: string,
): string {
  const configured = process.env[envKey];
  if (configured !== undefined && configured !== "") {
    if (configured.includes("\0") || !path.isAbsolute(configured)) {
      throw new Error(`[rust-ssot] Invalid ${envKey}: expected absolute path, got "${configured}"`);
    }
    return configured;
  }

  const candidates = [
    path.join(REPO_ROOT, "crates", crateDir, "target", "release", binaryName),
    path.join(REPO_ROOT, "target", "release", binaryName),
    path.join(REPO_ROOT, "target", "debug", binaryName),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  throw new Error(
    `[rust-ssot] Missing Rust engine binary "${binaryName}" (checked ${envKey} and ${candidates.join(", ")})`,
  );
}
