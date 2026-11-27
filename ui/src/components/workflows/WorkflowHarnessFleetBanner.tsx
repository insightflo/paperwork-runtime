import { cn } from "@/lib/utils";
import { type WorkflowHarnessFleetSummaryCardProps, WorkflowHarnessFleetSummaryCard } from "./WorkflowHarnessFleetSummaryCard";

/** Fleet counters handed to `WorkflowHarnessFleetSummaryCard`. */
export type WorkflowHarnessFleet = WorkflowHarnessFleetSummaryCardProps;

/**
 * One of four mutually exclusive states:
 * - `loading`: an explicit skeleton is shown; nothing is delegated.
 * - `error`: the failure is always surfaced; a stale `fleet` (if any) is still delegated below the notice.
 * - `ready`: an empty fleet renders compact copy, a populated one is delegated to the summary card.
 */
export type WorkflowHarnessFleetBannerProps =
  | { readonly status: "loading"; readonly className?: string }
  | {
      readonly status: "error";
      readonly error: unknown;
      readonly fleet?: WorkflowHarnessFleet | null;
      readonly className?: string;
    }
  | { readonly status: "ready"; readonly fleet: WorkflowHarnessFleet; readonly className?: string };

export const FLEET_EMPTY_COPY = "실행 중인 워크플로 하네스 없음";
export const FLEET_ERROR_LABEL = "하네스 플릿 조회 실패";

type FleetState = "loading" | "error" | "empty" | "populated";

const SKELETON_BAR = "animate-pulse rounded-md bg-slate-200/90 dark:bg-white/[0.08]";

/** Never returns an empty string so the notice always carries a readable detail. */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message.trim() || "원인 메시지 없음";
  if (typeof error === "string") return error.trim() || "원인 메시지 없음";
  if (error === null || error === undefined) return "원인 메시지 없음";
  try {
    return String(error) || "원인 메시지 없음";
  } catch {
    return "원인 메시지 없음";
  }
}

function LoadingSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="하네스 플릿 불러오는 중" className="flex flex-wrap items-center gap-2">
      <span className={cn(SKELETON_BAR, "h-4 w-24")} />
      <span className={cn(SKELETON_BAR, "h-5 w-16")} />
      <span className={cn(SKELETON_BAR, "h-5 w-16")} />
      <span className={cn(SKELETON_BAR, "h-5 w-20")} />
    </div>
  );
}

function ErrorNotice({ message }: { readonly message: string }) {
  return (
    <div
      role="alert"
      className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 rounded-[12px] border border-red-600/30 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-400/40 dark:bg-red-500/10 dark:text-red-300"
    >
      <span className="font-semibold">{FLEET_ERROR_LABEL}</span>
      <span className="min-w-0 break-words">{message}</span>
    </div>
  );
}

function resolveState(props: WorkflowHarnessFleetBannerProps): { readonly state: FleetState; readonly fleet: WorkflowHarnessFleet | null } {
  if (props.status === "loading") return { state: "loading", fleet: null };
  if (props.status === "error") return { state: "error", fleet: props.fleet ?? null };
  return { state: props.fleet.totalRuns === 0 ? "empty" : "populated", fleet: props.fleet };
}

/**
 * Container for the workflow harness fleet summary. Every API outcome maps to a visible
 * state; errors are rendered as a notice instead of being swallowed into an empty view.
 */
export function WorkflowHarnessFleetBanner(props: WorkflowHarnessFleetBannerProps) {
  const { state, fleet } = resolveState(props);

  return (
    <section
      aria-label="워크플로 하네스 플릿"
      data-fleet-state={state}
      className={cn("flex min-w-0 flex-col gap-2", props.className)}
    >
      {state === "loading" ? <LoadingSkeleton /> : null}
      {state === "error" ? <ErrorNotice message={describeError(props.status === "error" ? props.error : null)} /> : null}
      {state === "empty" ? (
        <p className="rounded-[12px] border border-slate-200/90 px-3 py-2 text-xs text-slate-500 dark:border-white/[0.08] dark:text-[#8f9db3]">
          {FLEET_EMPTY_COPY}
        </p>
      ) : null}
      {state === "error" || state === "populated" ? (
        fleet ? <WorkflowHarnessFleetSummaryCard {...fleet} /> : null
      ) : null}
    </section>
  );
}
