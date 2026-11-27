// ui/src/components/workflows/WorkflowDispatchRouteBadge.tsx
//
// [파일 목적] 워크플로 디스패치 경로(probability-gated route) 배지 (읽기 전용 프리젠테이션).
//   sharp / split / escalate / escalate_advisor 네 경로를 Tactile Cockpit 색조의 상태 pill로 보여준다.
//   색에만 의존하지 않도록 항상 코드 + 한글 라벨 텍스트를 함께 노출한다.
// [연결] mount: (미사용 — 재사용 가능). 소비자가 run/step의 route 값을 props로 주입한다.
import { cn } from "../../lib/utils";

export type WorkflowDispatchRoute = "sharp" | "split" | "escalate" | "escalate_advisor";

export interface WorkflowDispatchRouteBadgeProps {
  route: WorkflowDispatchRoute;
  /** 코드(SHARP 등)만 보여주고 한글 라벨은 aria-label/title로만 유지한다. */
  compact?: boolean;
  className?: string;
}

interface RouteStyle {
  code: string;
  label: string;
  pill: string;
  dot: string;
}

const ROUTE: Record<WorkflowDispatchRoute, RouteStyle> = {
  sharp: {
    code: "SHARP",
    label: "빠른 통과",
    pill: "border-lime-600/25 bg-lime-500/10 text-lime-800 dark:border-[#a3e635]/30 dark:bg-[#a3e635]/10 dark:text-[#a3e635]",
    dot: "bg-lime-600 dark:bg-[#a3e635]",
  },
  split: {
    code: "SPLIT",
    label: "분할 검증",
    pill: "border-blue-600/25 bg-blue-500/10 text-blue-800 dark:border-[#60a5fa]/30 dark:bg-[#60a5fa]/10 dark:text-[#60a5fa]",
    dot: "bg-blue-600 dark:bg-[#60a5fa]",
  },
  escalate: {
    code: "ESCALATE",
    label: "자문 승격",
    pill: "border-amber-600/25 bg-amber-500/10 text-amber-800 dark:border-[#fbbf24]/30 dark:bg-[#fbbf24]/10 dark:text-[#fbbf24]",
    dot: "bg-amber-600 dark:bg-[#fbbf24]",
  },
  escalate_advisor: {
    code: "ESCALATE ADVISOR",
    label: "자문 지정 승격",
    pill: "border-violet-600/25 bg-violet-500/10 text-violet-800 dark:border-[#c4b5fd]/30 dark:bg-[#c4b5fd]/10 dark:text-[#c4b5fd]",
    dot: "bg-violet-600 dark:bg-[#c4b5fd]",
  },
};

const PILL =
  "inline-flex max-w-full items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold leading-none tracking-wide whitespace-nowrap tabular-nums";
const DOT = "h-1.5 w-1.5 shrink-0 rounded-full";

export function WorkflowDispatchRouteBadge({ route, compact = false, className }: WorkflowDispatchRouteBadgeProps) {
  const style = ROUTE[route];
  const fullLabel = `${style.code} · ${style.label}`;

  return (
    <span
      role="status"
      aria-label={`Dispatch route: ${fullLabel}`}
      title={fullLabel}
      data-route={route}
      className={cn(PILL, style.pill, className)}
    >
      <span aria-hidden className={cn(DOT, style.dot)} />
      {compact ? style.code : fullLabel}
    </span>
  );
}
