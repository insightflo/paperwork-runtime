import type { Request } from "express";
import { forbidden, unauthorized } from "../errors.js";

export const TEAM_ROLES = ["owner", "admin", "member", "viewer"] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];

const TEAM_ROLE_RANKS: Record<TeamRole, number> = {
  owner: 0,
  admin: 1,
  member: 2,
  viewer: 3,
};

function isTeamRole(role: unknown): role is TeamRole {
  return typeof role === "string" && (TEAM_ROLES as readonly string[]).includes(role);
}

export function hasMinimumTeamRole(actual: unknown, required: unknown) {
  if (!isTeamRole(actual) || !isTeamRole(required)) {
    return false;
  }
  return TEAM_ROLE_RANKS[actual] <= TEAM_ROLE_RANKS[required];
}

export function canManageTeamRole(actorRole: unknown, targetRole: unknown) {
  if (!isTeamRole(actorRole) || !isTeamRole(targetRole)) {
    return false;
  }
  if (actorRole === "owner") {
    return true;
  }
  if (actorRole === "admin") {
    return targetRole === "member" || targetRole === "viewer";
  }
  return false;
}

export function assertBoard(req: Request) {
  if (req.actor.type !== "board") {
    throw forbidden("Board access required");
  }
}

export function assertCompanyAccess(req: Request, companyId: string) {
  if (req.actor.type === "none") {
    throw unauthorized();
  }
  if (req.actor.type === "agent" && req.actor.companyId !== companyId) {
    throw forbidden("Agent key cannot access another company");
  }
  if (req.actor.type === "board" && req.actor.source !== "local_implicit" && !req.actor.isInstanceAdmin) {
    const allowedCompanies = req.actor.companyIds ?? [];
    if (!allowedCompanies.includes(companyId)) {
      throw forbidden("User does not have access to this company");
    }
  }
}

export function getActorInfo(req: Request) {
  if (req.actor.type === "none") {
    throw unauthorized();
  }
  if (req.actor.type === "agent") {
    return {
      actorType: "agent" as const,
      actorId: req.actor.agentId ?? "unknown-agent",
      agentId: req.actor.agentId ?? null,
      runId: req.actor.runId ?? null,
    };
  }

  return {
    actorType: "user" as const,
    actorId: req.actor.userId ?? "board",
    agentId: null,
    runId: req.actor.runId ?? null,
  };
}
