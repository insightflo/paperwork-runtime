/**
 * Canonical status & priority color definitions.
 *
 * Every component that renders a status indicator (StatusIcon, StatusBadge,
 * agent status dots, etc.) should import from here so colors stay consistent.
 */

// ---------------------------------------------------------------------------
// Issue status colors
// ---------------------------------------------------------------------------

/** StatusIcon circle: text + border classes */
export const issueStatusIcon: Record<string, string> = {
  backlog: "text-muted-foreground border-muted-foreground",
  todo: "text-blue-600 border-blue-600 dark:text-blue-400 dark:border-blue-400",
  in_progress: "text-yellow-600 border-yellow-600 dark:text-yellow-400 dark:border-yellow-400",
  in_review: "text-violet-600 border-violet-600 dark:text-violet-400 dark:border-violet-400",
  done: "text-green-600 border-green-600 dark:text-green-400 dark:border-green-400",
  cancelled: "text-neutral-500 border-neutral-500",
  blocked: "text-red-600 border-red-600 dark:text-red-400 dark:border-red-400",
};

export const issueStatusIconDefault = "text-muted-foreground border-muted-foreground";

/** Text-only color for issue statuses (dropdowns, labels) */
export const issueStatusText: Record<string, string> = {
  backlog: "text-muted-foreground",
  todo: "text-blue-600 dark:text-blue-400",
  in_progress: "text-yellow-600 dark:text-yellow-400",
  in_review: "text-violet-600 dark:text-violet-400",
  done: "text-green-600 dark:text-green-400",
  cancelled: "text-neutral-500",
  blocked: "text-red-600 dark:text-red-400",
};

export const issueStatusTextDefault = "text-muted-foreground";

export const statusLabel: Record<string, string> = {
  active: "활성",
  running: "실행 중",
  paused: "일시정지",
  idle: "대기",
  archived: "보관됨",
  planned: "계획됨",
  planning: "계획 중",
  achieved: "달성",
  completed: "완료",
  succeeded: "성공",
  failed: "실패",
  timed_out: "시간 초과",
  error: "오류",
  terminated: "종료됨",
  pending: "대기 중",
  queued: "실행 대기",
  pending_approval: "승인 대기",
  revision_requested: "수정 요청",
  approved: "승인됨",
  rejected: "반려됨",
  backlog: "대기열",
  todo: "예정",
  in_progress: "진행 중",
  in_review: "검토 중",
  blocked: "차단됨",
  done: "완료",
  cancelled: "취소됨",
  open: "열림",
  decided: "결정됨",
};

export function formatStatusLabel(status: string): string {
  return statusLabel[status] ?? status.replace(/_/g, " ");
}

// ---------------------------------------------------------------------------
// Badge colors — used by StatusBadge for all entity types
// ---------------------------------------------------------------------------

