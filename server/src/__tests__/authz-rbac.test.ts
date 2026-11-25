import type { Request } from "express";
import { describe, expect, it } from "vitest";
import { HttpError } from "../errors.js";
import {
  TEAM_ROLES,
  assertBoard,
  assertCompanyAccess,
  canManageTeamRole,
  getActorInfo,
  hasMinimumTeamRole,
  type TeamRole,
} from "../routes/authz.js";

type Actor = Request["actor"];

function requestWithActor(actor: Actor): Request {
  return { actor } as Request;
}

function expectHttpError(fn: () => unknown, status: number, message: string) {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(HttpError);
  expect(caught).toMatchObject({ status, message });
}

describe("assertBoard", () => {
  it("allows board actors", () => {
    expect(() => assertBoard(requestWithActor({ type: "board" }))).not.toThrow();
  });

  it("rejects agent actors as forbidden", () => {
    expectHttpError(
      () => assertBoard(requestWithActor({ type: "agent", companyId: "company-1", agentId: "agent-1" })),
      403,
      "Board access required",
    );
  });

  it("rejects unauthenticated actors with the existing forbidden behavior", () => {
    expectHttpError(
      () => assertBoard(requestWithActor({ type: "none" })),
      403,
      "Board access required",
    );
  });
});

describe("assertCompanyAccess", () => {
  it("rejects unauthenticated actors as unauthorized", () => {
    expectHttpError(
      () => assertCompanyAccess(requestWithActor({ type: "none" }), "company-1"),
      401,
      "Unauthorized",
    );
  });

  it("allows an agent key in the same company", () => {
    expect(() => assertCompanyAccess(
      requestWithActor({ type: "agent", companyId: "company-1", agentId: "agent-1" }),
      "company-1",
    )).not.toThrow();
  });

  it("rejects an agent key from another company", () => {
    expectHttpError(
      () => assertCompanyAccess(
        requestWithActor({ type: "agent", companyId: "company-2", agentId: "agent-1" }),
        "company-1",
      ),
      403,
      "Agent key cannot access another company",
    );
  });

  it("rejects an agent key without a company binding when company access is required", () => {
    expectHttpError(
      () => assertCompanyAccess(requestWithActor({ type: "agent", agentId: "agent-1" }), "company-1"),
      403,
      "Agent key cannot access another company",
    );
  });

  it("allows a local implicit board actor without company membership data", () => {
    expect(() => assertCompanyAccess(
      requestWithActor({ type: "board", source: "local_implicit" }),
      "company-1",
    )).not.toThrow();
  });

  it("allows an instance admin board actor across companies", () => {
    expect(() => assertCompanyAccess(
      requestWithActor({ type: "board", source: "session", userId: "user-1", isInstanceAdmin: true }),
      "company-1",
    )).not.toThrow();
  });

  it("allows a non-admin board actor whose active companies include the company", () => {
    expect(() => assertCompanyAccess(
      requestWithActor({
        type: "board",
        source: "session",
        userId: "user-1",
        companyIds: ["company-1", "company-2"],
      }),
      "company-1",
    )).not.toThrow();
  });

  it("rejects a non-admin board actor outside the company", () => {
    expectHttpError(
      () => assertCompanyAccess(
        requestWithActor({ type: "board", source: "session", userId: "user-1", companyIds: ["company-2"] }),
        "company-1",
      ),
      403,
      "User does not have access to this company",
    );
  });

  it("rejects a non-admin board actor with no company membership data", () => {
    expectHttpError(
      () => assertCompanyAccess(
        requestWithActor({ type: "board", source: "board_key", userId: "user-1" }),
        "company-1",
      ),
      403,
      "User does not have access to this company",
    );
  });
});

describe("getActorInfo", () => {
  it("rejects unauthenticated actors as unauthorized", () => {
    expectHttpError(
      () => getActorInfo(requestWithActor({ type: "none" })),
      401,
      "Unauthorized",
    );
  });

  it("returns the agent actor identity and run id", () => {
    expect(getActorInfo(requestWithActor({
      type: "agent",
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
    }))).toEqual({
      actorType: "agent",
      actorId: "agent-1",
      agentId: "agent-1",
      runId: "run-1",
    });
  });

  it("keeps the existing unknown-agent fallback for incomplete agent actors", () => {
    expect(getActorInfo(requestWithActor({ type: "agent" }))).toEqual({
      actorType: "agent",
      actorId: "unknown-agent",
      agentId: null,
      runId: null,
    });
  });

  it("returns the board user identity", () => {
    expect(getActorInfo(requestWithActor({
      type: "board",
      source: "session",
      userId: "user-1",
      runId: "run-1",
    }))).toEqual({
      actorType: "user",
      actorId: "user-1",
      agentId: null,
      runId: "run-1",
    });
  });

  it("keeps the existing board fallback for board actors without a user id", () => {
    expect(getActorInfo(requestWithActor({ type: "board", source: "local_implicit" }))).toEqual({
      actorType: "user",
      actorId: "board",
      agentId: null,
      runId: null,
    });
  });
});

describe("team RBAC role hierarchy", () => {
  const minimumRoleMatrix: Record<TeamRole, Record<TeamRole, boolean>> = {
    owner: { owner: true, admin: true, member: true, viewer: true },
    admin: { owner: false, admin: true, member: true, viewer: true },
    member: { owner: false, admin: false, member: true, viewer: true },
    viewer: { owner: false, admin: false, member: false, viewer: true },
  };
  const minimumRoleCases = TEAM_ROLES.flatMap((actual) =>
    TEAM_ROLES.map((required) => ({
      actual,
      required,
      expected: minimumRoleMatrix[actual][required],
    })),
  );

  const manageRoleMatrix: Record<TeamRole, Record<TeamRole, boolean>> = {
    owner: { owner: true, admin: true, member: true, viewer: true },
    admin: { owner: false, admin: false, member: true, viewer: true },
    member: { owner: false, admin: false, member: false, viewer: false },
    viewer: { owner: false, admin: false, member: false, viewer: false },
  };
  const manageRoleCases = TEAM_ROLES.flatMap((actorRole) =>
    TEAM_ROLES.map((targetRole) => ({
      actorRole,
      targetRole,
      expected: manageRoleMatrix[actorRole][targetRole],
    })),
  );

  it("exposes the canonical role order", () => {
    expect(TEAM_ROLES).toEqual(["owner", "admin", "member", "viewer"]);
  });

  it.each(minimumRoleCases)("hasMinimumTeamRole($actual, $required) is $expected", ({ actual, required, expected }) => {
    expect(hasMinimumTeamRole(actual, required)).toBe(expected);
  });

  it.each(manageRoleCases)("canManageTeamRole($actorRole, $targetRole) is $expected", ({ actorRole, targetRole, expected }) => {
    expect(canManageTeamRole(actorRole, targetRole)).toBe(expected);
  });

  it("fails closed for unknown, malformed, or miscapitalized roles", () => {
    const invalidRoles: unknown[] = [undefined, null, "", "Owner", "owner ", "superadmin", 0, 1, {}, []];

    for (const invalidRole of invalidRoles) {
      expect(hasMinimumTeamRole(invalidRole, "viewer")).toBe(false);
      expect(hasMinimumTeamRole("owner", invalidRole)).toBe(false);
      expect(canManageTeamRole(invalidRole, "member")).toBe(false);
      expect(canManageTeamRole("owner", invalidRole)).toBe(false);
    }
  });
});
