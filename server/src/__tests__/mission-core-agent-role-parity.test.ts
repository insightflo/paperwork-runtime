import { execFileSync, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  describeMissionExecutionLiaisonBoundary,
  isMissionExecutionLiaisonAgent,
  isRunnableMissionExecutionAssigneeStatus,
  resolveHermesOpsLiaisonIdentity,
  resolveHermesOpsMode,
  RUNNABLE_MISSION_EXECUTION_ASSIGNEE_STATUSES,
} from "../services/missions/agent-role-boundaries.js";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const rustBin = path.join(repoRoot, "crates/mission-core/target/release/paperclip-mission-core");

beforeAll(() => {
  const which = String(spawnSync("which", ["cargo"], { encoding: "utf8" }).stdout ?? "").trim();
  const cargoBin = process.env.CARGO || which || path.join(homedir(), ".cargo/bin/cargo");
  execFileSync(
    cargoBin,
    ["build", "--release", "--manifest-path", path.join(repoRoot, "crates/mission-core/Cargo.toml")],
    { stdio: "inherit" },
  );
}, 240_000);

type Outcome = { threw: false; value: unknown } | { threw: true; error: string };
function ts(fn: () => unknown): Outcome {
  try {
    const v = fn();
    return { threw: false, value: v === undefined ? null : v };
  } catch (err) {
    return { threw: true, error: err instanceof Error ? err.message : String(err) };
  }
}
function rust(subcommand: string, payload: unknown): Outcome {
  const res = spawnSync(rustBin, [subcommand], {
    input: JSON.stringify(payload), encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
  });
  if (res.error || res.status !== 0) {
    return { threw: true, error: String(res.error ?? res.stderr).trim() };
  }
  return { threw: false, value: JSON.parse(String(res.stdout)) };
}
function expectParity(t: Outcome, r: Outcome, exactError = false): void {
  if (r.threw !== t.threw) {
    throw new Error(`throw parity mismatch: ts=${JSON.stringify(t)} rust=${JSON.stringify(r)}`);
  }
  if (!t.threw) {
    expect(r.value).toEqual(t.value);
  } else if (exactError) {
    expect(r.error).toBe(t.error);
  }
}

const callTs = {
  "runnable-assignee-statuses": (_p: Record<string, unknown>) =>
    [...RUNNABLE_MISSION_EXECUTION_ASSIGNEE_STATUSES],
  "is-runnable-assignee-status": (p: Record<string, unknown>) =>
    isRunnableMissionExecutionAssigneeStatus(p.status as string),
  "is-liaison-agent": (p: Record<string, unknown>) =>
    isMissionExecutionLiaisonAgent(p.agent as never),
  "resolve-hermes-ops-mode": (p: Record<string, unknown>) =>
    resolveHermesOpsMode(p.agent as never),
  "resolve-hermes-ops-liaison-identity": (p: Record<string, unknown>) =>
    resolveHermesOpsLiaisonIdentity(p.agent as never),
  "describe-liaison-boundary": (p: Record<string, unknown>) =>
    describeMissionExecutionLiaisonBoundary(p.agent as never),
} as const;
type Sub = keyof typeof callTs;
const parity = (sub: Sub, payload: unknown, exact = false) =>
  expectParity(ts(() => callTs[sub](payload as Record<string, unknown>)), rust(sub, payload), exact);

const agent = (o: Record<string, unknown>) => ({ agent: { name: "n", ...o } });
const hermes = (runtimeConfig: unknown, name?: unknown) =>
  ({ agent: { adapterType: "hermes_local", runtimeConfig, ...(name !== undefined ? { name } : {}) } });