export const statusBadge: Record<string, string> = {
  // Agent statuses
  active: "border-green-500/20 bg-green-500/10 text-green-700 dark:border-green-400/25 dark:bg-green-400/15 dark:text-green-300",
  running: "border-cyan-500/20 bg-cyan-500/10 text-cyan-700 dark:border-cyan-400/25 dark:bg-cyan-400/15 dark:text-cyan-300",
  paused: "border-orange-500/20 bg-orange-500/10 text-orange-700 dark:border-orange-400/25 dark:bg-orange-400/15 dark:text-orange-300",
  idle: "border-yellow-500/20 bg-yellow-500/10 text-yellow-700 dark:border-yellow-400/25 dark:bg-yellow-400/15 dark:text-yellow-300",
  archived: "border-border bg-muted text-muted-foreground",

  // Goal statuses
  planned: "border-border bg-muted text-muted-foreground",
  achieved: "border-green-500/20 bg-green-500/10 text-green-700 dark:border-green-400/25 dark:bg-green-400/15 dark:text-green-300",
  completed: "border-green-500/20 bg-green-500/10 text-green-700 dark:border-green-400/25 dark:bg-green-400/15 dark:text-green-300",

  // Run statuses
  failed: "border-red-500/20 bg-red-500/10 text-red-700 dark:border-red-400/25 dark:bg-red-400/15 dark:text-red-300",
  timed_out: "border-orange-500/20 bg-orange-500/10 text-orange-700 dark:border-orange-400/25 dark:bg-orange-400/15 dark:text-orange-300",
  succeeded: "border-green-500/20 bg-green-500/10 text-green-700 dark:border-green-400/25 dark:bg-green-400/15 dark:text-green-300",
  error: "border-red-500/20 bg-red-500/10 text-red-700 dark:border-red-400/25 dark:bg-red-400/15 dark:text-red-300",
  terminated: "border-red-500/20 bg-red-500/10 text-red-700 dark:border-red-400/25 dark:bg-red-400/15 dark:text-red-300",
  pending: "border-yellow-500/20 bg-yellow-500/10 text-yellow-700 dark:border-yellow-400/25 dark:bg-yellow-400/15 dark:text-yellow-300",
  queued: "border-yellow-500/20 bg-yellow-500/10 text-yellow-700 dark:border-yellow-400/25 dark:bg-yellow-400/15 dark:text-yellow-300",

  // Approval statuses
  pending_approval: "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:border-amber-400/25 dark:bg-amber-400/15 dark:text-amber-300",
  revision_requested: "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:border-amber-400/25 dark:bg-amber-400/15 dark:text-amber-300",
  approved: "border-green-500/20 bg-green-500/10 text-green-700 dark:border-green-400/25 dark:bg-green-400/15 dark:text-green-300",
  rejected: "border-red-500/20 bg-red-500/10 text-red-700 dark:border-red-400/25 dark:bg-red-400/15 dark:text-red-300",

  // Issue statuses — consistent hues with issueStatusIcon above
  backlog: "border-border bg-muted text-muted-foreground",
  todo: "border-blue-500/20 bg-blue-500/10 text-blue-700 dark:border-blue-400/25 dark:bg-blue-400/15 dark:text-blue-300",
  in_progress: "border-yellow-500/20 bg-yellow-500/10 text-yellow-700 dark:border-yellow-400/25 dark:bg-yellow-400/15 dark:text-yellow-300",
  in_review: "border-violet-500/20 bg-violet-500/10 text-violet-700 dark:border-violet-400/25 dark:bg-violet-400/15 dark:text-violet-300",
  blocked: "border-red-500/20 bg-red-500/10 text-red-700 dark:border-red-400/25 dark:bg-red-400/15 dark:text-red-300",
  done: "border-green-500/20 bg-green-500/10 text-green-700 dark:border-green-400/25 dark:bg-green-400/15 dark:text-green-300",
  cancelled: "border-border bg-muted text-muted-foreground",

  // Mission statuses
  planning: "border-blue-500/20 bg-blue-500/10 text-blue-700 dark:border-blue-400/25 dark:bg-blue-400/15 dark:text-blue-300",

  // Huddle statuses
  open: "border-cyan-500/20 bg-cyan-500/10 text-cyan-700 dark:border-cyan-400/25 dark:bg-cyan-400/15 dark:text-cyan-300",
  decided: "border-green-500/20 bg-green-500/10 text-green-700 dark:border-green-400/25 dark:bg-green-400/15 dark:text-green-300",
};

export const statusBadgeDefault = "border-border bg-muted text-muted-foreground";

// ---------------------------------------------------------------------------
// Agent status dot — solid background for small indicator dots
// ---------------------------------------------------------------------------

export const agentStatusDot: Record<string, string> = {
  running: "bg-cyan-400 animate-pulse",
  active: "bg-green-400",
  paused: "bg-yellow-400",
  idle: "bg-yellow-400",
  pending_approval: "bg-amber-400",
  error: "bg-red-400",
  archived: "bg-neutral-400",
};

export const agentStatusDotDefault = "bg-neutral-400";

// ---------------------------------------------------------------------------
// Priority colors
// ---------------------------------------------------------------------------

export const priorityColor: Record<string, string> = {
  critical: "text-red-600 dark:text-red-400",
  high: "text-orange-600 dark:text-orange-400",
  medium: "text-yellow-600 dark:text-yellow-400",
  low: "text-blue-600 dark:text-blue-400",
};

export const priorityColorDefault = "text-yellow-600 dark:text-yellow-400";
