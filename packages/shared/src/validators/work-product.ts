import { z } from "zod";

function normalizeWorkItemProductShape(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const value = { ...(input as Record<string, unknown>) };
  if (value.workContextId !== undefined && value.projectId === undefined) value.projectId = value.workContextId;
  if (value.executionContextId !== undefined && value.executionWorkspaceId === undefined) value.executionWorkspaceId = value.executionContextId;
  return value;
}

function normalizeCreateWorkItemProduct(input: unknown): unknown {
  const normalized = normalizeWorkItemProductShape(input);
  if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) return normalized;
  const value = normalized as Record<string, unknown>;
  const metadata = value.metadata;
  const metadataPath = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>).path
    : undefined;
  const paths = [value.externalId, metadataPath].filter((path): path is string => typeof path === "string");
  const filenames = paths.map((path) => path.split(/[\\/]/).pop());
  const isContent = value.title === "content.json" || filenames.includes("content.json");
  const isArtifact = value.title === "security-precheck.json"
    || filenames.includes("security-precheck.json")
    || [value.title, ...paths].some((path) => typeof path === "string" && /(?:^|[\\/])assets[\\/].+/.test(path));
  if (isContent || isArtifact) {
    if (value.type === undefined) value.type = isContent ? "document" : "artifact";
    if (value.isPrimary === undefined) value.isPrimary = isContent;
  }
  return value;
}

export const issueWorkProductTypeSchema = z.enum([
  "preview_url",
  "runtime_service",
  "pull_request",
  "branch",
  "commit",
  "artifact",
  "document",
]);

export const issueWorkProductStatusSchema = z.enum([
  "active",
  "ready_for_review",
  "approved",
  "changes_requested",
  "merged",
  "closed",
  "failed",
  "archived",
  "draft",
]);

export const issueWorkProductReviewStateSchema = z.enum([
  "none",
  "needs_board_review",
  "approved",
  "changes_requested",
]);

const createIssueWorkProductObjectSchema = z.object({
  projectId: z.string().uuid().optional().nullable(),
  executionWorkspaceId: z.string().uuid().optional().nullable(),
  runtimeServiceId: z.string().uuid().optional().nullable(),
  type: issueWorkProductTypeSchema,
  provider: z.string().min(1),
  externalId: z.string().optional().nullable(),
  title: z.string().min(1),
  url: z.string().url().optional().nullable(),
  status: issueWorkProductStatusSchema.default("active"),
  reviewState: issueWorkProductReviewStateSchema.optional().default("none"),
  isPrimary: z.boolean().optional().default(false),
  healthStatus: z.enum(["unknown", "healthy", "unhealthy"]).optional().default("unknown"),
  summary: z.string().optional().nullable(),
  metadata: z.record(z.unknown()).optional().nullable(),
  createdByRunId: z.string().uuid().optional().nullable(),
});

export const createIssueWorkProductSchema = z.preprocess(normalizeCreateWorkItemProduct, createIssueWorkProductObjectSchema);

export type CreateIssueWorkProduct = z.infer<typeof createIssueWorkProductSchema>;

export const updateIssueWorkProductSchema = z.preprocess(normalizeWorkItemProductShape, createIssueWorkProductObjectSchema.partial());

export type UpdateIssueWorkProduct = z.infer<typeof updateIssueWorkProductSchema>;

export const workItemProductTypeSchema = issueWorkProductTypeSchema;
export const workItemProductStatusSchema = issueWorkProductStatusSchema;
export const workItemProductReviewStateSchema = issueWorkProductReviewStateSchema;
export const createWorkItemProductSchema = createIssueWorkProductSchema;
export const updateWorkItemProductSchema = updateIssueWorkProductSchema;

export type CreateWorkItemProduct = CreateIssueWorkProduct;
export type UpdateWorkItemProduct = UpdateIssueWorkProduct;
