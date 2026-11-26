/**
 * Tool Registry Service
 *
 * Manages tool definitions, audit logging, and tool dispatch with worktree integration.
 */

import type { Db } from "@paperclipai/db";
import { toolDefinitions, toolAuditLog, agents, issues } from "@paperclipai/db";
import { eq, and, desc } from "drizzle-orm";
import crypto from "node:crypto";
import { validateToolArtifactContract } from '../workflow/artifact-config-validation.js';
import { badRequest } from '../../errors.js';
import type {
  ToolDefinition,
  CreateToolDefinitionInput,
  ToolInvocationResult,
  ToolAuditLogEntry,
  ToolDispatchContext,
} from "./types.js";

/**
 * Computes SHA-256 hash of arguments for audit logging.
 */
function hashArgs(args: Record<string, unknown>): string {
  const str = JSON.stringify(args, Object.keys(args).sort());
  return crypto.createHash("sha256").update(str).digest("hex");
}

type ToolDefinitionUpdates = Partial<Omit<ToolDefinition, "id" | "createdAt" | "updatedAt">>;

function isAdapterConfigObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A supplied adapterConfig replaces the stored one wholesale and must be an object; anything
 * else is a 400 here rather than a jsonb write failure. A partial update that omits it keeps
 * the stored value, so the artifact contract is enforced against that stored config.
 */
async function assertUpdateArtifactContract(db: Db, id: string, updates: ToolDefinitionUpdates): Promise<void> {
  if (!Object.prototype.hasOwnProperty.call(updates, "adapterConfig") || updates.adapterConfig === undefined) {
    const existing = await toolService.getDefinitionById(db, id);
    if (existing && isAdapterConfigObject(existing.adapterConfig)) {
      validateToolArtifactContract(existing.adapterConfig);
    }
    return;
  }
  if (!isAdapterConfigObject(updates.adapterConfig)) {
    throw badRequest("adapterConfig must be an object");
  }
  validateToolArtifactContract(updates.adapterConfig);
}

/**
 * Tool registry service.
 */
