import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "@/lib/router";
import { accessApi } from "../api/access";
import { authApi } from "../api/auth";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";

const cardClass =
  "tactile-card rounded-xl border border-slate-200/90 bg-white p-6 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.05)] dark:border-white/[0.08] dark:bg-[#0e131d] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_14px_36px_-18px_rgba(0,0,0,0.8)]";
const eyebrowClass = "mb-1 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-[#8b97ad]";
const insetPanelClass =
  "rounded-lg border border-slate-200/80 bg-slate-50/80 p-3.5 text-xs text-slate-600 dark:border-white/[0.07] dark:bg-[#07090d]/85 dark:text-[#c9d3e4]";
const pillBase =
  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-[0.14em]";

export function BoardClaimPage() {
  const queryClient = useQueryClient();
  const params = useParams();
  const [searchParams] = useSearchParams();
  const token = (params.token ?? "").trim();
  const code = (searchParams.get("code") ?? "").trim();
  const currentPath = useMemo(
    () => `/board-claim/${encodeURIComponent(token)}${code ? `?code=${encodeURIComponent(code)}` : ""}`,
    [token, code],
  );

  const sessionQuery = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });
  const statusQuery = useQuery({
    queryKey: ["board-claim", token, code],
    queryFn: () => accessApi.getBoardClaimStatus(token, code),
    enabled: token.length > 0 && code.length > 0,
    retry: false,
  });

  const claimMutation = useMutation({
    mutationFn: () => accessApi.claimBoard(token, code),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
      await queryClient.invalidateQueries({ queryKey: queryKeys.health });
      await queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      await queryClient.invalidateQueries({ queryKey: queryKeys.companies.stats });
      await statusQuery.refetch();
    },
  });

  if (!token || !code) {
    return (
      <div className="mx-auto max-w-xl px-4 py-10 tabular-nums">
        <div className={cardClass}>
          <span className={`${pillBase} border-rose-500/30 bg-rose-500/10 text-rose-700 dark:border-rose-400/30 dark:bg-rose-500/12 dark:text-rose-300`}>
            Board claim
          </span>
          <p className="mt-3 text-sm text-rose-700 dark:text-rose-300">Invalid board claim URL.</p>
        </div>
      </div>
    );
  }

  if (statusQuery.isLoading || sessionQuery.isLoading) {
    return (
      <div className="mx-auto max-w-xl px-4 py-10 tabular-nums">
        <div className={`${cardClass} flex items-center gap-2.5 text-sm text-slate-600 dark:text-[#8b97ad]`}>
          <span aria-hidden className="h-2 w-2 animate-pulse rounded-full bg-blue-500 dark:bg-[#60a5fa]" />
          Loading claim challenge...
        </div>
      </div>
    );
  }

  if (statusQuery.error) {
    return (
      <div className="mx-auto max-w-xl px-4 py-10 tabular-nums">
        <div className={cardClass}>
          <span className={`${pillBase} border-rose-500/30 bg-rose-500/10 text-rose-700 dark:border-rose-400/30 dark:bg-rose-500/12 dark:text-rose-300`}>
            Board claim
          </span>
          <h1 className="mt-3 text-lg font-semibold tracking-tight text-slate-950 dark:text-[#edf2fb]">Claim challenge unavailable</h1>
          <p className="mt-2 text-sm text-slate-600 dark:text-[#8b97ad]">
            {statusQuery.error instanceof Error ? statusQuery.error.message : "Challenge is invalid or expired."}
          </p>
        </div>
      </div>
    );
  }

  const status = statusQuery.data;
  if (!status) {
    return (
      <div className="mx-auto max-w-xl px-4 py-10 tabular-nums">
        <div className={cardClass}>
          <p className="text-sm text-rose-700 dark:text-rose-300">Claim challenge unavailable.</p>
        </div>
      </div>
    );
  }

  if (status.status === "claimed") {
    return (
      <div className="mx-auto max-w-xl px-4 py-10 tabular-nums">
        <div className={cardClass}>
          <span className={`${pillBase} border-lime-500/30 bg-lime-500/10 text-lime-700 dark:border-[#a3e635]/30 dark:bg-[#a3e635]/12 dark:text-[#a3e635]`}>
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-lime-500 shadow-[0_0_6px_rgba(163,230,53,0.75)] dark:bg-[#a3e635]" />
            Ownership transfer
          </span>
          <h1 className="mt-3 text-lg font-semibold tracking-tight text-slate-950 dark:text-[#edf2fb]">Board ownership claimed</h1>
          <p className="mt-2 text-sm text-slate-600 dark:text-[#8b97ad]">
            This instance is now linked to your authenticated user.
          </p>
          <Button
            asChild
            className="mt-5 rounded-lg bg-blue-600 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] hover:bg-blue-700 dark:bg-[#2563eb] dark:hover:bg-[#3b82f6]"
          >
            <Link to="/">Open board</Link>
          </Button>
        </div>
      </div>
    );
  }

  if (!sessionQuery.data) {
    return (
      <div className="mx-auto max-w-xl px-4 py-10 tabular-nums">
        <div className={cardClass}>
          <span className={`${pillBase} border-blue-500/25 bg-blue-500/10 text-blue-700 dark:border-[#60a5fa]/30 dark:bg-[#60a5fa]/12 dark:text-[#60a5fa]`}>
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-blue-500 dark:bg-[#60a5fa]" />
            Board claim
          </span>
          <h1 className="mt-3 text-lg font-semibold tracking-tight text-slate-950 dark:text-[#edf2fb]">Sign in required</h1>
          <p className="mt-2 text-sm text-slate-600 dark:text-[#8b97ad]">
            Sign in or create an account, then return to this page to claim Board ownership.
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

  return (
    <div className="mx-auto max-w-xl px-4 py-10 tabular-nums">
      <div className={cardClass}>
        <span className={`${pillBase} border-amber-500/30 bg-amber-500/10 text-amber-800 dark:border-[#f59e0b]/35 dark:bg-[#f59e0b]/12 dark:text-[#f59e0b]`}>
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-amber-500 shadow-[0_0_6px_rgba(245,158,11,0.65)] dark:bg-[#f59e0b]" />
          Ownership transfer
        </span>
        <h1 className="mt-3 text-xl font-semibold tracking-tight text-slate-950 dark:text-[#edf2fb]">Claim Board ownership</h1>
        <p className="mt-2 text-sm text-slate-600 dark:text-[#8b97ad]">
          This will promote your user to instance admin and migrate company ownership access from local trusted mode.
        </p>

        <div className={`mt-4 ${insetPanelClass}`}>
          <div className={eyebrowClass}>Privilege impact</div>
          <p>Your account will receive full instance-admin governance over companies, members, and runtime settings.</p>
        </div>

        {claimMutation.error && (
          <p className="mt-4 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-700 dark:border-rose-400/30 dark:bg-rose-500/12 dark:text-rose-300">
            {claimMutation.error instanceof Error ? claimMutation.error.message : "Failed to claim board ownership"}
          </p>
        )}

        <Button
          className="mt-5 rounded-lg bg-blue-600 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] hover:bg-blue-700 dark:bg-[#2563eb] dark:hover:bg-[#3b82f6]"
          onClick={() => claimMutation.mutate()}
          disabled={claimMutation.isPending}
        >
          {claimMutation.isPending ? "Claiming…" : "Claim ownership"}
        </Button>
      </div>
    </div>
  );
}
