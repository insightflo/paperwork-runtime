import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  evaluateBotDispatch,
  evaluateCapabilityDataScope,
  evaluateChannelInvoke,
  evaluateTerminalCommand,
  type BotDispatchInput,
  type CapabilityDataScopeInput,
  type ChannelInvokeInput,
  type ForcedFilter,
  type TerminalCommandInput,
} from "../services/bot-governance.js";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

function findExistingBinary(): string | null {
  const candidates = [
    process.env.PAPERWORK_BOT_BIN,
    path.join(repoRoot, "target/debug/paperwork-bot"),
    path.join(repoRoot, "target/release/paperwork-bot"),
    path.join(repoRoot, "crates/bot-runtime/target/debug/paperwork-bot"),
    path.join(repoRoot, "crates/bot-runtime/target/release/paperwork-bot"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function findCargoBin(): string | null {
  const which = String(spawnSync("which", ["cargo"], { encoding: "utf8" }).stdout ?? "").trim();
  const candidate = process.env.CARGO || which || path.join(homedir(), ".cargo/bin/cargo");
  return existsSync(candidate) ? candidate : null;
}

const cargoBin = findCargoBin();
const canRunRustParity = findExistingBinary() !== null || cargoBin !== null;

let rustBin = "";

interface RustGovernanceDecision {
  allowed: boolean;
  requires_approval: boolean;
  effect: "allow" | "deny" | "require_approval";
  reason_code: string;
  message: string;
}

function evalRustPolicy(payload: Record<string, unknown>): RustGovernanceDecision {
  const res = spawnSync(rustBin, ["eval-policy"], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (res.error || res.status !== 0) {
    throw new Error(
      `paperwork-bot eval-policy failed (status=${String(res.status)}): ${String(res.error ?? res.stderr).trim()}`,
    );
  }
  return JSON.parse(String(res.stdout).trim()) as RustGovernanceDecision;
}

function assertAllowedParity(
  nodeDecision: { allowed: boolean; reason: string },
  rustDecision: RustGovernanceDecision,
  opts?: {
    expectedAllowed: boolean;
    expectedNodeReason?: string;
    expectedRustReason?: string;
    expectedRequiresApproval?: boolean;
  },
): void {
  expect(rustDecision.allowed).toBe(nodeDecision.allowed);
  if (opts?.expectedAllowed !== undefined) {
    expect(nodeDecision.allowed).toBe(opts.expectedAllowed);
    expect(rustDecision.allowed).toBe(opts.expectedAllowed);
  }
  if (opts?.expectedNodeReason !== undefined) {
    expect(nodeDecision.reason).toBe(opts.expectedNodeReason);
  }
  if (opts?.expectedRustReason !== undefined) {
    expect(rustDecision.reason_code).toBe(opts.expectedRustReason);
  }
  if (opts?.expectedRequiresApproval !== undefined) {
    expect(rustDecision.requires_approval).toBe(opts.expectedRequiresApproval);
    expect(rustDecision.effect).toBe(
      opts.expectedRequiresApproval
        ? "require_approval"
        : opts.expectedAllowed
          ? "allow"
          : "deny",
    );
  }
}

describe.skipIf(!canRunRustParity)("bot-governance: Node vs Rust paperwork-bot eval-policy parity", () => {
  beforeAll(() => {
    if (process.env.PAPERWORK_BOT_BIN && existsSync(process.env.PAPERWORK_BOT_BIN)) {
      rustBin = process.env.PAPERWORK_BOT_BIN;
      return;
    }
    if (cargoBin) {
      execFileSync(
        cargoBin,
        ["build", "-p", "paperwork-bot-runtime", "--manifest-path", path.join(repoRoot, "Cargo.toml")],
        { stdio: "inherit" },
      );
    }
    const resolved = findExistingBinary();
    if (!resolved) {
      throw new Error("paperwork-bot binary not found after cargo build");
    }
    rustBin = resolved;
  }, 240_000);

  describe("evaluateBotDispatch <-> action: bot_dispatch", () => {
    const dispatchVectors: Array<{
      name: string;
      node: BotDispatchInput;
      rust: Record<string, unknown>;
      expectedAllowed: boolean;
      expectedNodeReason: string;
      expectedRustReason: string;
    }> = [
      {
        name: "allows active company bot dispatched by same-company member",
        node: {
          callerUserId: "u-sales",
          callerTeamId: "team-sales",
          callerRole: "member",
          callerCompanyId: "company-a",
          companyId: "company-a",
          kind: "company",
          ownerUserId: "u-owner",
          teamId: null,
          callableBy: "company",
          status: "active",
        },
        rust: {
          action: "bot_dispatch",
          actor: { company_id: "company-a", user_id: "u-sales", team_id: "team-sales", role: "member" },
          bot: {
            bot_id: "bot-co",
            company_id: "company-a",
            owner_user_id: "u-owner",
            team_id: null,
            kind: "company",
            callable_by: "company",
            data_scope: "company",
            status: "active",
            requires_approval: false,
          },
        },
        expectedAllowed: true,
        expectedNodeReason: "allowed",
        expectedRustReason: "ok",
      },
      {
        name: "allows personal self_only bot dispatched by its owner",
        node: {
          callerUserId: "u-owner",
          callerTeamId: "team-sales",
          callerRole: "member",
          callerCompanyId: "company-a",
          companyId: "company-a",
          kind: "personal",
          ownerUserId: "u-owner",
          teamId: "team-sales",
          callableBy: "self_only",
          status: "active",
        },
        rust: {
          action: "bot_dispatch",
          actor: { company_id: "company-a", user_id: "u-owner", team_id: "team-sales", role: "member" },
          bot: {
            bot_id: "bot-personal",
            company_id: "company-a",
            owner_user_id: "u-owner",
            team_id: "team-sales",
            kind: "personal",
            callable_by: "self_only",
            data_scope: "self",
            status: "active",
            requires_approval: false,
          },
        },
        expectedAllowed: true,
        expectedNodeReason: "allowed",
        expectedRustReason: "ok",
      },
      {
        name: "denies personal self_only bot dispatched by non-owner admin",
        node: {
          callerUserId: "u-admin",
          callerTeamId: "team-sales",
          callerRole: "admin",
          callerCompanyId: "company-a",
          companyId: "company-a",
          kind: "personal",
          ownerUserId: "u-owner",
          teamId: "team-sales",
          callableBy: "self_only",
          status: "active",
        },
        rust: {
          action: "bot_dispatch",
          actor: { company_id: "company-a", user_id: "u-admin", team_id: "team-sales", role: "admin" },
          bot: {
            bot_id: "bot-personal",
            company_id: "company-a",
            owner_user_id: "u-owner",
            team_id: "team-sales",
            kind: "personal",
            callable_by: "self_only",
            data_scope: "self",
            status: "active",
            requires_approval: false,
          },
        },
        expectedAllowed: false,
        expectedNodeReason: "self_only_denied",
        expectedRustReason: "not_bot_owner",
      },
      {
        name: "allows team bot for same-team member",
        node: {
          callerUserId: "u-sales",
          callerTeamId: "team-sales",
          callerRole: "member",
          callerCompanyId: "company-a",
          companyId: "company-a",
          kind: "team",
          ownerUserId: "u-lead",
          teamId: "team-sales",
          callableBy: "team",
          status: "active",
        },
        rust: {
          action: "bot_dispatch",
          actor: { company_id: "company-a", user_id: "u-sales", team_id: "team-sales", role: "member" },
          bot: {
            bot_id: "bot-team",
            company_id: "company-a",
            owner_user_id: "u-lead",
            team_id: "team-sales",
            kind: "team",
            callable_by: "team",
            data_scope: "team",
            status: "active",
            requires_approval: false,
          },
        },
        expectedAllowed: true,
        expectedNodeReason: "allowed",
        expectedRustReason: "ok",
      },
      {
        name: "denies team bot for cross-team member",
        node: {
          callerUserId: "u-hr",
          callerTeamId: "team-hr",
          callerRole: "member",
          callerCompanyId: "company-a",
          companyId: "company-a",
          kind: "team",
          ownerUserId: "u-lead",
          teamId: "team-sales",
          callableBy: "team",
          status: "active",
        },
        rust: {
          action: "bot_dispatch",
          actor: { company_id: "company-a", user_id: "u-hr", team_id: "team-hr", role: "member" },
          bot: {
            bot_id: "bot-team",
            company_id: "company-a",
            owner_user_id: "u-lead",
            team_id: "team-sales",
            kind: "team",
            callable_by: "team",
            data_scope: "team",
            status: "active",
            requires_approval: false,
          },
        },
        expectedAllowed: false,
        expectedNodeReason: "team_scope_denied",
        expectedRustReason: "team_mismatch",
      },
      {
        name: "denies cross-company bot dispatch even for company owner",
        node: {
          callerUserId: "u-owner",
          callerTeamId: "team-sales",
          callerRole: "owner",
          callerCompanyId: "company-b",
          companyId: "company-a",
          kind: "company",
          ownerUserId: "u-owner",
          teamId: null,
          callableBy: "company",
          status: "active",
        },
        rust: {
          action: "bot_dispatch",
          actor: { company_id: "company-b", user_id: "u-owner", team_id: "team-sales", role: "owner" },
          bot: {
            bot_id: "bot-co",
            company_id: "company-a",
            owner_user_id: "u-owner",
            team_id: null,
            kind: "company",
            callable_by: "company",
            data_scope: "company",
            status: "active",
            requires_approval: false,
          },
        },
        expectedAllowed: false,
        expectedNodeReason: "cross_company_denied",
        expectedRustReason: "company_mismatch",
      },
      {
        name: "denies revoked bot dispatch",
        node: {
          callerUserId: "u-owner",
          callerTeamId: "team-sales",
          callerRole: "owner",
          callerCompanyId: "company-a",
          companyId: "company-a",
          kind: "company",
          ownerUserId: "u-owner",
          teamId: null,
          callableBy: "company",
          status: "revoked",
        },
        rust: {
          action: "bot_dispatch",
          actor: { company_id: "company-a", user_id: "u-owner", team_id: "team-sales", role: "owner" },
          bot: {
            bot_id: "bot-co",
            company_id: "company-a",
            owner_user_id: "u-owner",
            team_id: null,
            kind: "company",
            callable_by: "company",
            data_scope: "company",
            status: "revoked",
            requires_approval: false,
          },
        },
        expectedAllowed: false,
        expectedNodeReason: "bot_inactive",
        expectedRustReason: "bot_revoked",
      },
      {
        name: "denies paused bot dispatch",
        node: {
          callerUserId: "u-owner",
          callerTeamId: "team-sales",
          callerRole: "owner",
          callerCompanyId: "company-a",
          companyId: "company-a",
          kind: "company",
          ownerUserId: "u-owner",
          teamId: null,
          callableBy: "company",
          status: "paused",
        },
        rust: {
          action: "bot_dispatch",
          actor: { company_id: "company-a", user_id: "u-owner", team_id: "team-sales", role: "owner" },
          bot: {
            bot_id: "bot-co",
            company_id: "company-a",
            owner_user_id: "u-owner",
            team_id: null,
            kind: "company",
            callable_by: "company",
            data_scope: "company",
            status: "paused",
            requires_approval: false,
          },
        },
        expectedAllowed: false,
        expectedNodeReason: "bot_inactive",
        expectedRustReason: "bot_paused",
      },
    ];

    for (const v of dispatchVectors) {
      it(v.name, () => {
        const nodeDecision = evaluateBotDispatch(v.node);
        const rustDecision = evalRustPolicy(v.rust);
        assertAllowedParity(nodeDecision, rustDecision, {
          expectedAllowed: v.expectedAllowed,
          expectedNodeReason: v.expectedNodeReason,
          expectedRustReason: v.expectedRustReason,
          expectedRequiresApproval: false,
        });
      });
    }
  });

  describe("evaluateCapabilityDataScope <-> action: capability_data_scope", () => {
    const scopeVectors: Array<{
      name: string;
      node: CapabilityDataScopeInput;
      rust: Record<string, unknown>;
      expectedAllowed: boolean;
      expectedForcedFilter: ForcedFilter | null;
      expectedNodeReason: string;
      expectedRustReason: string;
    }> = [
      {
        name: "allows data_scope=self on caller's own record with ownerUserId forced filter",
        node: {
          caller: { userId: "u-sales", teamId: "team-sales", role: "member", companyId: "company-a" },
          capability: { capabilityKey: "salary.read", callableBy: "company", dataScope: "self", requiresApproval: false },
          targetRecord: { ownerUserId: "u-sales", teamId: "team-sales", companyId: "company-a" },
        },
        rust: {
          action: "capability_data_scope",
          actor: { company_id: "company-a", user_id: "u-sales", team_id: "team-sales", role: "member" },
          bot: {
            bot_id: "bot-hr",
            company_id: "company-a",
            owner_user_id: "u-sales",
            team_id: "team-sales",
            kind: "company",
            callable_by: "company",
            data_scope: "self",
            status: "active",
            requires_approval: false,
          },
          requested_scope: "self",
          target_company_id: "company-a",
          target_team_id: "team-sales",
          target_user_id: "u-sales",
        },
        expectedAllowed: true,
        expectedForcedFilter: { ownerUserId: "u-sales" },
        expectedNodeReason: "allowed",
        expectedRustReason: "data_scope_allowed",
      },
      {
        name: "denies data_scope=self on colleague's private record",
        node: {
          caller: { userId: "u-sales", teamId: "team-sales", role: "member", companyId: "company-a" },
          capability: { capabilityKey: "salary.read", callableBy: "company", dataScope: "self", requiresApproval: false },
          targetRecord: { ownerUserId: "u-colleague", teamId: "team-sales", companyId: "company-a" },
        },
        rust: {
          action: "capability_data_scope",
          actor: { company_id: "company-a", user_id: "u-sales", team_id: "team-sales", role: "member" },
          bot: {
            bot_id: "bot-hr",
            company_id: "company-a",
            owner_user_id: "u-sales",
            team_id: "team-sales",
            kind: "company",
            callable_by: "company",
            data_scope: "self",
            status: "active",
            requires_approval: false,
          },
          requested_scope: "self",
          target_company_id: "company-a",
          target_team_id: "team-sales",
          target_user_id: "u-colleague",
        },
        expectedAllowed: false,
        expectedForcedFilter: null,
        expectedNodeReason: "data_scope_self_violation",
        expectedRustReason: "self_scope_user_mismatch",
      },
      {
        name: "allows data_scope=team on same-team record with teamId forced filter",
        node: {
          caller: { userId: "u-sales", teamId: "team-sales", role: "member", companyId: "company-a" },
          capability: { capabilityKey: "crm.read", callableBy: "team", dataScope: "team", requiresApproval: false },
          targetRecord: { ownerUserId: "u-colleague", teamId: "team-sales", companyId: "company-a" },
        },
        rust: {
          action: "capability_data_scope",
          actor: { company_id: "company-a", user_id: "u-sales", team_id: "team-sales", role: "member" },
          bot: {
            bot_id: "bot-sales",
            company_id: "company-a",
            owner_user_id: "u-lead",
            team_id: "team-sales",
            kind: "team",
            callable_by: "team",
            data_scope: "team",
            status: "active",
            requires_approval: false,
          },
          requested_scope: "team",
          target_company_id: "company-a",
          target_team_id: "team-sales",
          target_user_id: "u-colleague",
        },
        expectedAllowed: true,
        expectedForcedFilter: { teamId: "team-sales" },
        expectedNodeReason: "allowed",
        expectedRustReason: "data_scope_allowed",
      },
      {
        name: "denies data_scope=team on another team's record",
        node: {
          caller: { userId: "u-sales", teamId: "team-sales", role: "member", companyId: "company-a" },
          capability: { capabilityKey: "crm.read", callableBy: "company", dataScope: "team", requiresApproval: false },
          targetRecord: { ownerUserId: "u-hr", teamId: "team-hr", companyId: "company-a" },
        },
        rust: {
          action: "capability_data_scope",
          actor: { company_id: "company-a", user_id: "u-sales", team_id: "team-sales", role: "member" },
          bot: {
            bot_id: "bot-sales",
            company_id: "company-a",
            owner_user_id: "u-lead",
            team_id: "team-sales",
            kind: "team",
            callable_by: "company",
            data_scope: "team",
            status: "active",
            requires_approval: false,
          },
          requested_scope: "team",
          target_company_id: "company-a",
          target_team_id: "team-hr",
          target_user_id: "u-hr",
        },
        expectedAllowed: false,
        expectedForcedFilter: null,
        expectedNodeReason: "data_scope_team_violation",
        expectedRustReason: "team_scope_mismatch",
      },
      {
        name: "allows data_scope=company on same-company record with companyId forced filter",
        node: {
          caller: { userId: "u-sales", teamId: "team-sales", role: "member", companyId: "company-a" },
          capability: { capabilityKey: "kb.read", callableBy: "company", dataScope: "company", requiresApproval: false },
          targetRecord: { ownerUserId: "u-hr", teamId: "team-hr", companyId: "company-a" },
        },
        rust: {
          action: "capability_data_scope",
          actor: { company_id: "company-a", user_id: "u-sales", team_id: "team-sales", role: "member" },
          bot: {
            bot_id: "bot-kb",
            company_id: "company-a",
            owner_user_id: "u-owner",
            team_id: null,
            kind: "company",
            callable_by: "company",
            data_scope: "company",
            status: "active",
            requires_approval: false,
          },
          requested_scope: "company",
          target_company_id: "company-a",
          target_team_id: "team-hr",
          target_user_id: "u-hr",
        },
        expectedAllowed: true,
        expectedForcedFilter: { companyId: "company-a" },
        expectedNodeReason: "allowed",
        expectedRustReason: "data_scope_allowed",
      },
      {
        name: "denies cross-company data access regardless of data_scope=company",
        node: {
          caller: { userId: "u-sales", teamId: "team-sales", role: "member", companyId: "company-a" },
          capability: { capabilityKey: "kb.read", callableBy: "company", dataScope: "company", requiresApproval: false },
          targetRecord: { ownerUserId: "u-hr", teamId: "team-hr", companyId: "company-b" },
        },
        rust: {
          action: "capability_data_scope",
          actor: { company_id: "company-a", user_id: "u-sales", team_id: "team-sales", role: "member" },
          bot: {
            bot_id: "bot-kb",
            company_id: "company-a",
            owner_user_id: "u-owner",
            team_id: null,
            kind: "company",
            callable_by: "company",
            data_scope: "company",
            status: "active",
            requires_approval: false,
          },
          requested_scope: "company",
          target_company_id: "company-b",
          target_team_id: "team-hr",
          target_user_id: "u-hr",
        },
        expectedAllowed: false,
        expectedForcedFilter: null,
        expectedNodeReason: "cross_company_denied",
        expectedRustReason: "cross_company_data_denied",
      },
    ];

    for (const v of scopeVectors) {
      it(v.name, () => {
        const nodeDecision = evaluateCapabilityDataScope(v.node);
        const rustDecision = evalRustPolicy(v.rust);
        assertAllowedParity(nodeDecision, rustDecision, {
          expectedAllowed: v.expectedAllowed,
          expectedNodeReason: v.expectedNodeReason,
          expectedRustReason: v.expectedRustReason,
          expectedRequiresApproval: false,
        });
        expect(nodeDecision.forcedFilter).toEqual(v.expectedForcedFilter);
      });
    }
  });

  describe("evaluateTerminalCommand <-> action: terminal_command", () => {
    const terminalVectors: Array<{
      name: string;
      node: TerminalCommandInput;
      rust: Record<string, unknown>;
      expectedAllowed: boolean;
      expectedNodeReason: string;
      expectedRustReason: string;
    }> = [
      {
        name: "allows owner to exec on their own personal_terminal",
        node: {
          callerUserId: "u-owner",
          callerTeamId: "team-sales",
          callerRole: "member",
          callerCompanyId: "company-a",
          companyId: "company-a",
          kind: "personal_terminal",
          ownerUserId: "u-owner",
          teamId: "team-sales",
          status: "active",
          action: "exec",
        },
        rust: {
          action: "terminal_command",
          actor: { company_id: "company-a", user_id: "u-owner", team_id: "team-sales", role: "member" },
          terminal_company_id: "company-a",
          terminal_owner_user_id: "u-owner",
          terminal_team_id: "team-sales",
          terminal_active: true,
          command: "ls -la",
          requires_approval: false,
          dangerous: false,
          terminal_kind: "personal_terminal",
          terminal_action: "exec",
          bot_actor: null,
        },
        expectedAllowed: true,
        expectedNodeReason: "allowed",
        expectedRustReason: "terminal_command_allowed",
      },
      {
        name: "denies admin exec on another user's personal_terminal with personal_terminal_exec_denied",
        node: {
          callerUserId: "u-admin",
          callerTeamId: "team-sales",
          callerRole: "admin",
          callerCompanyId: "company-a",
          companyId: "company-a",
          kind: "personal_terminal",
          ownerUserId: "u-owner",
          teamId: "team-sales",
          status: "active",
          action: "exec",
        },
        rust: {
          action: "terminal_command",
          actor: { company_id: "company-a", user_id: "u-admin", team_id: "team-sales", role: "admin" },
          terminal_company_id: "company-a",
          terminal_owner_user_id: "u-owner",
          terminal_team_id: "team-sales",
          terminal_active: true,
          command: "ls -la",
          requires_approval: false,
          dangerous: false,
          terminal_kind: "personal_terminal",
          terminal_action: "exec",
          bot_actor: null,
        },
        expectedAllowed: false,
        expectedNodeReason: "personal_terminal_exec_denied",
        expectedRustReason: "personal_terminal_exec_denied",
      },
      {
        name: "denies company owner exec on another user's personal_terminal with personal_terminal_exec_denied",
        node: {
          callerUserId: "u-co-owner",
          callerTeamId: "team-sales",
          callerRole: "owner",
          callerCompanyId: "company-a",
          companyId: "company-a",
          kind: "personal_terminal",
          ownerUserId: "u-owner",
          teamId: "team-sales",
          status: "active",
          action: "exec",
        },
        rust: {
          action: "terminal_command",
          actor: { company_id: "company-a", user_id: "u-co-owner", team_id: "team-sales", role: "owner" },
          terminal_company_id: "company-a",
          terminal_owner_user_id: "u-owner",
          terminal_team_id: "team-sales",
          terminal_active: true,
          command: "whoami",
          requires_approval: false,
          dangerous: false,
          terminal_kind: "personal_terminal",
          terminal_action: "exec",
          bot_actor: null,
        },
        expectedAllowed: false,
        expectedNodeReason: "personal_terminal_exec_denied",
        expectedRustReason: "personal_terminal_exec_denied",
      },
      {
        name: "allows admin stop on another user's personal_terminal",
        node: {
          callerUserId: "u-admin",
          callerTeamId: "team-sales",
          callerRole: "admin",
          callerCompanyId: "company-a",
          companyId: "company-a",
          kind: "personal_terminal",
          ownerUserId: "u-owner",
          teamId: "team-sales",
          status: "active",
          action: "stop",
        },
        rust: {
          action: "terminal_command",
          actor: { company_id: "company-a", user_id: "u-admin", team_id: "team-sales", role: "admin" },
          terminal_company_id: "company-a",
          terminal_owner_user_id: "u-owner",
          terminal_team_id: "team-sales",
          terminal_active: true,
          command: "",
          requires_approval: false,
          dangerous: false,
          terminal_kind: "personal_terminal",
          terminal_action: "stop",
          bot_actor: null,
        },
        expectedAllowed: true,
        expectedNodeReason: "allowed",
        expectedRustReason: "terminal_command_allowed",
      },
      {
        name: "allows company owner revoke on another user's personal_terminal",
        node: {
          callerUserId: "u-co-owner",
          callerTeamId: "team-sales",
          callerRole: "owner",
          callerCompanyId: "company-a",
          companyId: "company-a",
          kind: "personal_terminal",
          ownerUserId: "u-owner",
          teamId: "team-sales",
          status: "active",
          action: "revoke",
        },
        rust: {
          action: "terminal_command",
          actor: { company_id: "company-a", user_id: "u-co-owner", team_id: "team-sales", role: "owner" },
          terminal_company_id: "company-a",
          terminal_owner_user_id: "u-owner",
          terminal_team_id: "team-sales",
          terminal_active: true,
          command: "",
          requires_approval: false,
          dangerous: false,
          terminal_kind: "personal_terminal",
          terminal_action: "revoke",
          bot_actor: null,
        },
        expectedAllowed: true,
        expectedNodeReason: "allowed",
        expectedRustReason: "terminal_command_allowed",
      },
      {
        name: "allows personal bot on owner's personal_terminal with explicitOwnerContext=true",
        node: {
          callerUserId: "u-service",
          callerTeamId: "team-sales",
          callerRole: "member",
          callerCompanyId: "company-a",
          companyId: "company-a",
          kind: "personal_terminal",
          ownerUserId: "u-owner",
          teamId: "team-sales",
          status: "active",
          action: "exec",
          botKind: "personal",
          botOwnerUserId: "u-owner",
          botTeamId: null,
          botApproved: false,
          botCompanyId: "company-a",
          explicitOwnerContext: true,
        },
        rust: {
          action: "terminal_command",
          actor: { company_id: "company-a", user_id: "u-service", team_id: "team-sales", role: "member" },
          terminal_company_id: "company-a",
          terminal_owner_user_id: "u-owner",
          terminal_team_id: "team-sales",
          terminal_active: true,
          command: "pwd",
          requires_approval: false,
          dangerous: false,
          terminal_kind: "personal_terminal",
          terminal_action: "exec",
          bot_actor: {
            bot_kind: "personal",
            bot_company_id: "company-a",
            bot_owner_user_id: "u-owner",
            bot_team_id: null,
            bot_approved: false,
            explicit_owner_context: true,
          },
        },
        expectedAllowed: true,
        expectedNodeReason: "allowed",
        expectedRustReason: "terminal_command_allowed",
      },
      {
        name: "denies personal bot on owner's personal_terminal when explicitOwnerContext=false",
        node: {
          callerUserId: "u-service",
          callerTeamId: "team-sales",
          callerRole: "member",
          callerCompanyId: "company-a",
          companyId: "company-a",
          kind: "personal_terminal",
          ownerUserId: "u-owner",
          teamId: "team-sales",
          status: "active",
          action: "exec",
          botKind: "personal",
          botOwnerUserId: "u-owner",
          botTeamId: null,
          botApproved: false,
          botCompanyId: "company-a",
          explicitOwnerContext: false,
        },
        rust: {
          action: "terminal_command",
          actor: { company_id: "company-a", user_id: "u-service", team_id: "team-sales", role: "member" },
          terminal_company_id: "company-a",
          terminal_owner_user_id: "u-owner",
          terminal_team_id: "team-sales",
          terminal_active: true,
          command: "pwd",
          requires_approval: false,
          dangerous: false,
          terminal_kind: "personal_terminal",
          terminal_action: "exec",
          bot_actor: {
            bot_kind: "personal",
            bot_company_id: "company-a",
            bot_owner_user_id: "u-owner",
            bot_team_id: null,
            bot_approved: false,
            explicit_owner_context: false,
          },
        },
        expectedAllowed: false,
        expectedNodeReason: "personal_terminal_access_denied",
        expectedRustReason: "personal_terminal_access_denied",
      },
      {
        name: "denies viewer on worker_node with worker_node_viewer_denied",
        node: {
          callerUserId: "u-viewer",
          callerTeamId: "team-sales",
          callerRole: "viewer",
          callerCompanyId: "company-a",
          companyId: "company-a",
          kind: "worker_node",
          ownerUserId: null,
          teamId: "team-sales",
          status: "active",
          action: "exec",
        },
        rust: {
          action: "terminal_command",
          actor: { company_id: "company-a", user_id: "u-viewer", team_id: "team-sales", role: "viewer" },
          terminal_company_id: "company-a",
          terminal_owner_user_id: "u-owner",
          terminal_team_id: "team-sales",
          terminal_active: true,
          command: "uname -a",
          requires_approval: false,
          dangerous: false,
          terminal_kind: "worker_node",
          terminal_action: "exec",
          bot_actor: null,
        },
        expectedAllowed: false,
        expectedNodeReason: "worker_node_viewer_denied",
        expectedRustReason: "worker_node_viewer_denied",
      },
      {
        name: "allows same-team member on worker_node",
        node: {
          callerUserId: "u-member",
          callerTeamId: "team-sales",
          callerRole: "member",
          callerCompanyId: "company-a",
          companyId: "company-a",
          kind: "worker_node",
          ownerUserId: null,
          teamId: "team-sales",
          status: "active",
          action: "exec",
        },
        rust: {
          action: "terminal_command",
          actor: { company_id: "company-a", user_id: "u-member", team_id: "team-sales", role: "member" },
          terminal_company_id: "company-a",
          terminal_owner_user_id: "u-owner",
          terminal_team_id: "team-sales",
          terminal_active: true,
          command: "uname -a",
          requires_approval: false,
          dangerous: false,
          terminal_kind: "worker_node",
          terminal_action: "exec",
          bot_actor: null,
        },
        expectedAllowed: true,
        expectedNodeReason: "allowed",
        expectedRustReason: "terminal_command_allowed",
      },
      {
        name: "denies cross-team member on worker_node with worker_node_access_denied",
        node: {
          callerUserId: "u-hr",
          callerTeamId: "team-hr",
          callerRole: "member",
          callerCompanyId: "company-a",
          companyId: "company-a",
          kind: "worker_node",
          ownerUserId: null,
          teamId: "team-sales",
          status: "active",
          action: "exec",
        },
        rust: {
          action: "terminal_command",
          actor: { company_id: "company-a", user_id: "u-hr", team_id: "team-hr", role: "member" },
          terminal_company_id: "company-a",
          terminal_owner_user_id: "u-owner",
          terminal_team_id: "team-sales",
          terminal_active: true,
          command: "uname -a",
          requires_approval: false,
          dangerous: false,
          terminal_kind: "worker_node",
          terminal_action: "exec",
          bot_actor: null,
        },
        expectedAllowed: false,
        expectedNodeReason: "worker_node_access_denied",
        expectedRustReason: "worker_node_access_denied",
      },
      {
        name: "allows approved same-team bot on worker_node",
        node: {
          callerUserId: "u-service",
          callerTeamId: "team-other",
          callerRole: "member",
          callerCompanyId: "company-a",
          companyId: "company-a",
          kind: "worker_node",
          ownerUserId: null,
          teamId: "team-sales",
          status: "active",
          action: "exec",
          botKind: "team",
          botOwnerUserId: null,
          botTeamId: "team-sales",
          botApproved: true,
          botCompanyId: "company-a",
          explicitOwnerContext: false,
        },
        rust: {
          action: "terminal_command",
          actor: { company_id: "company-a", user_id: "u-service", team_id: "team-other", role: "member" },
          terminal_company_id: "company-a",
          terminal_owner_user_id: "u-owner",
          terminal_team_id: "team-sales",
          terminal_active: true,
          command: "uname -a",
          requires_approval: false,
          dangerous: false,
          terminal_kind: "worker_node",
          terminal_action: "exec",
          bot_actor: {
            bot_kind: "team",
            bot_company_id: "company-a",
            bot_owner_user_id: null,
            bot_team_id: "team-sales",
            bot_approved: true,
            explicit_owner_context: false,
          },
        },
        expectedAllowed: true,
        expectedNodeReason: "allowed",
        expectedRustReason: "terminal_command_allowed",
      },
      {
        name: "denies cross-company terminal command",
        node: {
          callerUserId: "u-owner",
          callerTeamId: "team-sales",
          callerRole: "owner",
          callerCompanyId: "company-b",
          companyId: "company-a",
          kind: "worker_node",
          ownerUserId: null,
          teamId: "team-sales",
          status: "active",
          action: "exec",
        },
        rust: {
          action: "terminal_command",
          actor: { company_id: "company-b", user_id: "u-owner", team_id: "team-sales", role: "owner" },
          terminal_company_id: "company-a",
          terminal_owner_user_id: "u-owner",
          terminal_team_id: "team-sales",
          terminal_active: true,
          command: "uname -a",
          requires_approval: false,
          dangerous: false,
          terminal_kind: "worker_node",
          terminal_action: "exec",
          bot_actor: null,
        },
        expectedAllowed: false,
        expectedNodeReason: "cross_company_denied",
        expectedRustReason: "company_mismatch",
      },
      {
        name: "denies command on inactive or revoked terminal",
        node: {
          callerUserId: "u-owner",
          callerTeamId: "team-sales",
          callerRole: "owner",
          callerCompanyId: "company-a",
          companyId: "company-a",
          kind: "worker_node",
          ownerUserId: null,
          teamId: "team-sales",
          status: "revoked",
          action: "exec",
        },
        rust: {
          action: "terminal_command",
          actor: { company_id: "company-a", user_id: "u-owner", team_id: "team-sales", role: "owner" },
          terminal_company_id: "company-a",
          terminal_owner_user_id: "u-owner",
          terminal_team_id: "team-sales",
          terminal_active: false,
          command: "uname -a",
          requires_approval: false,
          dangerous: false,
          terminal_kind: "worker_node",
          terminal_action: "exec",
          bot_actor: null,
        },
        expectedAllowed: false,
        expectedNodeReason: "terminal_revoked",
        expectedRustReason: "terminal_inactive",
      },
    ];

    for (const v of terminalVectors) {
      it(v.name, () => {
        const nodeDecision = evaluateTerminalCommand(v.node);
        const rustDecision = evalRustPolicy(v.rust);
        assertAllowedParity(nodeDecision, rustDecision, {
          expectedAllowed: v.expectedAllowed,
          expectedNodeReason: v.expectedNodeReason,
          expectedRustReason: v.expectedRustReason,
          expectedRequiresApproval: false,
        });
      });
    }
  });

  describe("evaluateChannelInvoke <-> action: channel_invoke", () => {
    const channelVectors: Array<{
      name: string;
      node: ChannelInvokeInput;
      rust: Record<string, unknown>;
      expectedAllowed: boolean;
      expectedNodeReason: string;
      expectedRustReason: string;
      expectedRequiresOwnerApproval: boolean;
      expectedRustRequiresApproval: boolean;
    }> = [
      {
        name: "allows same-team channel invocation of team bot",
        node: {
          callerUserId: "u-sales",
          callerTeamId: "team-sales",
          callerRole: "member",
          callerCompanyId: "company-a",
          channelCompanyId: "company-a",
          channelMemberIds: ["u-sales", "bot-sales"],
          botId: "bot-sales",
          botCompanyId: "company-a",
          botKind: "team",
          botOwnerUserId: "u-lead",
          botTeamId: "team-sales",
          executionTarget: "worker_node",
          ownerApproved: false,
          requestsCrossTeamSecrets: false,
        },
        rust: {
          action: "channel_invoke",
          actor: { company_id: "company-a", user_id: "u-sales", team_id: "team-sales", role: "member" },
          bot: {
            bot_id: "bot-sales",
            company_id: "company-a",
            owner_user_id: "u-lead",
            team_id: "team-sales",
            kind: "team",
            callable_by: "team",
            data_scope: "team",
            status: "active",
            requires_approval: false,
          },
          channel_company_id: "company-a",
          channel_team_id: "team-sales",
          requires_approval: false,
          channel_member_ids: ["u-sales", "bot-sales"],
          execution_target: "worker_node",
          owner_approved: false,
          requests_cross_team_secrets: false,
        },
        expectedAllowed: true,
        expectedNodeReason: "allowed",
        expectedRustReason: "channel_invoke_allowed",
        expectedRequiresOwnerApproval: false,
        expectedRustRequiresApproval: false,
      },
      {
        name: "denies cross-team secrets with cross_team_secrets_denied",
        node: {
          callerUserId: "u-owner",
          callerTeamId: "team-sales",
          callerRole: "owner",
          callerCompanyId: "company-a",
          channelCompanyId: "company-a",
          channelMemberIds: ["u-owner", "bot-personal"],
          botId: "bot-personal",
          botCompanyId: "company-a",
          botKind: "personal",
          botOwnerUserId: "u-owner",
          botTeamId: "team-sales",
          executionTarget: "personal_terminal",
          ownerApproved: true,
          requestsCrossTeamSecrets: true,
        },
        rust: {
          action: "channel_invoke",
          actor: { company_id: "company-a", user_id: "u-owner", team_id: "team-sales", role: "owner" },
          bot: {
            bot_id: "bot-personal",
            company_id: "company-a",
            owner_user_id: "u-owner",
            team_id: "team-sales",
            kind: "personal",
            callable_by: "self_only",
            data_scope: "self",
            status: "active",
            requires_approval: false,
          },
          channel_company_id: "company-a",
          channel_team_id: "team-sales",
          requires_approval: false,
          channel_member_ids: ["u-owner", "bot-personal"],
          execution_target: "personal_terminal",
          owner_approved: true,
          requests_cross_team_secrets: true,
        },
        expectedAllowed: false,
        expectedNodeReason: "cross_team_secrets_denied",
        expectedRustReason: "cross_team_secrets_denied",
        expectedRequiresOwnerApproval: false,
        expectedRustRequiresApproval: false,
      },
      {
        name: "requires owner approval for delegated personal_terminal invocation when ownerApproved=false",
        node: {
          callerUserId: "u-caller",
          callerTeamId: "team-sales",
          callerRole: "member",
          callerCompanyId: "company-a",
          channelCompanyId: "company-a",
          channelMemberIds: ["u-caller", "bot-personal"],
          botId: "bot-personal",
          botCompanyId: "company-a",
          botKind: "personal",
          botOwnerUserId: "u-owner",
          botTeamId: "team-sales",
          executionTarget: "personal_terminal",
          ownerApproved: false,
          requestsCrossTeamSecrets: false,
        },
        rust: {
          action: "channel_invoke",
          actor: { company_id: "company-a", user_id: "u-caller", team_id: "team-sales", role: "member" },
          bot: {
            bot_id: "bot-personal",
            company_id: "company-a",
            owner_user_id: "u-owner",
            team_id: "team-sales",
            kind: "personal",
            callable_by: "self_only",
            data_scope: "self",
            status: "active",
            requires_approval: false,
          },
          channel_company_id: "company-a",
          channel_team_id: "team-sales",
          requires_approval: false,
          channel_member_ids: ["u-caller", "bot-personal"],
          execution_target: "personal_terminal",
          owner_approved: false,
          requests_cross_team_secrets: false,
        },
        expectedAllowed: false,
        expectedNodeReason: "personal_terminal_requires_owner_approval",
        expectedRustReason: "personal_terminal_requires_owner_approval",
        expectedRequiresOwnerApproval: true,
        expectedRustRequiresApproval: true,
      },
      {
        name: "allows delegated personal_terminal invocation when ownerApproved=true",
        node: {
          callerUserId: "u-caller",
          callerTeamId: "team-sales",
          callerRole: "member",
          callerCompanyId: "company-a",
          channelCompanyId: "company-a",
          channelMemberIds: ["u-caller", "bot-personal"],
          botId: "bot-personal",
          botCompanyId: "company-a",
          botKind: "personal",
          botOwnerUserId: "u-owner",
          botTeamId: "team-sales",
          executionTarget: "personal_terminal",
          ownerApproved: true,
          requestsCrossTeamSecrets: false,
        },
        rust: {
          action: "channel_invoke",
          actor: { company_id: "company-a", user_id: "u-caller", team_id: "team-sales", role: "member" },
          bot: {
            bot_id: "bot-personal",
            company_id: "company-a",
            owner_user_id: "u-owner",
            team_id: "team-sales",
            kind: "personal",
            callable_by: "self_only",
            data_scope: "self",
            status: "active",
            requires_approval: false,
          },
          channel_company_id: "company-a",
          channel_team_id: "team-sales",
          requires_approval: false,
          channel_member_ids: ["u-caller", "bot-personal"],
          execution_target: "personal_terminal",
          owner_approved: true,
          requests_cross_team_secrets: false,
        },
        expectedAllowed: true,
        expectedNodeReason: "allowed",
        expectedRustReason: "channel_invoke_allowed",
        expectedRequiresOwnerApproval: false,
        expectedRustRequiresApproval: false,
      },
      {
        name: "denies caller not in channel_member_ids with caller_not_channel_member",
        node: {
          callerUserId: "u-outsider",
          callerTeamId: "team-sales",
          callerRole: "member",
          callerCompanyId: "company-a",
          channelCompanyId: "company-a",
          channelMemberIds: ["u-owner", "bot-personal"],
          botId: "bot-personal",
          botCompanyId: "company-a",
          botKind: "personal",
          botOwnerUserId: "u-owner",
          botTeamId: "team-sales",
          executionTarget: "personal_terminal",
          ownerApproved: true,
          requestsCrossTeamSecrets: false,
        },
        rust: {
          action: "channel_invoke",
          actor: { company_id: "company-a", user_id: "u-outsider", team_id: "team-sales", role: "member" },
          bot: {
            bot_id: "bot-personal",
            company_id: "company-a",
            owner_user_id: "u-owner",
            team_id: "team-sales",
            kind: "personal",
            callable_by: "self_only",
            data_scope: "self",
            status: "active",
            requires_approval: false,
          },
          channel_company_id: "company-a",
          channel_team_id: "team-sales",
          requires_approval: false,
          channel_member_ids: ["u-owner", "bot-personal"],
          execution_target: "personal_terminal",
          owner_approved: true,
          requests_cross_team_secrets: false,
        },
        expectedAllowed: false,
        expectedNodeReason: "caller_not_channel_member",
        expectedRustReason: "caller_not_channel_member",
        expectedRequiresOwnerApproval: false,
        expectedRustRequiresApproval: false,
      },
      {
        name: "denies bot not in channel_member_ids with bot_not_channel_member",
        node: {
          callerUserId: "u-owner",
          callerTeamId: "team-sales",
          callerRole: "member",
          callerCompanyId: "company-a",
          channelCompanyId: "company-a",
          channelMemberIds: ["u-owner"],
          botId: "bot-personal",
          botCompanyId: "company-a",
          botKind: "personal",
          botOwnerUserId: "u-owner",
          botTeamId: "team-sales",
          executionTarget: "personal_terminal",
          ownerApproved: true,
          requestsCrossTeamSecrets: false,
        },
        rust: {
          action: "channel_invoke",
          actor: { company_id: "company-a", user_id: "u-owner", team_id: "team-sales", role: "member" },
          bot: {
            bot_id: "bot-personal",
            company_id: "company-a",
            owner_user_id: "u-owner",
            team_id: "team-sales",
            kind: "personal",
            callable_by: "self_only",
            data_scope: "self",
            status: "active",
            requires_approval: false,
          },
          channel_company_id: "company-a",
          channel_team_id: "team-sales",
          requires_approval: false,
          channel_member_ids: ["u-owner"],
          execution_target: "personal_terminal",
          owner_approved: true,
          requests_cross_team_secrets: false,
        },
        expectedAllowed: false,
        expectedNodeReason: "bot_not_channel_member",
        expectedRustReason: "bot_not_channel_member",
        expectedRequiresOwnerApproval: false,
        expectedRustRequiresApproval: false,
      },
      {
        name: "denies cross-company channel invocation",
        node: {
          callerUserId: "u-sales",
          callerTeamId: "team-sales",
          callerRole: "member",
          callerCompanyId: "company-b",
          channelCompanyId: "company-a",
          channelMemberIds: ["u-sales", "bot-sales"],
          botId: "bot-sales",
          botCompanyId: "company-a",
          botKind: "team",
          botOwnerUserId: "u-lead",
          botTeamId: "team-sales",
          executionTarget: "worker_node",
          ownerApproved: false,
          requestsCrossTeamSecrets: false,
        },
        rust: {
          action: "channel_invoke",
          actor: { company_id: "company-b", user_id: "u-sales", team_id: "team-sales", role: "member" },
          bot: {
            bot_id: "bot-sales",
            company_id: "company-a",
            owner_user_id: "u-lead",
            team_id: "team-sales",
            kind: "team",
            callable_by: "team",
            data_scope: "team",
            status: "active",
            requires_approval: false,
          },
          channel_company_id: "company-a",
          channel_team_id: "team-sales",
          requires_approval: false,
          channel_member_ids: ["u-sales", "bot-sales"],
          execution_target: "worker_node",
          owner_approved: false,
          requests_cross_team_secrets: false,
        },
        expectedAllowed: false,
        expectedNodeReason: "cross_company_denied",
        expectedRustReason: "company_mismatch",
        expectedRequiresOwnerApproval: false,
        expectedRustRequiresApproval: false,
      },
    ];

    for (const v of channelVectors) {
      it(v.name, () => {
        const nodeDecision = evaluateChannelInvoke(v.node);
        const rustDecision = evalRustPolicy(v.rust);
        assertAllowedParity(nodeDecision, rustDecision, {
          expectedAllowed: v.expectedAllowed,
          expectedNodeReason: v.expectedNodeReason,
          expectedRustReason: v.expectedRustReason,
          expectedRequiresApproval: v.expectedRustRequiresApproval,
        });
        expect(nodeDecision.requiresOwnerApproval).toBe(v.expectedRequiresOwnerApproval);
        expect(nodeDecision.crossTeamSecretsAllowed).toBe(false);
      });
    }
  });
});
