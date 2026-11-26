import type { Request } from "express";
import { forbidden } from "../errors.js";
import { assertCompanyAccess, hasMinimumTeamRole } from "./authz.js";

export interface CompanyWriteAccessChecker {
  getMembership: (
    companyId: string,
    principalType: "user" | "agent",
    principalId: string,
  ) => Promise<{ status: string; membershipRole: string | null } | null>;
}

/**
 * Enforces company-level write access:
 * - Agents with access to the company are allowed (preserving agent workflows).
 * - `local_implicit` and `isInstanceAdmin` board actors are allowed.
 * - Other board users must have an active company membership with role >= `member`
 *   (blocks `viewer` users with 403).
 */
export async function assertCompanyWriteAccess(
  access: CompanyWriteAccessChecker,
  req: Request,
  companyId: string,
) {
  assertCompanyAccess(req, companyId);
  if (req.actor.type === "agent") {
    return;
  }
  if (req.actor.type === "board" && (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin)) {
    return;
  }
  const userId = req.actor.type === "board" ? req.actor.userId : undefined;
  if (!userId) {
    throw forbidden("Company member access required");
  }
  const membership = await access.getMembership(companyId, "user", userId);
  if (
    membership &&
    membership.status === "active" &&
    hasMinimumTeamRole(membership.membershipRole, "member")
  ) {
    return;
  }
  throw forbidden("Company member access required");
}
