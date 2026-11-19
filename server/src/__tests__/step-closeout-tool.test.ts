import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { issueComments, issues, type Db } from "@paperclipai/db";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { completeLinkedWorkflowStepRunsForIssue } from "../services/workflow/issue-step-closeout.js";
import { executeStepCloseoutTool } from "../services/workflow/step-closeout-tool.js";

vi.mock("../services/workflow/issue-step-closeout.js", () => ({
  completeLinkedWorkflowStepRunsForIssue: vi.fn(),
}));
const complete = vi.mocked(completeLinkedWorkflowStepRunsForIssue);

function mockDb(issue: { assigneeAgentId: string | null } | null = { assigneeAgentId: "agent" }) {
  const lock = vi.fn().mockResolvedValue(issue ? [issue] : []);
  const selectWhere = vi.fn().mockReturnValue({ limit: () => ({ for: lock }) });
  const updateWhere = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn().mockReturnValue({ where: updateWhere });
  const values = vi.fn().mockReturnValue({ returning: async () => [{ id: "comment" }] });
  const tx = {
    select: vi.fn().mockReturnValue({ from: () => ({ where: selectWhere }) }),
    insert: vi.fn().mockReturnValue({ values }),
    update: vi.fn().mockReturnValue({ set }),
  };
  const transaction = vi.fn(async (callback: (db: typeof tx) => Promise<unknown>) => callback(tx));
  return { db: { transaction } as unknown as Db, transaction, tx, lock, selectWhere, updateWhere, set, values };
}

const identity = { companyId: "company", agentId: "agent", heartbeatRunId: "heartbeat", issueId: "issue", toolName: "step-closeout" };

beforeEach(() => complete.mockReset().mockResolvedValue(["step"]));

function expectNoWrites(mock: ReturnType<typeof mockDb>) {
  expect(mock.tx.insert).not.toHaveBeenCalled();
  expect(mock.tx.update).not.toHaveBeenCalled();
  expect(complete).not.toHaveBeenCalled();
}

describe("step-closeout", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), "step-closeout-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it.each(["agentId", "heartbeatRunId"] as const)("requires authenticated %s", async (key) => {
    const mock = mockDb();
    expect(await executeStepCloseoutTool({ ...identity, db: mock.db, [key]: undefined, parameters: identity }))
      .toMatchObject({ status: 403, body: { error: "step_closeout_identity_required", tool: identity.toolName, source: "core" } });
    expect(mock.transaction).not.toHaveBeenCalled();
    expectNoWrites(mock);
  });

  it.each([
    [{ status: "blocked" }, "invalid_step_closeout_request"],
    [{ issueId: "  " }, "invalid_step_closeout_request"],
    [{ comment: "x".repeat(32_001) }, "invalid_step_closeout_request"],
    [{ artifactPaths: Array(17).fill("/absolute") }, "invalid_step_closeout_request"],
    [{ artifactPaths: ["relative.txt"] }, "step_closeout_artifact_invalid"],
    [{}, "step_closeout_issue_required"],
  ])("rejects invalid requests before opening a transaction (%#)", async (parameters, error) => {
    const mock = mockDb();
    expect(await executeStepCloseoutTool({ ...identity, db: mock.db, issueId: undefined, parameters }))
      .toMatchObject({ status: 422, body: { error } });
    expect(mock.transaction).not.toHaveBeenCalled();
    expectNoWrites(mock);
  });

  it.each(["missing", "empty", "directory"])("rejects a %s artifact without writes", async (kind) => {
    const mock = mockDb();
    const validFile = path.join(dir, "valid");
    await writeFile(validFile, "evidence");
    const invalidFile = kind === "directory" ? dir : path.join(dir, kind);
    if (kind === "empty") await writeFile(invalidFile, "");
    expect(await executeStepCloseoutTool({ ...identity, db: mock.db, parameters: { artifactPaths: [validFile, invalidFile], comment: "not saved" } }))
      .toMatchObject({ status: 422, body: { error: "step_closeout_artifact_invalid" } });
    expect(mock.transaction).not.toHaveBeenCalled();
    expectNoWrites(mock);
  });

  it.each([
    [null, 404, "issue_not_found"],
    [{ assigneeAgentId: "other" }, 403, "issue_assignee_mismatch"],
  ] as const)("rejects unavailable issues (%#)", async (issue, status, error) => {
    const mock = mockDb(issue);
    expect(await executeStepCloseoutTool({ ...identity, db: mock.db, parameters: { comment: "not saved" } }))
      .toMatchObject({ status, body: { error } });
    expectNoWrites(mock);
  });

  it("verifies a real artifact and performs all closeout writes in one transaction", async () => {
    const mock = mockDb();
    const artifact = path.join(dir, "artifact.txt");
    await writeFile(artifact, "result");
    const result = { issueId: "selected", status: "done", commentId: "comment", verifiedArtifacts: [{ path: artifact, sizeBytes: 6 }], completedStepRunIds: ["step"] };
    expect(await executeStepCloseoutTool({ ...identity, db: mock.db, parameters: {
      issueId: " selected ", comment: " finished ", artifactPaths: [artifact],
      agentId: "ignored", companyId: "ignored", heartbeatRunId: "ignored",
    } })).toEqual({ status: 200, body: { content: JSON.stringify(result), data: result, tool: identity.toolName, source: "core" } });
    expect(mock.transaction).toHaveBeenCalledTimes(1);
    expect(mock.lock).toHaveBeenCalledWith("update");
    const scope = mock.selectWhere.mock.calls[0][0];
    expect(new PgDialect().sqlToQuery(scope)).toMatchObject({
      sql: '("issues"."id" = $1 and "issues"."company_id" = $2)', params: ["selected", "company"],
    });
    expect(mock.updateWhere).toHaveBeenCalledWith(scope);
    expect(mock.tx.insert).toHaveBeenCalledWith(issueComments);
    expect(mock.values).toHaveBeenCalledWith({ companyId: "company", issueId: "selected", authorAgentId: "agent", body: "finished" });
    expect(mock.tx.update).toHaveBeenCalledWith(issues);
    const { updatedAt } = mock.set.mock.calls[0][0];
    expect(mock.set).toHaveBeenCalledWith({ status: "done", updatedAt: expect.any(Date), completedAt: updatedAt });
    expect(complete).toHaveBeenCalledExactlyOnceWith({ db: mock.tx, issueId: "selected", completedAt: updatedAt, source: "workflow_issue_closeout", heartbeatRunId: "heartbeat" });
  });

  it("moves an unassigned issue to review without completing linked steps", async () => {
    const mock = mockDb({ assigneeAgentId: null });
    expect(await executeStepCloseoutTool({ ...identity, db: mock.db, issueId: " issue ", parameters: { status: "in_review" } }))
      .toMatchObject({ status: 200, body: { data: { issueId: "issue", status: "in_review", commentId: null, verifiedArtifacts: [], completedStepRunIds: [] } } });
    expect(mock.set).toHaveBeenCalledWith({ status: "in_review", updatedAt: expect.any(Date) });
    expect(mock.tx.insert).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });
});
