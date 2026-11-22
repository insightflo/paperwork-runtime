// [파일 목적] Core Quality Board & Quality RSI API client. company-scoped 품질 현황 + 자가개선(RSI).
// [외부 연결] server routes/quality.ts, routes/quality-rsi.ts, ui pages/Quality.tsx.
import type {
  CreateQualityReviewItemRequest,
  CreateQualityReviewItemResponse,
  GenerateQualityDailyReportResponse,
  PromoteQualityAnchorResponse,
  QualityDailyReport,
  QualityEvaluatorAnchorCase,
  QualityEvaluatorCandidateRun,
  QualityEvaluatorVersion,
  QualityReviewItemListItem,
  QualitySummary,
  RecordQualityEvidenceRequest,
  RecordQualityEvidenceResponse,
  RecordQualityVerdictRequest,
  RecordQualityVerdictResponse,
  RequestQualityEvidenceRequest,
  RequestQualityEvidenceResponse,
} from "@paperclipai/shared";
import { api } from "./client";

export type QualityRsiAxis = "worker" | "qa_self";
export type QualityRsiPatternStatus = "canon" | "auto_injected" | "observing";

export interface QualityRsiCluster {
  axis: QualityRsiAxis;
  code: string;
  signature: string;
  canonSignature: string;
  title: string;
  summary: string;
  count: number;
  recentCount30d: number;
  latestAt: string;
  samples: Array<{ missionTitle: string; detail: string; createdAt: string }>;
  rsiStatus: QualityRsiPatternStatus;
  wikiPatternId: string | null;
}

export interface QualityRsiOverview {
  stats: {
    pass30d: number;
    requestChanges30d: number;
    passRate30d: number | null;
    passAllTime: number;
    requestChangesAllTime: number;
    passRateAllTime: number | null;
    passedMissionsTotal: number;
    escapedMissionsCount: number;
    escapedDefectRate: number | null;
    autoInjectedCount: number;
    canonCount: number;
    openReviewItemsCount: number;
    staleReviewItemsCount: number;
  };
  clusters: QualityRsiCluster[];
  recentVerdicts: Array<{
    id: string;
    missionId: string;
    missionTitle: string;
    verdict: string;
    diagnosticCount: number;
    topDetail: string | null;
    createdAt: string;
  }>;
  openReviewItems: Array<{
    id: string;
    missionId: string | null;
    missionTitle: string | null;
    title: string;
    status: string;
    triggerSource: string;
    failureType: string | null;
    createdAt: string;
  }>;
}

export interface QualityRsiSyncResult {
  closedStaleItems: number;
  createdPatterns: number;
  skippedExisting: number;
  canonCount: number;
}

export const qualityApi = {
  rsiOverview: (companyId: string) =>
    api.get<QualityRsiOverview>(`/companies/${companyId}/quality/rsi-overview`),
  rsiSync: (companyId: string) =>
    api.post<QualityRsiSyncResult>(`/companies/${companyId}/quality/rsi-sync`, {}),
  rsiPromoteCanon: (companyId: string, signature: string) =>
    api.post<{ patternId: string; alreadyCanon: boolean }>(`/companies/${companyId}/quality/rsi-promote-canon`, { signature }),
  summary: (companyId: string) =>
    api.get<QualitySummary>(`/companies/${companyId}/quality/summary`),
  listReviewItems: (companyId: string) =>
    api.get<QualityReviewItemListItem[]>(`/companies/${companyId}/quality/review-items`),
  getReviewItem: (reviewItemId: string) =>
    api.get<QualityReviewItemListItem>(`/quality/review-items/${reviewItemId}`),
  createReviewItem: (companyId: string, body: CreateQualityReviewItemRequest) =>
    api.post<CreateQualityReviewItemResponse>(`/companies/${companyId}/quality/review-items`, body),
  recordVerdict: (reviewItemId: string, body: RecordQualityVerdictRequest) =>
    api.post<RecordQualityVerdictResponse>(`/quality/review-items/${reviewItemId}/verdict`, body),
  requestEvidence: (reviewItemId: string, body: RequestQualityEvidenceRequest) =>
    api.post<RequestQualityEvidenceResponse>(`/quality/review-items/${reviewItemId}/request-evidence`, body),
  recordEvidence: (reviewItemId: string, body: RecordQualityEvidenceRequest) =>
    api.post<RecordQualityEvidenceResponse>(`/quality/review-items/${reviewItemId}/evidence`, body),
  promoteAnchor: (reviewItemId: string, verdictId: string, title: string) =>
    api.post<PromoteQualityAnchorResponse>(`/quality/review-items/${reviewItemId}/promote-anchor`, { verdictId, title }),
  listAnchors: (companyId: string) =>
    api.get<QualityEvaluatorAnchorCase[]>(`/companies/${companyId}/quality/anchors`),
  listEvaluatorVersions: (companyId: string) =>
    api.get<QualityEvaluatorVersion[]>(`/companies/${companyId}/quality/evaluator-versions`),
  listCandidateRuns: (companyId: string, versionId?: string) =>
    api.get<QualityEvaluatorCandidateRun[]>(
      `/companies/${companyId}/quality/candidate-runs${versionId ? `?versionId=${encodeURIComponent(versionId)}` : ""}`,
    ),
  replayCandidateRun: (companyId: string, runId: string, body: { regressions?: number; resultSummary?: string }) =>
    api.post<QualityEvaluatorCandidateRun>(`/companies/${companyId}/quality/candidate-runs/${runId}/replay`, body),
  promoteEvaluatorVersion: (companyId: string, versionId: string) =>
    api.post<QualityEvaluatorVersion>(`/companies/${companyId}/quality/evaluator-versions/${versionId}/promote`, {}),
  generateDailyReport: (companyId: string, body: { reportDate?: string } = {}) =>
    api.post<GenerateQualityDailyReportResponse>(`/companies/${companyId}/quality/daily-reports/generate`, body),
  listDailyReports: (companyId: string) =>
    api.get<QualityDailyReport[]>(`/companies/${companyId}/quality/daily-reports`),
};
