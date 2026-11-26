/**
 * Bounded list paging for workflow runs.
 *
 * `GET /companies/:companyId/workflow-runs` and `GET /workflows/:workflowId/runs` used to
 * fetch every `workflow_runs` row for the scope. Callers may pass `limit`/`offset`; omitted or
 * invalid values fall back to the defaults below, and the store always emits SQL LIMIT/OFFSET.
 *
 * Mirrors services/heartbeat-bounded-reads.ts (service-level clamp is lenient; the route parser
 * rejects non-numeric input with 400 before clamping).
 */

import { badRequest } from "../../errors.js";

export const WORKFLOW_RUN_LIST_DEFAULT_LIMIT = 200;
export const WORKFLOW_RUN_LIST_MAX_LIMIT = 500;
export const WORKFLOW_RUN_LIST_DEFAULT_OFFSET = 0;

export interface WorkflowRunListFilters {
  companyId?: string;
  workflowId?: string;
  missionId?: string;
  /** Max rows; default 200, clamped to 1..500. */
  limit?: number;
  /** Rows to skip; default 0, clamped to non-negative safe integers. */
  offset?: number;
}

export interface WorkflowRunListPage {
  limit: number;
  offset: number;
}

export function clampWorkflowRunListLimit(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return WORKFLOW_RUN_LIST_DEFAULT_LIMIT;
  return Math.max(1, Math.min(Math.floor(value), WORKFLOW_RUN_LIST_MAX_LIMIT));
}

export function clampWorkflowRunListOffset(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return WORKFLOW_RUN_LIST_DEFAULT_OFFSET;
  return Math.min(Math.max(Math.floor(value), WORKFLOW_RUN_LIST_DEFAULT_OFFSET), Number.MAX_SAFE_INTEGER);
}

/** Resolve the effective page for a filters object; always returns finite integers. */
export function resolveWorkflowRunListPage(filters: Pick<WorkflowRunListFilters, "limit" | "offset">): WorkflowRunListPage {
  return {
    limit: clampWorkflowRunListLimit(filters.limit),
    offset: clampWorkflowRunListOffset(filters.offset),
  };
}

function parsePositiveIntegerParam(value: unknown, name: "limit" | "offset"): number | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw badRequest(`Invalid ${name}`);
  return parsed;
}

/**
 * Read `?limit=` / `?offset=` from an Express query object. Missing, blank, or non-string
 * values yield `undefined` (service default); non-numeric strings throw 400.
 */
export function parseWorkflowRunListQuery(query: Record<string, unknown>): Pick<WorkflowRunListFilters, "limit" | "offset"> {
  return {
    limit: parsePositiveIntegerParam(query.limit, "limit"),
    offset: parsePositiveIntegerParam(query.offset, "offset"),
  };
}
