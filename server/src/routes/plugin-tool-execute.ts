import { randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import type { ToolRunContext } from "@paperclipai/plugin-sdk";
import {
  claimToolExecutionReceipt,
  IDEMPOTENCY_KEY_MAX_LENGTH,
  normalizeIdempotencyKey,
} from "../services/plugin-tool-execution-receipt.js";
import { finalizeHttpCoreResponse, isPositiveHttpDeferral } from "../services/http-core-response-finalization.js";
import type { RuntimeExecutionIdentity, RuntimeExecutionLifecycle } from "../services/runtime-execution-lifecycle.js";
import type { createHttpHandlerLifetime } from "../services/http-handler-lifetime.js";
import type { PluginToolDispatcher } from "../services/plugin-tool-dispatcher.js";
import { createPluginToolHttpConsumer } from "../services/plugin-tool-http-consumer.js";
import { executePluginCoreToolCall } from "../services/workflow/plugin-core-tool-call.js";
import { listWorkflowToolCatalog } from "../services/workflow/tool-catalog.js";
import { authorizeRunToolExecution } from "../services/workflow/plugin-tool-authorization.js";
import { resolveRunStepEnv } from "../services/workflow/core-tool-executor.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
export interface PluginRouteToolDeps { toolDispatcher: PluginToolDispatcher }

export interface PluginRouteRuntimeOptions {
  lifetime: ReturnType<typeof createHttpHandlerLifetime>;
  runtimeLifecycle?: RuntimeExecutionLifecycle;
}

/** Request body for POST /api/plugins/tools/execute */
interface PluginToolExecuteRequest {
  /** Fully namespaced tool name (e.g., "acme.linear:search-issues"). */
  tool: string;
  /** Parameters matching the tool's declared JSON Schema. */
  parameters?: unknown;
  /** Agent run context. */
  runContext: ToolRunContext;
  /**
   * Optional stable effect key for one logical tool call: retries with the
   * same key replay the recorded response instead of re-executing the tool
   * (see PLUGIN_SPEC.md §13.10 — tool execution idempotency).
   */
  idempotencyKey?: string;
}

/** Dependencies injected into the standalone tool execute route. */
export interface PluginToolExecuteRouteContext {
  db: Db;
  toolDeps?: PluginRouteToolDeps;
  runtimeOptions?: PluginRouteRuntimeOptions;
  executePluginToolHttp: ReturnType<typeof createPluginToolHttpConsumer> | null;
}

export function registerPluginToolExecuteRoute(
  router: Router,
  ctx: PluginToolExecuteRouteContext,
): void {
  const { db, toolDeps, runtimeOptions, executePluginToolHttp } = ctx;
  /**
   * POST /api/plugins/tools/execute — execute a plugin-contributed tool by its
   * namespaced name; the primary endpoint the agent service uses to invoke
   * plugin tools during an agent run. Body: `tool`, `parameters`, `runContext`
   * (agentId, runId, companyId, optional projectId), `idempotencyKey` (retries
   * replay the durable response; 409 while a provisional result is in flight).
   * Response `ToolExecutionResult`. Errors: 400 validation, 404 tool not found,
   * 409 in progress, 501 dispatch disabled, 502 worker/RPC failure.
   */
  const executePluginToolHandler = async (req: Request, res: Response) => {
    const body = (req.body as PluginToolExecuteRequest | undefined);
    if (!body) {
      res.status(400).json({ error: "Request body is required" });
      return;
    }

    const { tool, parameters, runContext } = body;

    // Validate required fields
    if (!tool || typeof tool !== "string") {
      res.status(400).json({ error: '"tool" is required and must be a string' });
      return;
    }

    if (!runContext || typeof runContext !== "object") {
      res.status(400).json({ error: '"runContext" is required and must be an object' });
      return;
    }

    if (!runContext.agentId || !runContext.runId || !runContext.companyId) {
      res.status(400).json({
        error: '"runContext" must include agentId, runId, and companyId',
      });
      return;
    }

    // [tool execution idempotency] Optional caller-supplied effect key.
    //   Plugin calls also use an internal receipt when no key is supplied; bad key → 400, no execution.
    let idempotencyKey: string | null = null;
    if (body.idempotencyKey !== undefined) {
      idempotencyKey = normalizeIdempotencyKey(body.idempotencyKey);
      if (idempotencyKey === null) {
        res.status(400).json({
          error: `"idempotencyKey" must be a non-empty string of at most ${IDEMPOTENCY_KEY_MAX_LENGTH} characters`,
        });
        return;
      }
    }

    assertCompanyAccess(req, runContext.companyId);
    let workflowRunIssueId: string | null = null;
    const registeredTool = toolDeps?.toolDispatcher.getTool(tool) ?? null;
    if (req.actor.type === "agent") {
      const agentId = req.actor.agentId;
      const companyId = req.actor.companyId;
      if (!agentId || !companyId) {
        res.status(403).json({ error: "Agent run context is not valid for tool execution" });
        return;
      }
      const run = await db
        .select({
          id: heartbeatRuns.id,
          agentId: heartbeatRuns.agentId,
          companyId: heartbeatRuns.companyId,
          status: heartbeatRuns.status,
          issueId: heartbeatRuns.issueId,
          contextSnapshot: heartbeatRuns.contextSnapshot,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runContext.runId))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      const catalog = await listWorkflowToolCatalog(db, runContext.companyId);
      const catalogTool = catalog.tools.find((entry) => entry.name === tool);
      const authorization = authorizeRunToolExecution({
        actor: {
          type: "agent",
          agentId,
          companyId,
        },
        runContext,
        run,
        toolName: tool,
        currentEffectiveGrant: catalog.grants.some((grant) => grant.agentId === runContext.agentId && grant.toolName === tool),
        registeredEnabledTool: Boolean(
          catalogTool?.enabled
          && (catalogTool.source !== "plugin" || registeredTool !== null),
        ),
      });
      if (!authorization.allowed) {
        res.status(403).json({ error: authorization.reason });
        return;
      }
      workflowRunIssueId = run?.issueId ?? null;
    } else {
      assertBoard(req);
    }

    if (registeredTool) {
      const result = await executePluginToolHttp!({
        tool, parameters: parameters ?? {}, runContext, idempotencyKey,
      });
      if (result.replay) res.set("x-idempotent-replay", "true");
      res.status(result.status).json(result.body);
      return;
    }

    // Claim only after authorization. Omitted caller keys get a private one-request key.
    const claimedIdempotencyKey = idempotencyKey ?? randomUUID();
    const decision = await claimToolExecutionReceipt(db, {
      companyId: runContext.companyId,
      runId: String(runContext.runId),
      tool,
      idempotencyKey: claimedIdempotencyKey,
      parameters,
    });
    if (decision.kind === "replay") {
      res.status(decision.status).set("x-idempotent-replay", "true").json(decision.body);
      return;
    }
    if (decision.kind === "in-progress") {
      res.status(409).json({ error: "Tool execution already in progress for this idempotency key" });
      return;
    }

    const receipt = {
      id: decision.receiptId, companyId: runContext.companyId, runId: String(runContext.runId), tool,
    };
    const requestIdentity: RuntimeExecutionIdentity | undefined = runtimeOptions ? {
      requestId: receipt.id,
      executionId: receipt.runId,
      attemptId: receipt.id,
      executionGeneration: 1,
    } : undefined;

    let stepEnv: Record<string, string> = {};
    let coreResult: Awaited<ReturnType<typeof executePluginCoreToolCall>> | null = null;
    let executionError: unknown;
    let executionFailed = false;
    try {
      stepEnv = await resolveRunStepEnv(db, String(runContext.runId));
      coreResult = await executePluginCoreToolCall({
        db,
        actor: req.actor,
        runContext,
        workflowRunIssueId,
        tool,
        parameters,
        stepEnv,
        ...(requestIdentity ? { httpRequestIdentity: requestIdentity } : {}),
        runtimeLifecycle: runtimeOptions?.runtimeLifecycle,
      });
    } catch (error) {
      executionFailed = true;
      executionError = error;
    }

    const workflowAuditScope = {
      workflowRunId: stepEnv.PAPERCLIP_WORKFLOW_RUN_ID ?? null,
      stepId: stepEnv.PAPERCLIP_WORKFLOW_STEP_ID ?? null,
    };
    const finalizationBase = {
      db, req, res, lifetime: runtimeOptions?.lifetime, receipt, requestIdentity, workflowAuditScope,
    };

    if (executionFailed) {
      const message = executionError instanceof Error ? executionError.message : String(executionError);
      await finalizeHttpCoreResponse({
        ...finalizationBase,
        originalResult: { kind: "execution_error", error: executionError },
        response: { status: 500, body: { error: message } },
        disposition: "complete",
        condense: false,
      });
      return;
    }
    if (!coreResult) throw new Error("HTTP core tool execution returned no result");

    if (coreResult.deferredBeforeStart) {
      const response = { status: 503, body: { deferredBeforeStart: coreResult.deferredBeforeStart } };
      if (!isPositiveHttpDeferral(coreResult.deferredBeforeStart, requestIdentity)) {
        runtimeOptions?.lifetime.holdFinalization(req, {
          receipt,
          requestIdentity: requestIdentity ?? null,
          originalResult: coreResult,
          response,
          workflowAuditScope,
          disposition: "held",
          reason: "positive_unstarted_proof_invalid",
        });
        throw new Error("HTTP core tool deferral did not carry matching positive unstarted proof");
      }
      await finalizeHttpCoreResponse({ ...finalizationBase, originalResult: coreResult, response, disposition: "release", condense: false });
      return;
    }

    // This result means another exact artifact step call owns the start; the current claim is safe to release.
    if (coreResult.status === 409 && coreResult.body.error === "artifact_tool_step_call_in_progress") {
      await finalizeHttpCoreResponse({
        ...finalizationBase,
        originalResult: coreResult,
        response: { status: coreResult.status, body: coreResult.body as Record<string, unknown> },
        disposition: "release",
      });
      return;
    }

    if (coreResult.status === 404 && coreResult.body.source !== "core") {
      const response = !toolDeps
        ? { status: 501, body: { error: "Plugin tool dispatch is not enabled and no core workflow tool matched" } }
        : { status: 404, body: { error: `Tool "${tool}" not found` } };
      await finalizeHttpCoreResponse({ ...finalizationBase, originalResult: coreResult, response, disposition: "release", condense: false });
      return;
    }

    await finalizeHttpCoreResponse({
      ...finalizationBase,
      originalResult: coreResult,
      response: { status: coreResult.status, body: coreResult.body as Record<string, unknown> },
      disposition: "complete",
    });
  };

  router.post("/plugins/tools/execute",
    runtimeOptions ? runtimeOptions.lifetime.wrapTerminal(executePluginToolHandler) : executePluginToolHandler);
}

/** Standalone router owning POST /plugins/tools/execute. */
export function pluginToolExecuteRoutes(
  db: Db,
  toolDeps?: PluginRouteToolDeps,
  runtimeOptions?: PluginRouteRuntimeOptions,
): Router {
  const router = Router();
  const executePluginToolHttp = toolDeps
    ? createPluginToolHttpConsumer({ db, dispatcher: toolDeps.toolDispatcher })
    : null;
  registerPluginToolExecuteRoute(router, { db, toolDeps, runtimeOptions, executePluginToolHttp });
  return router;
}
