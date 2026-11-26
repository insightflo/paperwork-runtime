import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "@/lib/router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { api } from "../api/client";
import { heartbeatsApi, type LiveRunForIssue } from "../api/heartbeats";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";

export const INSPECTOR_TABS = [
  { id: "props", label: "속성" },
  { id: "live", label: "실시간 작업" },
  { id: "subagents", label: "서브에이전트" },
  { id: "queue", label: "대기/큐" },
] as const;
export type InspectorTabId = (typeof INSPECTOR_TABS)[number]["id"];

export const LIVE_LOG_HIGHLIGHT_CAP = 200_000;
export const LIVE_LOG_TOTAL_GUARD = 1_000_000;
export const TRUNCATION_GUARD_MESSAGE = "로그가 너무 커서 마지막 200,000자만 표시합니다 (UI 보호)";

export function capLiveLogText(content: string | null | undefined): { text: string; truncated: boolean } {
  if (!content) return { text: "", truncated: false };
  const bounded = content.length > LIVE_LOG_TOTAL_GUARD ? content.slice(-LIVE_LOG_TOTAL_GUARD) : content;
  if (bounded.length <= LIVE_LOG_HIGHLIGHT_CAP) return { text: bounded, truncated: false };
  return { text: bounded.slice(-LIVE_LOG_HIGHLIGHT_CAP), truncated: true };
}

interface QueueItem {
  id: string;
  agentId?: string | null;
  status?: string | null;
  reason?: string | null;
  prompt?: string | null;
  payload?: { message?: string | null } | null;
}
export function normalizeQueuePayload(raw: unknown): QueueItem[] {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { items?: unknown[] } | null)?.items)
      ? (raw as { items: unknown[] }).items
      : Array.isArray((raw as { data?: unknown[] } | null)?.data)
        ? (raw as { data: unknown[] }).data
        : [];
  return list
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => ({
      id: String(item.id ?? ""),
      agentId: (item.agentId ?? item.agent_id ?? null) as string | null,
      status: (item.status ?? null) as string | null,
      reason: (item.reason ?? null) as string | null,
      prompt: (item.prompt ?? item.promptPreview ?? null) as string | null,
      payload: item.prompt || item.promptPreview ? null : ((item.payload ?? null) as QueueItem["payload"]),
    }))
    .filter((item) => item.id);
}

function ElapsedText({ startedAt }: { startedAt: string | null }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!startedAt) return;
    const id = setInterval(() => tick((v) => v + 1), 1000);
    return () => clearInterval(id);
  }, [startedAt]);
  if (!startedAt) return null;
  const sec = Math.max(0, Math.round((Date.now() - new Date(startedAt).getTime()) / 1000));
  return <span className="font-mono text-[10px] tabular-nums text-muted-foreground dark:text-[#8f9db3]">{sec}s</span>;
}

