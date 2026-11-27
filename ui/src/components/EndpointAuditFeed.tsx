import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

export interface EndpointAuditItem {
  id: string;
  botName: string;
  kind: "read_file" | "write_file" | "list_dir" | "shell_exec";
  targetPath: string;
  outcome: "enqueued" | "completed" | "failed" | "denied";
  summary: string;
  createdAt: string;
}

interface EndpointAuditFeedProps {
  items: EndpointAuditItem[];
  maxItems?: number;
  className?: string;
}

const kindLabels: Record<EndpointAuditItem["kind"], string> = {
  read_file: "파일 읽기",
  write_file: "파일 쓰기",
  list_dir: "폴더 목록",
  shell_exec: "명령 실행",
};

const outcomes: Record<EndpointAuditItem["outcome"], { label: string; className: string }> = {
  enqueued: {
    label: "대기 중",
    className: "bg-muted text-muted-foreground",
  },
  completed: {
    label: "완료",
    className: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  },
  failed: {
    label: "실패",
    className: "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300",
  },
  denied: {
    label: "정책 차단",
    className: "bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  },
};

/** Displays supplied audit records in their original order; performs no local actions. */
export function EndpointAuditFeed({ items, maxItems = 20, className }: EndpointAuditFeedProps) {
  if (items.length === 0) {
    return (
      <div className={cn("rounded-lg border border-dashed p-6 text-center", className)}>
        <p className="text-sm text-muted-foreground">최근 단말 로컬 작업 기록이 없습니다</p>
      </div>
    );
  }

  return (
    <ul
      role="list"
      aria-label="최근 단말 로컬 작업 기록"
      className={cn("m-0 list-none divide-y rounded-lg border p-0", className)}
    >
      {items.slice(0, Math.max(0, maxItems)).map((item) => (
        <li key={item.id} role="listitem" className="space-y-2 px-4 py-3">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Badge variant="outline" className={outcomes[item.outcome].className}>
              {outcomes[item.outcome].label}
            </Badge>
            <span className="font-medium">{kindLabels[item.kind]}</span>
            <span className="break-all text-muted-foreground">{item.botName}</span>
          </div>
          <code className="block break-all font-mono text-xs">{item.targetPath}</code>
          <p className="break-words text-sm">{item.summary}</p>
          <time dateTime={item.createdAt} className="block text-xs text-muted-foreground">
            {new Date(item.createdAt).toLocaleString("ko-KR")}
          </time>
        </li>
      ))}
    </ul>
  );
}
