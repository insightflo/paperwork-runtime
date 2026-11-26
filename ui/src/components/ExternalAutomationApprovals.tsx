import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { approvalsApi } from "../api/approvals";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { ApprovalCard } from "./ApprovalCard";

export { readPayload, shortSha } from "./external-automation-payload";

export function ExternalAutomationApprovals() {
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: selectedCompanyId ? queryKeys.approvals.list(selectedCompanyId, "pending") : ["approvals", "external", "pending"],
    queryFn: () => approvalsApi.list(selectedCompanyId!, "pending"), enabled: !!selectedCompanyId, refetchInterval: 30_000,
    select: (items) => items.filter((item) => item.type === "external_automation"),
  });
  const refresh = () => selectedCompanyId && queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(selectedCompanyId) });
  const approve = useMutation({ mutationFn: (id: string) => approvalsApi.approve(id), onSuccess: () => { setActionError(null); refresh(); }, onError: (error) => setActionError(error instanceof Error ? error.message : "승인하지 못했습니다.") });
  const reject = useMutation({ mutationFn: (id: string) => approvalsApi.reject(id), onSuccess: () => { setActionError(null); refresh(); }, onError: (error) => setActionError(error instanceof Error ? error.message : "거절하지 못했습니다.") });
  if (!selectedCompanyId || isLoading || !data?.length) return null;
  return (
    <section className="space-y-2 tabular-nums" aria-label="추가 승인 요청">
      <div className="tactile-card relative overflow-hidden rounded-[12px] border border-slate-200/90 bg-white px-3 py-2.5 text-slate-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] dark:border-white/[0.08] dark:bg-none dark:bg-[#0e131d] dark:text-[#edf2fb] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_10px_28px_rgba(0,0,0,0.36)]">
        <div aria-hidden className="pointer-events-none absolute bottom-3 left-0 top-3 w-px bg-gradient-to-b from-amber-500/70 via-amber-500/15 to-transparent dark:from-[#f59e0b]/85 dark:via-[#f59e0b]/15" />
        <div className="relative flex flex-wrap items-center gap-2">
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-amber-500 shadow-[0_0_7px_rgba(245,158,11,0.45)] dark:bg-[#f59e0b]" />
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-[#8b97ad]">추가 승인 요청</h2>
          <p className="min-w-0 flex-1 truncate text-xs text-slate-500 dark:text-[#8b97ad]">외부 시스템 실행, 배포, 신고 초안 등 종류와 관계없이 근거와 영향을 검토한 뒤 결정합니다.</p>
        </div>
      </div>
      {actionError && (
        <div className="flex gap-2 rounded-[10px] border border-rose-600/30 bg-rose-500/10 p-3 text-sm text-rose-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.72)] dark:border-[#f43f5e]/35 dark:bg-[#f43f5e]/10 dark:text-[#fb7185] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]" role="alert">
          <AlertTriangle className="h-4 w-4 shrink-0" />{actionError}
        </div>
      )}
      {data.map((approval) => <ApprovalCard key={approval.id} approval={approval} requesterAgent={null} onApprove={() => approve.mutate(approval.id)} onReject={() => reject.mutate(approval.id)} detailLink={`/approvals/${approval.id}`} isPending={approve.isPending || reject.isPending} />)}
    </section>
  );
}