function LiveRunRow({ run, current }: { run: LiveRunForIssue; current?: boolean }) {
  return (
    <Link
      to={`/agents/${run.agentId}/runs/${run.id}`}
      className={cn(
        "flex items-center gap-2 border-l-2 border-l-transparent px-3 py-2 text-xs tabular-nums transition-colors no-underline text-inherit hover:bg-accent/50 dark:hover:bg-[#0e131d]",
        current && "border-lime-600 bg-accent/30 dark:border-l-[#a3e635] dark:bg-[#a3e635]/10",
      )}
    >
      <span
        data-provider={run.adapterType}
        className="h-2 w-2 rounded-full shrink-0 animate-pulse"
        style={{ backgroundColor: "var(--openbot-provider-current)" }}
      />
      <span className="flex-1 min-w-0 truncate font-medium">{run.agentName}</span>
      <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground dark:text-[#a3e635]">{run.status}</span>
      <ElapsedText startedAt={run.startedAt} />
    </Link>
  );
}

function InspectorBody(props: { companyId: string | null; issueId?: string | null; tab: InspectorTabId; panelContent?: ReactNode }) {
  const queryClient = useQueryClient();
  const liveQuery = useQuery({
    queryKey: props.companyId ? queryKeys.liveRuns(props.companyId) : ["live-runs", "none"],
    queryFn: () => heartbeatsApi.liveRunsForCompany(props.companyId!),
    enabled: Boolean(props.companyId) && (props.tab === "live" || props.tab === "subagents"),
    refetchInterval: (q) => ((q.state.data?.length ?? 0) > 0 ? 750 : false),
  });
  const activeRun = liveQuery.data?.[0] ?? null;
  const logQuery = useQuery({
    queryKey: ["inspector-run-log", activeRun?.id ?? "none"],
    queryFn: () => heartbeatsApi.log(activeRun!.id, 0, LIVE_LOG_HIGHLIGHT_CAP),
    enabled: props.tab === "live" && Boolean(activeRun),
    refetchInterval: 750,
  });
  const opsQuery = useQuery({
    queryKey: ["inspector-run-workspace-ops", activeRun?.id ?? "none"],
    queryFn: () => heartbeatsApi.workspaceOperations(activeRun!.id),
    enabled: props.tab === "live" && Boolean(activeRun),
    refetchInterval: 750,
  });
  const queueQuery = useQuery({
    queryKey: ["ops-console-queue", props.companyId ?? "none"],
    queryFn: () => api.get<unknown>(`/companies/${props.companyId}/ops-console/queue`),
    enabled: props.tab === "queue" && Boolean(props.companyId),
    refetchInterval: 10_000,
    retry: false,
  });
  const cappedLog = useMemo(() => capLiveLogText(logQuery.data?.content), [logQuery.data?.content]);
  const queueItems = useMemo(() => normalizeQueuePayload(queueQuery.data), [queueQuery.data]);

  if (props.tab === "props") {
    return props.panelContent ? (
      <div className="p-3 tabular-nums">{props.panelContent}</div>
    ) : (
      <div className="p-3">
        <p className="tactile-card dark:bg-[#0e131d] p-3 text-xs text-muted-foreground dark:text-[#8f9db3]">이 페이지에는 속성 패널 콘텐츠가 없습니다.</p>
      </div>
    );
  }

  if (props.tab === "live") {
    if (!activeRun) {
      return <div className="p-3"><p className="tactile-card dark:bg-[#0e131d] p-3 text-xs text-muted-foreground dark:text-[#8f9db3]">실행 중인 작업이 없습니다.</p></div>;
    }
    const ops = opsQuery.data ?? [];
    return (
      <div className="space-y-3 p-3 tabular-nums">
        <div className="flex items-center gap-2 text-xs font-semibold text-foreground dark:text-[#eef2f8]"><span className="pw-live-dot" />현재 실행: {activeRun.agentName}</div>
        {cappedLog.truncated && <p className="text-[11px] font-medium text-amber-700 dark:text-[#f59e0b]">{TRUNCATION_GUARD_MESSAGE}</p>}
        <pre className="tactile-card dark:bg-[#090c12] dark:text-[#c9d3e4] max-h-[50vh] overflow-y-auto overscroll-contain whitespace-pre-wrap break-all p-2 font-mono text-[11px] tabular-nums">
          {logQuery.isLoading ? "로그 불러오는 중…" : cappedLog.text || "(stdout 없음)"}
        </pre>
        {ops.length > 0 && (
          <div className="tactile-card dark:bg-[#0e131d] space-y-1 p-2">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground dark:text-[#8f9db3]">파일 변경</div>
            {ops.slice(0, 8).map((op) => (
              <div key={op.id} className="truncate font-mono text-[11px] tabular-nums text-muted-foreground dark:text-[#9aa7bd]">{op.phase}: {op.command ?? op.cwd ?? op.id}</div>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (props.tab === "subagents") {
    const runs = (liveQuery.data ?? []).filter((r) => !props.issueId || r.issueId === props.issueId || r.issueId == null);
    if (runs.length === 0) {
      return <div className="p-3"><p className="tactile-card dark:bg-[#0e131d] p-3 text-xs text-muted-foreground dark:text-[#8f9db3]">활성 서브에이전트 실행이 없습니다.</p></div>;
    }
    return <div className="divide-y divide-border dark:divide-white/[0.06]">{runs.map((run) => <LiveRunRow key={run.id} run={run} />)}</div>;
  }

  if (queueQuery.isError) {
    return (
      <div className="p-3">
        <p className="tactile-card dark:bg-[#0e131d] p-3 text-xs text-muted-foreground dark:text-[#8f9db3]">
          큐 엔드포인트에 연결할 수 없습니다 (백엔드 ops-console 미배포 시 정상).
        </p>
      </div>
    );
  }
  if (queueItems.length === 0) {
    return <div className="p-3"><p className="tactile-card dark:bg-[#0e131d] p-3 text-xs text-muted-foreground dark:text-[#8f9db3]">대기 중인 큐 항목이 없습니다.</p></div>;
  }
  return (
    <div className="divide-y divide-border dark:divide-white/[0.06]">
      {queueItems.map((item) => (
        <div key={item.id} className="flex items-center gap-2 px-3 py-2 text-xs tabular-nums transition-colors hover:bg-accent/40 dark:hover:bg-[#0e131d]">
          <span className="flex-1 min-w-0 truncate">{item.payload?.message ?? item.prompt ?? item.reason ?? item.id}</span>
          <span className="shrink-0 font-mono text-[10px] uppercase tracking-wide text-muted-foreground dark:text-[#f59e0b]">{item.status ?? "queued"}</span>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[11px] text-destructive"
            onClick={async () => {
              try {
                await api.post(`/companies/${props.companyId}/ops-console/queue/${item.id}/cancel`, {});
                queryClient.invalidateQueries({ queryKey: ["ops-console-queue", props.companyId] });
              } catch {
                // Keep item visible if cancel fails.
              }
            }}
          >
            취소
          </Button>
        </div>
      ))}
    </div>
  );
}

export function InspectorSidePanel(props: {
  companyId: string | null;
  issueId?: string | null;
  panelContent?: ReactNode;
  onClose?: () => void;
}) {
  const [tab, setTab] = useState<InspectorTabId>(props.panelContent ? "props" : "live");
  useEffect(() => {
    if (props.panelContent) setTab("props");
  }, [props.panelContent]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground tabular-nums dark:bg-[#090c12] dark:text-[#eef2f8]" style={{ width: "var(--openbot-inspector-width)" }}>
      <div className="flex shrink-0 items-center justify-between border-b border-border/80 bg-background/80 px-2 py-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] dark:border-white/[0.065] dark:bg-[#0e131d] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07)]">
        <div className="flex items-center gap-1">
          {INSPECTOR_TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              aria-pressed={tab === t.id}
              className={cn(
                "rounded-md border px-2 py-1 font-mono text-[10px] font-semibold uppercase tracking-wide transition-colors",
                tab === t.id
                  ? "border-blue-500/30 bg-blue-500/10 text-blue-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.55)] dark:border-[#60a5fa]/30 dark:bg-[#60a5fa]/12 dark:text-[#60a5fa] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]"
                  : "border-transparent text-muted-foreground hover:border-border hover:text-foreground dark:text-[#8f9db3] dark:hover:border-white/[0.08] dark:hover:text-[#eef2f8]",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
        {props.onClose && (
          <Button variant="ghost" size="icon-xs" onClick={props.onClose} aria-label="인스펙터 닫기" className="text-muted-foreground hover:text-foreground dark:text-[#8f9db3] dark:hover:bg-white/[0.06] dark:hover:text-[#eef2f8]">
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>
      <ScrollArea className="flex-1 min-h-0">
        <InspectorBody companyId={props.companyId} issueId={props.issueId} tab={tab} panelContent={props.panelContent} />
      </ScrollArea>
    </div>
  );
}
