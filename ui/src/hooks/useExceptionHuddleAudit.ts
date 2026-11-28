import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";

export interface ExceptionHuddleAuditEntryData {
  id: string;
  missionId: string | null;
  threadId: string | null;
  decisionKind: string | null;
  decidedByAgentId: string | null;
  createdAt: string;
  payload: Record<string, unknown>;
}

export interface ExceptionHuddleAuditResponse {
  companyId: string;
  entries: ExceptionHuddleAuditEntryData[];
}

export function fetchExceptionHuddleAudit(
  companyId: string,
  opts?: { missionId?: string; threadId?: string; limit?: number },
): Promise<ExceptionHuddleAuditResponse> {
  const params: string[] = [];
  const missionId = opts?.missionId?.trim();
  if (missionId) params.push(`missionId=${encodeURIComponent(missionId)}`);
  const threadId = opts?.threadId?.trim();
  if (threadId) params.push(`threadId=${encodeURIComponent(threadId)}`);
  const limit = opts?.limit;
  if (limit !== undefined && Number.isFinite(limit)) {
    params.push(`limit=${encodeURIComponent(String(limit))}`);
  }
  const query = params.length > 0 ? `?${params.join("&")}` : "";
  return api.get<ExceptionHuddleAuditResponse>(
    `/companies/${encodeURIComponent(companyId)}/collab-channels/huddles/audit${query}`,
  );
}

export function useExceptionHuddleAudit(
  companyId: string | undefined,
  opts?: { missionId?: string; threadId?: string; limit?: number; enabled?: boolean },
) {
  return useQuery({
    queryKey: ["exception-huddle-audit", companyId, opts?.missionId ?? null, opts?.threadId ?? null, opts?.limit ?? null],
    queryFn: () => fetchExceptionHuddleAudit(companyId!, opts),
    enabled: Boolean(companyId && (opts?.enabled ?? true)),
  });
}
