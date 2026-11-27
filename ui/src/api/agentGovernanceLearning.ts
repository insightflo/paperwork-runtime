import { api } from "./client";

export type MemoryReviewStatus = "pending" | "approved" | "rejected" | "held";
export type SkillDraftStatus = "draft" | "promoted" | "discarded";
export type MemoryReviewDecision = "approve" | "reject" | "hold";

export interface MemoryReviewProposal {
  id: string;
  companyId: string;
  agentId: string;
  targetPath: string;
  beforeContent: string;
  afterContent: string;
  diffLines: string[];
  summary: string;
  status: MemoryReviewStatus;
  heldUntilMs: number | null;
  reviewedByUserId: string | null;
  reviewNote: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LocalSkillDraft {
  id: string;
  companyId: string;
  slug: string;
  title: string;
  description: string;
  revision: number;
  contentSha256: string;
  skillMarkdown: string;
  sourceRunIds: string[];
  status: SkillDraftStatus;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryReviewDecisionBody {
  decision: MemoryReviewDecision;
  note?: string;
}

export const agentGovernanceLearningApi = {
  listMemoryReviews: (companyId: string, status?: MemoryReviewStatus) => {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    const qs = params.toString();
    return api.get<MemoryReviewProposal[]>(
      `/companies/${companyId}/memory-reviews${qs ? `?${qs}` : ""}`,
    );
  },
  decideMemoryReview: (companyId: string, id: string, body: MemoryReviewDecisionBody) =>
    api.post<MemoryReviewProposal>(
      `/companies/${companyId}/memory-reviews/${id}/decide`,
      body,
    ),
  listSkillDrafts: (companyId: string, status?: SkillDraftStatus) => {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    const qs = params.toString();
    return api.get<LocalSkillDraft[]>(
      `/companies/${companyId}/skill-drafts${qs ? `?${qs}` : ""}`,
    );
  },
  promoteSkillDraft: (companyId: string, id: string) =>
    api.post<LocalSkillDraft>(`/companies/${companyId}/skill-drafts/${id}/promote`, {}),
  discardSkillDraft: (companyId: string, id: string) =>
    api.post<LocalSkillDraft>(`/companies/${companyId}/skill-drafts/${id}/discard`, {}),
};