export const toolService = {
  /**
   * Create a new tool definition.
   */
  async createDefinition(
    db: Db,
    input: CreateToolDefinitionInput,
  ): Promise<ToolDefinition> {
    validateToolArtifactContract(input.adapterConfig);
    const id = crypto.randomUUID();
    const now = new Date();

    await db.insert(toolDefinitions).values({
      id,
      companyId: input.companyId,
      name: input.name,
      description: input.description ?? "",
      inputSchema: input.inputSchema ?? {},
      adapterType: input.adapterType,
      adapterConfig: input.adapterConfig,
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    });

    return this.getDefinitionById(db, id) as Promise<ToolDefinition>;
  },

  /**
   * Get a tool definition by ID.
   */
  async getDefinitionById(db: Db, id: string): Promise<ToolDefinition | null> {
    const result = await db
      .select()
      .from(toolDefinitions)
      .where(eq(toolDefinitions.id, id))
      .limit(1);

    if (!result[0]) return null;
    return result[0] as ToolDefinition;
  },

  /**
   * Get a tool definition by name and company.
   */
  async getDefinitionByName(
    db: Db,
    companyId: string,
    name: string,
  ): Promise<ToolDefinition | null> {
    const result = await db
      .select()
      .from(toolDefinitions)
      .where(
        and(
          eq(toolDefinitions.companyId, companyId),
          eq(toolDefinitions.name, name),
        ),
      )
      .limit(1);

    if (!result[0]) return null;
    return result[0] as ToolDefinition;
  },

  /**
   * List tool definitions for a company.
   */
  async listDefinitions(
    db: Db,
    filters: { companyId?: string; enabled?: boolean } = {},
  ): Promise<ToolDefinition[]> {
    const conditions = [];
    if (filters.companyId) conditions.push(eq(toolDefinitions.companyId, filters.companyId));
    if (filters.enabled !== undefined) conditions.push(eq(toolDefinitions.enabled, filters.enabled));

    const rows = await db
      .select()
      .from(toolDefinitions)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(toolDefinitions.createdAt));

    return rows as ToolDefinition[];
  },

  /**
   * Update a tool definition.
   */
  async updateDefinition(
    db: Db,
    id: string,
    updates: ToolDefinitionUpdates,
  ): Promise<ToolDefinition | null> {
    await assertUpdateArtifactContract(db, id, updates);
    await db
      .update(toolDefinitions)
      .set({
        ...updates,
        updatedAt: new Date(),
      })
      .where(eq(toolDefinitions.id, id));

    return this.getDefinitionById(db, id);
  },

  /**
   * Delete a tool definition.
   */
  async deleteDefinition(db: Db, id: string): Promise<boolean> {
    const rows = await db
      .delete(toolDefinitions)
      .where(eq(toolDefinitions.id, id))
      .returning({ id: toolDefinitions.id });

    return rows.length > 0;
  },

  /**
   * Check if a tool invocation is allowed and log the result.
   */
  async checkInvocation(
    db: Db,
    context: ToolDispatchContext,
  ): Promise<ToolInvocationResult> {
    // Get the tool definition
    const tool = await this.getDefinitionByName(db, context.companyId, context.toolName);
    if (!tool) {
      return {
        allowed: false,
        blockedReason: `Tool "${context.toolName}" not found`,
      };
    }

    if (!tool.enabled) {
      return {
        allowed: false,
        blockedReason: `Tool "${context.toolName}" is disabled`,
      };
    }

    // Check worktree constraints if provided
    if (context.worktreeCheck && !context.worktreeCheck.allowed) {
      const tier = context.worktreeCheck.tier;
      if (tier === "MUST") {
        await this.logInvocation(db, {
          companyId: context.companyId,
          toolId: tool.id,
          issueId: context.issueId,
          agentId: context.agentId,
          argsHash: hashArgs(context.args),
          result: "blocked_must",
        });

        return {
          allowed: false,
          blockedReason: context.worktreeCheck.message ?? "Blocked by worktree rule",
        };
      }

      if (tier === "SHOULD") {
        await this.logInvocation(db, {
          companyId: context.companyId,
          toolId: tool.id,
          issueId: context.issueId,
          agentId: context.agentId,
          argsHash: hashArgs(context.args),
          result: "blocked_should",
        });
        // SHOULD is a warning, but allows execution
      }
    }

    // Allowed
    await this.logInvocation(db, {
      companyId: context.companyId,
      toolId: tool.id,
      issueId: context.issueId,
      agentId: context.agentId,
      argsHash: hashArgs(context.args),
      result: "allowed",
    });

    return { allowed: true };
  },

  /**
   * Log a tool invocation to the audit log.
   */
  async logInvocation(
    db: Db,
    entry: {
      companyId: string;
      toolId: string;
      issueId: string | null;
      agentId: string | null;
      argsHash: string;
      result: "allowed" | "blocked_must" | "blocked_should";
    },
  ): Promise<void> {
    await db.insert(toolAuditLog).values({
      id: crypto.randomUUID(),
      toolId: entry.toolId,
      companyId: entry.companyId,
      issueId: entry.issueId,
      agentId: entry.agentId,
      argsHash: entry.argsHash,
      result: entry.result,
      createdAt: new Date(),
    });
  },

  /**
   * Get audit log entries for a tool.
   */
  async getAuditLog(
    db: Db,
    filters: { toolId?: string; companyId?: string; limit?: number },
  ): Promise<ToolAuditLogEntry[]> {
    const conditions = [];
    if (filters.toolId) conditions.push(eq(toolAuditLog.toolId, filters.toolId));
    if (filters.companyId) conditions.push(eq(toolAuditLog.companyId, filters.companyId));

    const baseQuery = db
      .select()
      .from(toolAuditLog)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(toolAuditLog.createdAt));

    const rows = filters.limit !== undefined ? await baseQuery.limit(filters.limit) : await baseQuery;
    return rows as ToolAuditLogEntry[];
  },
};

// Re-export types
export type {
  ToolDefinition,
  CreateToolDefinitionInput,
  ToolInvocationResult,
  ToolAuditLogEntry,
  ToolDispatchContext,
};
