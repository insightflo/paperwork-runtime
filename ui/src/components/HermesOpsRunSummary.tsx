// ui/src/components/HermesOpsRunSummary.tsx
//
// [파일 목적] Hermes Ops run(chat-sidebar / chat-telegram / monitor)을 열었을 때
//   operator question · compact recovery evidence · final answer · raw-log 안내를
//   한 화면에서 읽히는 dense operational summary로 렌더.
// [주요 흐름] run.resultJson.hermesRunKind가 없으면 null(비-hermes run엔 미출력).
//   advice는 nested resultJson.recoveryAdvice에서만 읽는다(top-level decision 금지 invariant).
// [외부 연결] AgentDetail.tsx가 run을 넘겨줌. 기존 transcript/raw-log 접근은 보존(이 컴포넌트는 요약만).
import { cn } from "../lib/utils";

type HermesRun = {
  id?: string;
  resultJson?: unknown;
  contextSnapshot?: unknown;
  logRef?: string | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

const KIND_LABEL: Record<string, string> = {
  "chat-sidebar": "Chat - sidebar",
  "chat-telegram": "Chat - Telegram",
  monitor: "Monitor sweep",
};

const KIND_TONE: Record<string, string> = {
  "chat-sidebar": "border-blue-500/25 bg-blue-500/10 text-blue-700 dark:border-[#60a5fa]/35 dark:bg-[#60a5fa]/12 dark:text-[#60a5fa]",
  "chat-telegram": "border-lime-600/25 bg-lime-500/10 text-lime-700 dark:border-[#a3e635]/35 dark:bg-[#a3e635]/12 dark:text-[#a3e635]",
  monitor: "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:border-[#f59e0b]/35 dark:bg-[#f59e0b]/12 dark:text-[#f59e0b]",
};

export function HermesOpsRunSummary({ run }: { run: HermesRun }) {
  const result = asRecord(run.resultJson);
  const kind = asString(result?.hermesRunKind);
  if (!kind) return null; // 비-hermes run — 출력 없음

  const advice = asRecord(result?.recoveryAdvice);
  const context = asRecord(run.contextSnapshot);
  const chat = asRecord(context?.paperclipHermesChat);
  const question = asString(chat?.currentMessage);
  const answer = asString(result?.result);

  const decision = asString(advice?.decision);
  const target = asRecord(advice?.targetIssue);
  const targetIdentifier = asString(target?.identifier) ?? asString(target?.id);
  const targetRole = asString(target?.role);
  const targetTitle = asString(target?.title);
  const targetAction = asString(advice?.targetAction);
  const leafCause = asString(advice?.leafCause);
  const operatorComment = asString(advice?.operatorComment);
  const evidence = Array.isArray(advice?.evidence)
    ? (advice.evidence as unknown[]).filter((e) => typeof e === "object" && e !== null)
    : [];
  const doNot = Array.isArray(advice?.doNot) ? (advice.doNot as unknown[]).filter((e) => typeof e === "string") : [];
  const missing = Array.isArray(advice?.missingEvidence)
    ? (advice.missingEvidence as unknown[]).filter((e) => typeof e === "string")
    : [];

  return (
    <div className="tactile-card rounded-[12px] border-slate-200/90 bg-white p-3 text-slate-900 tabular-nums shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_10px_28px_rgba(15,23,42,0.10)] dark:border-white/[0.08] dark:bg-[#0e131d] dark:text-slate-100 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_10px_28px_rgba(0,0,0,0.42)] sm:p-4 space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.12em]",
              KIND_TONE[kind] ?? "border-slate-200/90 bg-slate-100 text-slate-600 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-slate-400",
            )}
          >
            Hermes Ops - {KIND_LABEL[kind] ?? kind}
          </span>
          {decision && (
            <span className="font-mono text-[11px] text-slate-500 tabular-nums dark:text-[#8f9db3]">
              decision={decision}
            </span>
          )}
        </div>
        {run.id && run.logRef ? (
          <a
            href={`/api/heartbeat-runs/${run.id}/log?offset=0&limitBytes=256000`}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-[11px] font-semibold text-blue-700 transition-colors hover:text-blue-800 hover:underline dark:text-[#60a5fa] dark:hover:text-[#93c5fd]"
          >
            raw log
          </a>
        ) : null}
      </div>

      {question && (
        <div className="text-xs">
          <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-blue-700 dark:text-[#60a5fa]">Q </span>
          <span className="text-slate-800 dark:text-slate-100">{question}</span>
        </div>
      )}

      {advice && (
        <div className="rounded-[10px] border border-slate-200/80 bg-slate-50/75 p-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] dark:border-white/[0.07] dark:bg-[#090c12] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] space-y-1.5">
          {targetIdentifier && (
            <div className="text-xs">
              <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-[#8f9db3]">Target </span>
              <span className="font-medium text-slate-900 dark:text-slate-100">
                {targetIdentifier}
                {targetRole ? <span className="text-slate-500 dark:text-[#8f9db3]"> ({targetRole})</span> : null}
              </span>
              {targetAction ? <span className="text-slate-500 dark:text-[#8f9db3]"> · action: {targetAction}</span> : null}
              {targetTitle ? <span className="text-slate-500 dark:text-[#8f9db3]"> · {targetTitle}</span> : null}
            </div>
          )}
          {leafCause && (
            <div className="text-xs text-slate-800 dark:text-slate-200">
              <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-[#8f9db3]">Leaf cause </span>
              {leafCause}
            </div>
          )}
          {evidence.length > 0 && (
            <ul className="list-disc pl-4 text-xs text-slate-500 marker:text-blue-500 dark:text-slate-400 dark:marker:text-[#60a5fa] space-y-0.5">
              {evidence.slice(0, 4).map((e, i) => {
                const rec = e as Record<string, unknown>;
                const label = asString(rec.label) ?? "evidence";
                const value = asString(rec.value);
                return <li key={i}>{value ? `${label}: ${value}` : label}</li>;
              })}
            </ul>
          )}
          {operatorComment && (
            <pre className="whitespace-pre-wrap rounded-md border border-slate-200/70 bg-white/80 p-2 font-mono text-xs tabular-nums text-slate-800 dark:border-white/[0.07] dark:bg-[#0e131d] dark:text-slate-200">
              {operatorComment}
            </pre>
          )}
          {doNot.length > 0 && (
            <div className="text-xs font-medium text-rose-700 dark:text-[#f43f5e]">
              <span className="font-medium">Do NOT: </span>
              {(doNot as string[]).slice(0, 3).join(" / ")}
            </div>
          )}
          {missing.length > 0 && (
            <div className="text-xs text-amber-700 dark:text-[#f59e0b]">
              <span className="font-medium">Missing evidence: </span>
              {(missing as string[]).slice(0, 3).join(" / ")}
            </div>
          )}
        </div>
      )}

      {answer && (
        <div className="text-xs">
          <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-lime-700 dark:text-[#a3e635]">A </span>
          <span className="text-slate-800 dark:text-slate-100">{answer.length > 280 ? `${answer.slice(0, 280)}...` : answer}</span>
        </div>
      )}
    </div>
  );
}
