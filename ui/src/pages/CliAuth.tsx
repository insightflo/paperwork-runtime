import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { accessApi } from "../api/access";
import { authApi } from "../api/auth";
import { queryKeys } from "../lib/queryKeys";
import { HumanReviewPacket } from "../components/HumanReviewPacket";

const cardClass =
  "tactile-card rounded-xl border border-slate-200/90 bg-white p-6 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.05)] dark:border-white/[0.08] dark:bg-[#0e131d] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_14px_36px_-18px_rgba(0,0,0,0.8)]";
const eyebrowClass = "mb-1 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-[#8b97ad]";
const insetPanelClass =
  "rounded-lg border border-slate-200/80 bg-slate-50/80 p-3.5 dark:border-white/[0.07] dark:bg-[#07090d]/85";
const pillBase =
  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-[0.14em]";

function displayClientName(value: string | null | undefined) {
  const clientName = value?.trim() || "Paperwork CLI";
  return /^paperclip(?:ai)?(?: cli)?$/i.test(clientName) ? "Paperwork CLI" : clientName;
}

export function displayCliCommand(value: string | null | undefined): string {
  return value ? value.replace(/^paperclip(?:ai)?(?=\s|$)/i, "paperwork") : "";
}

export function CliAuthPage() {
  const queryClient = useQueryClient();
  const params = useParams();
  const [searchParams] = useSearchParams();
  const challengeId = (params.id ?? "").trim();
  const token = (searchParams.get("token") ?? "").trim();
  const currentPath = useMemo(
    () => `/cli-auth/${encodeURIComponent(challengeId)}${token ? `?token=${encodeURIComponent(token)}` : ""}`,
    [challengeId, token],
  );

  const sessionQuery = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });
  const challengeQuery = useQuery({
    queryKey: ["cli-auth-challenge", challengeId, token],
    queryFn: () => accessApi.getCliAuthChallenge(challengeId, token),
    enabled: challengeId.length > 0 && token.length > 0,
    retry: false,
  });

  const approveMutation = useMutation({
    mutationFn: () => accessApi.approveCliAuthChallenge(challengeId, token),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
      await challengeQuery.refetch();
    },
  });

  const cancelMutation = useMutation({
    mutationFn: () => accessApi.cancelCliAuthChallenge(challengeId, token),
    onSuccess: async () => {
      await challengeQuery.refetch();
    },
  });

  if (!challengeId || !token) {
    return (
      <div className="mx-auto max-w-xl px-4 py-10 tabular-nums">
        <div className={cardClass}>
          <span className={`${pillBase} border-rose-500/30 bg-rose-500/10 text-rose-700 dark:border-rose-400/30 dark:bg-rose-500/12 dark:text-rose-300`}>
            CLI auth
          </span>
          <p className="mt-3 text-sm text-rose-700 dark:text-rose-300">Invalid CLI auth URL.</p>
        </div>
      </div>
    );
  }

  if (sessionQuery.isLoading || challengeQuery.isLoading) {
    return (
      <div className="mx-auto max-w-xl px-4 py-10 tabular-nums">
        <div className={`${cardClass} flex items-center gap-2.5 text-sm text-slate-600 dark:text-[#8b97ad]`}>
          <span aria-hidden className="h-2 w-2 animate-pulse rounded-full bg-blue-500 dark:bg-[#60a5fa]" />
          Loading CLI auth challenge...
        </div>
      </div>
    );
  }

  if (challengeQuery.error) {
    return (
      <div className="mx-auto max-w-xl px-4 py-10 tabular-nums">
        <div className={cardClass}>
          <span className={`${pillBase} border-rose-500/30 bg-rose-500/10 text-rose-700 dark:border-rose-400/30 dark:bg-rose-500/12 dark:text-rose-300`}>
            CLI auth
          </span>
          <h1 className="mt-3 text-lg font-semibold tracking-tight text-slate-950 dark:text-[#edf2fb]">CLI auth challenge unavailable</h1>
          <p className="mt-2 text-sm text-slate-600 dark:text-[#8b97ad]">
            {challengeQuery.error instanceof Error ? challengeQuery.error.message : "Challenge is invalid or expired."}
          </p>
        </div>
      </div>
    );
  }

  const challenge = challengeQuery.data;
  if (!challenge) {
    return (
      <div className="mx-auto max-w-xl px-4 py-10 tabular-nums">
        <div className={cardClass}>
          <p className="text-sm text-rose-700 dark:text-rose-300">CLI auth challenge unavailable.</p>
        </div>
      </div>
    );
  }

  if (challenge.status === "approved") {
    return (
      <div className="mx-auto max-w-xl px-4 py-10 tabular-nums">
        <div className={cardClass}>
          <span className={`${pillBase} border-lime-500/30 bg-lime-500/10 text-lime-700 dark:border-[#a3e635]/30 dark:bg-[#a3e635]/12 dark:text-[#a3e635]`}>
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-lime-500 shadow-[0_0_6px_rgba(163,230,53,0.75)] dark:bg-[#a3e635]" />
            CLI access approved
          </span>
          <h1 className="mt-3 text-xl font-semibold tracking-tight text-slate-950 dark:text-[#edf2fb]">CLI access approved</h1>
          <p className="mt-2 text-sm text-slate-600 dark:text-[#8b97ad]">
            The Paperwork CLI can now finish authentication on the requesting machine.
          </p>
          <div className={`mt-5 ${insetPanelClass}`}>
            <div className={eyebrowClass}>Command</div>
            <div className="font-mono text-sm text-slate-900 dark:text-[#edf2fb]">{displayCliCommand(challenge.command)}</div>
          </div>
        </div>
      </div>
    );
  }

  if (challenge.status === "cancelled" || challenge.status === "expired") {
    return (
      <div className="mx-auto max-w-xl px-4 py-10 tabular-nums">
        <div className={cardClass}>
          <span className={`${pillBase} border-amber-500/30 bg-amber-500/10 text-amber-800 dark:border-[#f59e0b]/35 dark:bg-[#f59e0b]/12 dark:text-[#f59e0b]`}>
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-amber-500 dark:bg-[#f59e0b]" />
            {challenge.status === "expired" ? "Expired" : "Cancelled"}
          </span>
          <h1 className="mt-3 text-xl font-semibold tracking-tight text-slate-950 dark:text-[#edf2fb]">
            {challenge.status === "expired" ? "CLI auth challenge expired" : "CLI auth challenge cancelled"}
          </h1>
          <p className="mt-2 text-sm text-slate-600 dark:text-[#8b97ad]">
            Start the CLI auth flow again from your terminal to generate a new approval request.
          </p>
        </div>
      </div>
    );
  }

  if (challenge.requiresSignIn || !sessionQuery.data) {
    return (
      <div className="mx-auto max-w-xl px-4 py-10 tabular-nums">
        <div className={cardClass}>
          <span className={`${pillBase} border-blue-500/25 bg-blue-500/10 text-blue-700 dark:border-[#60a5fa]/30 dark:bg-[#60a5fa]/12 dark:text-[#60a5fa]`}>
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-blue-500 dark:bg-[#60a5fa]" />
            CLI auth
          </span>
          <h1 className="mt-3 text-xl font-semibold tracking-tight text-slate-950 dark:text-[#edf2fb]">Sign in required</h1>
          <p className="mt-2 text-sm text-slate-600 dark:text-[#8b97ad]">
            Sign in or create an account, then return to this page to approve the CLI access request.
          </p>
          <Button
            asChild
            className="mt-5 rounded-lg bg-blue-600 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] hover:bg-blue-700 dark:bg-[#2563eb] dark:hover:bg-[#3b82f6]"
          >
            <Link to={`/auth?next=${encodeURIComponent(currentPath)}`}>Sign in / Create account</Link>
          </Button>
        </div>
      </div>
    );
  }

  const isAdminScope = challenge.requestedAccess === "instance_admin_required";

  return (
    <div className="mx-auto max-w-xl px-4 py-10 tabular-nums">
      <div className={cardClass}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className={`${pillBase} border-blue-500/25 bg-blue-500/10 text-blue-700 dark:border-[#60a5fa]/30 dark:bg-[#60a5fa]/12 dark:text-[#60a5fa]`}>
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-blue-500 shadow-[0_0_6px_rgba(96,165,250,0.65)] dark:bg-[#60a5fa]" />
            CLI access control
          </span>
          <span
            className={`${pillBase} ${
              isAdminScope
                ? "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:border-[#f59e0b]/35 dark:bg-[#f59e0b]/12 dark:text-[#f59e0b]"
                : "border-lime-500/30 bg-lime-500/10 text-lime-700 dark:border-[#a3e635]/30 dark:bg-[#a3e635]/12 dark:text-[#a3e635]"
            }`}
          >
            {isAdminScope ? "Instance admin" : "Board"}
          </span>
        </div>
        <h1 className="mt-3 text-xl font-semibold tracking-tight text-slate-950 dark:text-[#edf2fb]">Approve Paperwork CLI access</h1>
        <p className="mt-2 text-sm text-slate-600 dark:text-[#8b97ad]">
          A local Paperwork CLI process is requesting board access to this instance.
        </p>

        <div className={`mt-5 space-y-3 text-sm ${insetPanelClass}`}>
          <div>
            <div className={eyebrowClass}>Command</div>
            <div className="break-all font-mono text-xs text-slate-900 dark:text-[#edf2fb]">{displayCliCommand(challenge.command)}</div>
          </div>
          <div className="grid grid-cols-1 gap-3 border-t border-slate-200/80 pt-3 dark:border-white/[0.06] sm:grid-cols-2">
            <div>
              <div className={eyebrowClass}>Client</div>
              <div className="font-medium text-slate-900 dark:text-[#edf2fb]">{displayClientName(challenge.clientName)}</div>
            </div>
            <div>
              <div className={eyebrowClass}>Requested access</div>
              <div className="font-medium text-slate-900 dark:text-[#edf2fb]">
                {isAdminScope ? "Instance admin" : "Board"}
              </div>
            </div>
          </div>
          {challenge.requestedCompanyName && (
            <div className="border-t border-slate-200/80 pt-3 dark:border-white/[0.06]">
              <div className={eyebrowClass}>Requested company</div>
              <div className="font-medium text-slate-900 dark:text-[#edf2fb]">{challenge.requestedCompanyName}</div>
            </div>
          )}
        </div>

        <HumanReviewPacket packet={{
          schemaVersion: "human-review-v1",
          decisionSubject: `${displayClientName(challenge.clientName)}에 ${isAdminScope ? "인스턴스 관리자" : "Board"} 접근을 허용할까요?`,
          evidence: [{ label: "CLI 인증 요청 원본", href: currentPath, location: `요청 ${challenge.id} > 명령 ${displayCliCommand(challenge.command)}`, description: `만료 시각 ${challenge.expiresAt}` }],
          interpretation: `표시된 명령을 실행한 로컬 CLI가 ${challenge.requestedCompanyName ?? "이 인스턴스"}의 운영 API 인증 키를 요청합니다.`,
          impact: { ifApproved: "요청한 CLI가 표시된 범위의 운영 API를 호출할 수 있습니다.", ifRejected: "인증 키가 발급되지 않아 이 요청으로는 접근할 수 없습니다.", ifWrong: "신뢰하지 않는 프로세스가 회사 데이터와 운영 기능에 접근할 수 있습니다." },
          unresolvedFacts: [], questions: ["지금 본인이 이 명령을 실행했고, 클라이언트와 요청 권한이 예상과 일치합니까?"],
          recommendedNextStep: "명령, 클라이언트, 접근 범위, 대상 회사를 대조한 뒤 승인하거나 취소하세요.",
          requiredReviewer: isAdminScope ? "인스턴스 관리자" : "회사 Board 사용자",
        }} />

        {(approveMutation.error || cancelMutation.error) && (
          <p className="mt-4 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-700 dark:border-rose-400/30 dark:bg-rose-500/12 dark:text-rose-300">
            {(approveMutation.error ?? cancelMutation.error) instanceof Error
              ? ((approveMutation.error ?? cancelMutation.error) as Error).message
              : "Failed to update CLI auth challenge"}
          </p>
        )}

        {!challenge.canApprove && (
          <p className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:border-[#f59e0b]/35 dark:bg-[#f59e0b]/12 dark:text-[#f59e0b]">
            This challenge requires instance-admin access. Sign in with an instance admin account to approve it.
          </p>
        )}

        <div className="mt-5 flex gap-3">
          <Button
            className="rounded-lg bg-blue-600 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] hover:bg-blue-700 dark:bg-[#2563eb] dark:hover:bg-[#3b82f6]"
            onClick={() => approveMutation.mutate()}
            disabled={!challenge.canApprove || approveMutation.isPending || cancelMutation.isPending}
          >
            {approveMutation.isPending ? "Approving..." : "Approve CLI access"}
          </Button>
          <Button
            type="button"
            variant="outline"
            className="rounded-lg border-slate-200/90 bg-white text-slate-700 hover:bg-slate-50 dark:border-white/[0.1] dark:bg-[#07090d] dark:text-[#c9d3e4] dark:hover:bg-white/[0.04]"
            onClick={() => cancelMutation.mutate()}
            disabled={approveMutation.isPending || cancelMutation.isPending}
          >
            {cancelMutation.isPending ? "Cancelling..." : "Cancel"}
          </Button>
        </div>
      </div>
    </div>
  );
}
