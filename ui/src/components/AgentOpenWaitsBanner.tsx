// [purpose] 에이전트에 열려 있는 대기(보류된 질문 · 외부 승인 · 차단된 인계)를 한 장의 카드로
//   보여주고, 각 항목을 "해결 완료" 1클릭으로 처리할 수 있게 하는 재사용 배너다.
//   대기가 없으면 아무 것도 렌더링하지 않아 화면을 깔끔하게 유지한다.
export type AgentOpenWaitKind = "pending-question" | "external-approval" | "blocked-handoff";

export interface AgentOpenWaitItem {
  id: string;
  kind: AgentOpenWaitKind;
  summary: string;
  createdAt: string;
  expiresAt?: string;
  targetLabel?: string;
}

const KIND_LABELS: Record<AgentOpenWaitKind, string> = {
  "pending-question": "질문 대기",
  "external-approval": "외부 승인",
  "blocked-handoff": "인계 차단",
};

const KIND_PILL_CLASS: Record<AgentOpenWaitKind, string> = {
  "pending-question":
    "border-amber-300/70 bg-amber-50 text-amber-700 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-300",
  "external-approval":
    "border-sky-300/70 bg-sky-50 text-sky-700 dark:border-sky-400/30 dark:bg-sky-400/10 dark:text-sky-300",
  "blocked-handoff":
    "border-rose-300/70 bg-rose-50 text-rose-700 dark:border-rose-400/30 dark:bg-rose-400/10 dark:text-rose-300",
};

const CARD_CLASS =
  "rounded-xl border border-amber-200/80 bg-white/90 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)] " +
  "dark:border-amber-400/20 dark:bg-[#0b0f18] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]";

const ROW_CLASS =
  "flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-slate-200/90 bg-white/85 px-2.5 py-2 " +
  "dark:border-white/[0.08] dark:bg-[#07090d]";

export function AgentOpenWaitsBanner({
  waits,
  onResolve,
  resolvingId,
  className,
}: {
  waits: AgentOpenWaitItem[];
  onResolve?: (waitId: string) => void | Promise<void>;
  resolvingId?: string | null;
  className?: string;
}) {
  if (waits.length === 0) {
    return null;
  }

  return (
    <section
      role="region"
      aria-label="대기 중인 요청"
      className={`${CARD_CLASS} p-3${className ? ` ${className}` : ""}`}
    >
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center rounded-full border border-amber-300/80 bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800 tabular-nums dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-300">
          대기 중인 요청 {waits.length}건
        </span>
      </div>
      <ul className="mt-2 flex flex-col gap-1.5">
        {waits.map((wait) => {
          const resolving = resolvingId === wait.id;
          return (
            <li key={wait.id} className={ROW_CLASS}>
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-800 dark:text-[#edf2fb]">
                {wait.summary}
              </span>
              {wait.targetLabel ? (
                <span
                  className="max-w-[14rem] shrink-0 truncate rounded-md border border-slate-200 bg-slate-50 px-1.5 py-0.5 font-mono text-xs text-slate-600 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-slate-300"
                  title={wait.targetLabel}
                >
                  {wait.targetLabel}
                </span>
              ) : null}
              <span
                className={`shrink-0 rounded-full border px-1.5 py-0.5 text-xs font-medium ${KIND_PILL_CLASS[wait.kind]}`}
              >
                {KIND_LABELS[wait.kind]}
              </span>
              <button
                type="button"
                disabled={resolving}
                onClick={() => void onResolve?.(wait.id)}
                className={
                  "shrink-0 rounded-md border px-2 py-1 text-xs font-semibold transition-colors disabled:cursor-wait disabled:opacity-60 " +
                  (resolving
                    ? "border-slate-300 bg-slate-100 text-slate-500 dark:border-white/[0.08] dark:bg-white/[0.06] dark:text-slate-400"
                    : "border-amber-300/80 bg-amber-100 text-amber-800 hover:bg-amber-200/70 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-300 dark:hover:bg-amber-400/20")
                }
              >
                {resolving ? "해결 중…" : "해결 완료"}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
