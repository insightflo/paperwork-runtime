import { useCallback, useMemo, useState, type DragEvent, type KeyboardEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { GripVertical, Send, X } from "lucide-react";
import { api } from "../api/client";
import { agentsApi } from "../api/agents";
import { issuesApi } from "../api/issues";
import { Button } from "@/components/ui/button";
import { cn } from "../lib/utils";

export interface QueuedWakeupItem {
  id: string;
  agentId?: string | null;
  status?: string | null;
  reason?: string | null;
  prompt?: string | null;
  payload?: { message?: string | null } | null;
}

/** Accepts array, {items}, or {data} envelopes from the ops-console queue endpoint. */
export function normalizeQueueItems(raw: unknown): QueuedWakeupItem[] {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { items?: unknown[] } | null)?.items)
      ? (raw as { items: unknown[] }).items
      : Array.isArray((raw as { data?: unknown[] } | null)?.data)
        ? (raw as { data: unknown[] }).data
        : [];
  return list
    .filter((i): i is Record<string, unknown> => typeof i === "object" && i !== null)
    .map((i) => ({
      id: String(i.id ?? ""),
      agentId: (i.agentId ?? i.agent_id ?? null) as string | null,
      status: (i.status ?? null) as string | null,
      reason: (i.reason ?? null) as string | null,
      prompt: (i.prompt ?? i.promptPreview ?? null) as string | null,
      payload: (i.payload ?? null) as QueuedWakeupItem["payload"],
    }))
    .filter((i) => i.id);
}

/** Pure index move used by both drag-drop and Alt+Arrow reordering. */
export function reorderQueueItems<T>(items: T[], fromIndex: number, toIndex: number): T[] {
  if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= items.length || toIndex >= items.length) {
    return items;
  }
  const next = items.slice();
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved as T);
  return next;
}

export function queueItemLabel(item: QueuedWakeupItem): string {
  return item.payload?.message ?? item.prompt ?? item.reason ?? item.id;
}