const cases: Array<{ sub: Sub; name: string; payload: unknown; exact?: boolean }> = [
  { sub: "runnable-assignee-statuses", name: "constant dumps in Set order", payload: {} },
  { sub: "is-runnable-assignee-status", name: "active/idle/running are runnable", payload: { status: "active" } },
  { sub: "is-runnable-assignee-status", name: "idle runnable", payload: { status: "idle" } },
  { sub: "is-runnable-assignee-status", name: "unlisted status not runnable", payload: { status: "paused" } },
  { sub: "is-runnable-assignee-status", name: "untrimmed member is not runnable", payload: { status: " running" } },
  { sub: "is-runnable-assignee-status", name: "case-sensitive", payload: { status: "Active" } },
  { sub: "is-runnable-assignee-status", name: "missing/null/number/object statuses not runnable", payload: { status: null } },
  { sub: "is-runnable-assignee-status", name: "numeric status not runnable", payload: { status: 7 } },
  { sub: "is-runnable-assignee-status", name: "missing status key not runnable", payload: {} },
  { sub: "is-liaison-agent", name: "non-hermes adapter is not liaison even with matching name", payload: agent({ adapterType: "claude_local", name: "Hermes Ops Manager" }) },
  { sub: "is-liaison-agent", name: "non-string adapterType is not liaison", payload: agent({ adapterType: 7 }) },
  { sub: "is-liaison-agent", name: "hermes adapter alone is not liaison", payload: hermes({}) },
  { sub: "is-liaison-agent", name: "operationsLiaison === true flags liaison", payload: hermes({ operationsLiaison: true }) },
  { sub: "is-liaison-agent", name: "operationsLiaison truthy non-boolean does not flag", payload: hermes({ operationsLiaison: 1, domain: "x" }) },
  { sub: "is-liaison-agent", name: "hermesOpsMode any string flags (even empty)", payload: hermes({ hermesOpsMode: "" }) },
  { sub: "is-liaison-agent", name: "hermesOpsMode non-string does not flag", payload: hermes({ hermesOpsMode: 5 }) },
  { sub: "is-liaison-agent", name: "domain operations flags", payload: hermes({ domain: "operations" }) },
  { sub: "is-liaison-agent", name: "domain trimmed before compare", payload: hermes({ domain: "  operations  " }) },
  { sub: "is-liaison-agent", name: "domain case-sensitive", payload: hermes({ domain: "Operations" }) },
  { sub: "is-liaison-agent", name: "domain non-string ignored", payload: hermes({ domain: ["operations"] }) },
  { sub: "is-liaison-agent", name: "chief_of_staff_liaison operatingMode flags", payload: hermes({ operatingMode: "chief_of_staff_liaison" }) },
  { sub: "is-liaison-agent", name: "independent_management_operator flags", payload: hermes({ operatingMode: "independent_management_operator" }) },
  { sub: "is-liaison-agent", name: "operatingMode trimmed", payload: hermes({ operatingMode: " chief_of_staff_liaison\n" }) },
  { sub: "is-liaison-agent", name: "legacy name Hermes Ops Manager flags", payload: hermes({}, "Hermes Ops Manager") },
  { sub: "is-liaison-agent", name: "legacy name Hermes Operations Manager flags", payload: hermes({}, "Hermes Operations Manager") },
  { sub: "is-liaison-agent", name: "untrimmed legacy name does not flag", payload: hermes({}, "Hermes Ops Manager ") },
  { sub: "is-liaison-agent", name: "non-string name does not flag", payload: hermes({}, ["Hermes Ops Manager"]) },
  { sub: "is-liaison-agent", name: "runtimeConfig non-record shapes read empty", payload: agent({ adapterType: "hermes_local", runtimeConfig: "operations" }) },
  { sub: "is-liaison-agent", name: "runtimeConfig array reads empty", payload: agent({ adapterType: "hermes_local", runtimeConfig: ["operations"] }) },
  { sub: "is-liaison-agent", name: "metadata is never consumed", payload: agent({ adapterType: "hermes_local", runtimeConfig: {}, metadata: { domain: "operations", operationsLiaison: true } }) },
  { sub: "is-liaison-agent", name: "primitive agent values are not liaison", payload: { agent: 7 } },
  { sub: "is-liaison-agent", name: "array agent is not liaison", payload: { agent: [{ adapterType: "hermes_local" }] } },
  { sub: "is-liaison-agent", name: "null agent throws TypeError text", payload: { agent: null }, exact: true },
  { sub: "is-liaison-agent", name: "missing agent throws undefined text", payload: {}, exact: true },
  { sub: "resolve-hermes-ops-mode", name: "supervision/relay/admin resolve verbatim", payload: hermes({ hermesOpsMode: "supervision" }) },
  { sub: "resolve-hermes-ops-mode", name: "relay resolves", payload: hermes({ hermesOpsMode: "relay" }) },
  { sub: "resolve-hermes-ops-mode", name: "admin resolves", payload: hermes({ hermesOpsMode: "admin" }) },
  { sub: "resolve-hermes-ops-mode", name: "explicit advisor stays advisor", payload: hermes({ hermesOpsMode: "advisor" }) },
  { sub: "resolve-hermes-ops-mode", name: "untrimmed privileged mode falls back", payload: hermes({ hermesOpsMode: "admin " }) },
  { sub: "resolve-hermes-ops-mode", name: "unknown string falls back", payload: hermes({ hermesOpsMode: "root" }) },
  { sub: "resolve-hermes-ops-mode", name: "non-string mode falls back", payload: hermes({ hermesOpsMode: ["admin"] }) },
  { sub: "resolve-hermes-ops-mode", name: "no adapter gate on mode resolution", payload: agent({ adapterType: "claude_local", runtimeConfig: { hermesOpsMode: "admin" } }) },
  { sub: "resolve-hermes-ops-mode", name: "non-record runtimeConfig falls back", payload: agent({ adapterType: "hermes_local", runtimeConfig: 5 }) },
  { sub: "resolve-hermes-ops-mode", name: "primitive agent reads undefined runtimeConfig", payload: { agent: "x" } },
  { sub: "resolve-hermes-ops-mode", name: "null agent throws", payload: { agent: null }, exact: true },
  { sub: "resolve-hermes-ops-mode", name: "missing agent throws", payload: {}, exact: true },
  { sub: "resolve-hermes-ops-liaison-identity", name: "non-liaison omits hermesOpsMode key", payload: hermes({}) },
  { sub: "resolve-hermes-ops-liaison-identity", name: "non-liaison adapter identity false", payload: { agent: { adapterType: "other" } } },
  { sub: "resolve-hermes-ops-liaison-identity", name: "liaison defaults to advisor", payload: hermes({ domain: "operations" }) },
  { sub: "resolve-hermes-ops-liaison-identity", name: "liaison with privileged mode", payload: hermes({ hermesOpsMode: "relay" }) },
  { sub: "resolve-hermes-ops-liaison-identity", name: "liaison via flag keeps advisor", payload: hermes({ operationsLiaison: true }) },
  { sub: "resolve-hermes-ops-liaison-identity", name: "null agent throws adapterType read", payload: { agent: null }, exact: true },
  { sub: "describe-liaison-boundary", name: "string name interpolates", payload: agent({ name: "A" }) },
  { sub: "describe-liaison-boundary", name: "missing name renders undefined", payload: agent({ name: undefined }) },
  { sub: "describe-liaison-boundary", name: "null name renders null", payload: { agent: { name: null } } },
  { sub: "describe-liaison-boundary", name: "numeric name stringifies", payload: { agent: { name: 7.5 } } },
  { sub: "describe-liaison-boundary", name: "array name joins with commas; null element renders empty", payload: { agent: { name: ["x", null, 3] } } },
  { sub: "describe-liaison-boundary", name: "object name renders [object Object]", payload: { agent: { name: { a: 1 } } } },
  { sub: "describe-liaison-boundary", name: "boolean name renders true", payload: { agent: { name: true } } },
  { sub: "describe-liaison-boundary", name: "primitive agent name reads undefined without throwing", payload: { agent: 42 } },
  { sub: "describe-liaison-boundary", name: "null agent throws name read", payload: { agent: null }, exact: true },
  { sub: "describe-liaison-boundary", name: "missing agent throws undefined name read", payload: {}, exact: true },
];

describe("agent-role-boundaries: TS vs paperclip-mission-core", () => {
  for (const c of cases) {
    it(`parity ${c.sub}: ${c.name}`, () => parity(c.sub, c.payload, c.exact));
  }
});