export function QueuePanel(props: {
  companyId: string | null;
  agentId?: string | null;
  pendingModel?: string | null;
  steerSupported?: boolean;
  items?: QueuedWakeupItem[];
  onReorder?: (orderedIds: string[]) => void;
}) {
  const queryClient = useQueryClient();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [steerText, setSteerText] = useState("");
  const [steerApplied, setSteerApplied] = useState(false);
  const dragIndex = { current: -1 } as { current: number };
  const [, force] = useState(0);
  const dragRef = dragIndex;

  const query = useQuery({
    queryKey: ["ops-console-queue", props.companyId ?? "none"],
    queryFn: () => api.get<unknown>(`/companies/${props.companyId}/ops-console/queue`),
    enabled: Boolean(props.companyId) && props.items === undefined,
    refetchInterval: 10_000,
    retry: false,
  });
  const items = useMemo(
    () => props.items ?? normalizeQueueItems(query.data),
    [props.items, query.data],
  );
  const scopedItems = useMemo(
    () => (props.agentId ? items.filter((i) => !i.agentId || i.agentId === props.agentId) : items),
    [items, props.agentId],
  );

  const invalidate = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ["ops-console-queue", props.companyId] }),
    [queryClient, props.companyId],
  );

  const persistOrder = useCallback(
    async (ordered: QueuedWakeupItem[]) => {
      const ids = ordered.map((i) => i.id);
      props.onReorder?.(ids);
      if (!props.companyId) return;
      try {
        await api.post(`/companies/${props.companyId}/ops-console/queue/reorder`, { orderedIds: ids });
      } catch { /* backend may not be deployed yet */ }
      invalidate();
    },
    [props, invalidate],
  );

  const move = useCallback(
    (from: number, to: number) => persistOrder(reorderQueueItems(scopedItems, from, to)),
    [persistOrder, scopedItems],
  );

  const cancel = useCallback(
    async (id: string) => {
      if (!props.companyId) return;
      try {
        await api.post(`/companies/${props.companyId}/ops-console/queue/${id}/cancel`, {});
        invalidate();
      } catch { /* noop */ }
    },
    [props.companyId, invalidate],
  );

  const saveEdit = useCallback(
    async (id: string) => {
      if (!props.companyId || !editText.trim()) return;
      try {
        await api.patch(`/companies/${props.companyId}/ops-console/queue/${id}`, { prompt: editText.trim() });
        setEditingId(null);
        invalidate();
      } catch { /* noop */ }
    },
    [props.companyId, editText, invalidate],
  );

  const splitAsTask = useCallback(
    async (item: QueuedWakeupItem) => {
      if (!props.companyId || !props.agentId) return;
      const title = queueItemLabel(item).slice(0, 120);
      try {
        await issuesApi.create(props.companyId, {
          title: title || "대기 작업 분리",
          description: `큐 항목에서 분리됨:\n\n${queueItemLabel(item)}`,
          assigneeAgentId: props.agentId,
        });
        await cancel(item.id);
      } catch { /* noop */ }
    },
    [props.companyId, props.agentId, cancel],
  );

  const steer = useCallback(async () => {
    if (!props.agentId || !steerText.trim()) return;
    try {
      await agentsApi.wakeup(props.agentId, {
        source: "on_demand",
        reason: "operator_steer",
        payload: { message: steerText.trim(), steer: true },
      });
      setSteerText("");
      setSteerApplied(true);
      setTimeout(() => setSteerApplied(false), 4000);
    } catch { /* noop */ }
  }, [props.agentId, steerText]);

  const onItemKeyDown = (e: KeyboardEvent<HTMLDivElement>, index: number) => {
    if (!e.altKey) return;
    if (e.key === "ArrowUp") { e.preventDefault(); move(index, index - 1); }
    if (e.key === "ArrowDown") { e.preventDefault(); move(index, index + 1); }
  };
  const onDrop = (e: DragEvent<HTMLDivElement>, index: number) => {
    e.preventDefault();
    if (dragRef.current >= 0) move(dragRef.current, index);
    dragRef.current = -1;
  };

  return (
    <div className="rounded-lg border border-border" style={{ backgroundColor: "var(--openbot-surface-25d-bg)", boxShadow: "var(--openbot-surface-25d-shadow)" }}>
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-xs font-semibold">대기/큐 ({scopedItems.length})</span>
        {props.pendingModel && (
          <span
            className="rounded-full px-2 py-0.5 text-[10px] font-medium"
            style={{ color: "var(--openbot-warning-text)", backgroundColor: "var(--openbot-warning-soft)" }}
          >
            {props.pendingModel} · 이번 턴 종료 후 적용
          </span>
        )}
      </div>

      <div className="divide-y divide-border max-h-56 overflow-y-auto">
        {scopedItems.length === 0 && (
          <p className="px-3 py-3 text-xs text-muted-foreground">
            {query.isError ? "큐 엔드포인트 연결 불가 (백엔드 미배포)" : "대기 중인 항목이 없습니다."}
          </p>
        )}
        {scopedItems.map((item, index) => (
          <div
            key={item.id}
            draggable
            tabIndex={0}
            onDragStart={(e) => { dragRef.current = index; e.dataTransfer.effectAllowed = "move"; force((v) => v + 1); }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => onDrop(e, index)}
            onKeyDown={(e) => onItemKeyDown(e, index)}
            className="flex items-center gap-1.5 px-2 py-1.5 text-xs group"
            aria-label={`큐 항목 ${index + 1}`}
          >
            <GripVertical className="h-3.5 w-3.5 text-muted-foreground/50 cursor-grab shrink-0" />
            {editingId === item.id ? (
              <input
                autoFocus
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") saveEdit(item.id); if (e.key === "Escape") setEditingId(null); }}
                onBlur={() => saveEdit(item.id)}
                className="flex-1 min-w-0 rounded border border-border bg-transparent px-1.5 py-0.5 text-xs outline-none"
              />
            ) : (
              <button
                type="button"
                className="flex-1 min-w-0 truncate text-left hover:underline"
                title="클릭해 프롬프트 수정"
                onClick={() => { setEditingId(item.id); setEditText(queueItemLabel(item)); }}
              >
                {queueItemLabel(item)}
              </button>
            )}
            <span className="hidden group-hover:flex items-center gap-0.5 shrink-0">
              {props.agentId && (
                <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[10px]" onClick={() => splitAsTask(item)}>
                  태스크로 분리
                </Button>
              )}
              <Button variant="ghost" size="icon-xs" aria-label="큐 항목 취소" onClick={() => cancel(item.id)}>
                <X className="h-3.5 w-3.5" />
              </Button>
            </span>
          </div>
        ))}
      </div>

      {props.agentId && (
        <div className="flex items-center gap-1.5 border-t border-border px-2 py-2">
          <input
            value={steerText}
            onChange={(e) => setSteerText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") steer(); }}
            placeholder="즉시 개입 메시지…"
            className="flex-1 min-w-0 rounded-md border border-border bg-transparent px-2 py-1 text-xs outline-none"
            aria-label="즉시 개입(Steer)"
          />
          <Button variant="secondary" size="sm" className="h-7 px-2 text-xs" onClick={steer} disabled={!steerText.trim()}>
            <Send className="h-3 w-3 mr-1" />
            개입(Steer)
          </Button>
        </div>
      )}
      {(steerApplied || props.steerSupported === false) && (
        <p className={cn("px-3 pb-2 text-[10px]", props.steerSupported === false ? "text-muted-foreground" : "")}
           style={props.steerSupported === false ? undefined : { color: "var(--openbot-success-text)" }}>
          {props.steerSupported === false
            ? "이번 턴 종료 후 적용 (Not steered — 미드턴 개입 미지원)"
            : "개입 메시지를 전달했습니다."}
        </p>
      )}
    </div>
  );
}
