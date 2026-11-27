import { useCallback, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
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
      payload: i.prompt || i.promptPreview ? null : ((i.payload ?? null) as QueuedWakeupItem["payload"]),
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

export function shouldHandleQueueRowKey(editingId: string | null, altKey: boolean, key: string): boolean {
  return editingId === null && altKey && (key === "ArrowUp" || key === "ArrowDown");
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
  const [actionError, setActionError] = useState<string | null>(null);
  const dragRef = useRef(-1);
  const savingRef = useRef<string | null>(null);

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

  const invalidate = useCallback(() => queryClient.invalidateQueries({ queryKey: ["ops-console-queue", props.companyId] }), [queryClient, props.companyId]);

  const persistOrder = useCallback(async (ordered: QueuedWakeupItem[]) => {
    const ids = ordered.map((i) => i.id);
    props.onReorder?.(ids);
    if (!props.companyId) return;
    setActionError(null);
    try { await api.post(`/companies/${props.companyId}/ops-console/queue/reorder`, { orderedIds: ids }); }
    catch (err) { setActionError(err instanceof Error ? err.message : "큐 순서 저장에 실패했습니다"); }
    invalidate();
  }, [props, invalidate]);

  const move = useCallback((from: number, to: number) => persistOrder(reorderQueueItems(scopedItems, from, to)), [persistOrder, scopedItems]);

  const cancel = useCallback(async (id: string): Promise<boolean> => {
    if (!props.companyId) return false;
    setActionError(null);
    try { await api.post(`/companies/${props.companyId}/ops-console/queue/${encodeURIComponent(id)}/cancel`, {}); invalidate(); return true; }
    catch (err) { setActionError(err instanceof Error ? err.message : "큐 항목 취소에 실패했습니다"); return false; }
  }, [props.companyId, invalidate]);

  const saveEdit = useCallback(async (id: string) => {
    if (!props.companyId || !editText.trim() || savingRef.current === id) return;
    savingRef.current = id;
    setActionError(null);
    try {
      await api.patch(`/companies/${props.companyId}/ops-console/queue/${encodeURIComponent(id)}`, { prompt: editText.trim() });
      setEditingId((curr) => (curr === id ? null : curr));
      invalidate();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "큐 프롬프트 수정에 실패했습니다");
    } finally {
      if (savingRef.current === id) savingRef.current = null;
    }
  }, [props.companyId, editText, invalidate]);

  const splitAsTask = useCallback(async (item: QueuedWakeupItem) => {
    if (!props.companyId || !props.agentId) return;
    const title = queueItemLabel(item).slice(0, 120);
    setActionError(null);
    try {
      await issuesApi.create(props.companyId, {
        title: title || "대기 작업 분리",
        description: `큐 항목에서 분리됨:\n\n${queueItemLabel(item)}`,
        assigneeAgentId: props.agentId,
      });
      if (!(await cancel(item.id))) setActionError("태스크는 생성되었으나 기존 큐 항목 취소에 실패했습니다");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "태스크 분리에 실패했습니다");
    }
  }, [props.companyId, props.agentId, cancel]);

  const steer = useCallback(async () => {
    if (!props.agentId || !steerText.trim()) return;
    setActionError(null);
    try {
      await agentsApi.wakeup(props.agentId, { source: "on_demand", reason: "operator_steer", payload: { message: steerText.trim(), steer: true } });
      setSteerText(""); setSteerApplied(true);
      setTimeout(() => setSteerApplied(false), 4000);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "개입 메시지 전송에 실패했습니다");
    }
  }, [props.agentId, steerText]);

  const onItemKeyDown = (e: KeyboardEvent<HTMLDivElement>, index: number) => {
    if (!shouldHandleQueueRowKey(editingId, e.altKey, e.key)) return;
    if (e.key === "ArrowUp") { e.preventDefault(); void move(index, index - 1); }
    if (e.key === "ArrowDown") { e.preventDefault(); void move(index, index + 1); }
  };
  const onDrop = (e: DragEvent<HTMLDivElement>, index: number) => {
    e.preventDefault();
    if (dragRef.current >= 0) void move(dragRef.current, index);
    dragRef.current = -1;
  };

  return (
    <div className="tactile-card overflow-hidden rounded-[12px] border-slate-200/90 dark:border-white/[0.08] dark:bg-card">
      <div className="flex items-center justify-between border-b border-slate-200/80 bg-white/70 px-3 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] dark:border-white/[0.08] dark:bg-[var(--pw-canvas)]/85 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
        <span className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-700 tabular-nums dark:text-card-foreground">대기/큐 ({scopedItems.length})</span>
        {props.pendingModel && (
          <span className="rounded-full border border-[var(--pw-amber)]/40 bg-[var(--pw-amber-soft)] px-2 py-0.5 text-[10px] font-semibold text-amber-700 tabular-nums dark:bg-[var(--pw-amber-soft)] dark:text-[var(--pw-amber)]">
            {props.pendingModel} · 이번 턴 종료 후 적용
          </span>
        )}
      </div>

      <div className="max-h-56 divide-y divide-slate-200/80 overflow-y-auto overscroll-contain dark:divide-white/[0.06]">
        {scopedItems.length === 0 && (
          <p className="px-3 py-3 text-xs text-slate-500 dark:text-muted-foreground">
            {query.isError ? "큐 엔드포인트 연결 불가 (백엔드 미배포)" : "대기 중인 항목이 없습니다."}
          </p>
        )}
        {scopedItems.map((item, index) => (
          <div
            key={item.id} draggable tabIndex={0} aria-label={`큐 항목 ${index + 1}`}
            onDragStart={(e) => { dragRef.current = index; e.dataTransfer.setData("text/plain", item.id); e.dataTransfer.effectAllowed = "move"; }}
            onDragOver={(e) => e.preventDefault()} onDrop={(e) => onDrop(e, index)} onKeyDown={(e) => onItemKeyDown(e, index)}
            className="group flex items-center gap-1.5 px-2 py-1.5 text-xs text-slate-700 transition-colors duration-150 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/45 dark:text-foreground dark:hover:bg-accent/30 dark:focus-visible:ring-ring/55"
          >
            <GripVertical className="h-3.5 w-3.5 shrink-0 cursor-grab text-slate-400 dark:text-muted-foreground" />
            {editingId === item.id ? (
              <input
                autoFocus value={editText} onChange={(e) => setEditText(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") void saveEdit(item.id);
                  if (e.key === "Escape") setEditingId((curr) => (curr === item.id ? null : curr));
                }}
                onBlur={() => { if (editingId === item.id && savingRef.current !== item.id) void saveEdit(item.id); }}
                className="min-w-0 flex-1 rounded-md border border-primary/35 bg-white/85 px-1.5 py-1 text-xs text-slate-800 shadow-[inset_0_1px_2px_rgba(15,23,42,0.04)] outline-none transition-colors focus:border-primary/60 focus:ring-2 focus:ring-primary/20 dark:border-[var(--pw-cobalt)]/35 dark:bg-background dark:text-foreground dark:shadow-[inset_0_1px_2px_rgba(0,0,0,0.35)] dark:focus:border-[var(--pw-cobalt)]/60 dark:focus:ring-[var(--pw-cobalt)]/20"
              />
            ) : (
              <button
                type="button"
                className="min-w-0 flex-1 truncate text-left transition-colors hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35 dark:hover:text-[var(--pw-cobalt)] dark:focus-visible:ring-[var(--pw-cobalt)]/45"
                title="클릭해 프롬프트 수정"
                onClick={() => { setEditingId(item.id); setEditText(queueItemLabel(item)); }}
              >
                {queueItemLabel(item)}
              </button>
            )}
            <span className="hidden shrink-0 items-center gap-0.5 group-focus-within:flex group-hover:flex">
              {props.agentId && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-1.5 text-[10px] font-semibold text-slate-500 transition-colors hover:bg-[var(--pw-amber-soft)] hover:text-amber-700 dark:text-muted-foreground dark:hover:bg-[var(--pw-amber-soft)] dark:hover:text-[var(--pw-amber)]"
                  onClick={() => splitAsTask(item)}
                >
                  태스크로 분리
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="큐 항목 취소"
                className="text-slate-400 transition-colors hover:bg-[var(--pw-crimson-soft)] hover:text-destructive dark:text-muted-foreground dark:hover:bg-[var(--pw-crimson-soft)] dark:hover:text-[var(--pw-crimson)]"
                onClick={() => cancel(item.id)}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </span>
          </div>
        ))}
      </div>

      {actionError && (
        <p className="border-t border-destructive/20 bg-destructive/10 px-3 py-1.5 text-[10px] font-medium text-destructive dark:text-[var(--pw-crimson)]">
          {actionError}
        </p>
      )}

      {props.agentId && (
        <div className="flex items-center gap-1.5 border-t border-slate-200/80 bg-white/55 px-2 py-2 dark:border-white/[0.08] dark:bg-[var(--pw-canvas)]/70">
          <input
            value={steerText}
            onChange={(e) => setSteerText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") steer(); }}
            placeholder="즉시 개입 메시지…"
            className="min-w-0 flex-1 rounded-md border border-slate-300/80 bg-white/85 px-2 py-1.5 text-xs text-slate-800 shadow-[inset_0_1px_2px_rgba(15,23,42,0.04)] outline-none transition-colors placeholder:text-slate-400 focus:border-primary/55 focus:ring-2 focus:ring-primary/20 dark:border-white/[0.08] dark:bg-card dark:text-foreground dark:shadow-[inset_0_1px_2px_rgba(0,0,0,0.35)] dark:placeholder:text-muted-foreground dark:focus:border-[var(--pw-cobalt)]/55 dark:focus:ring-[var(--pw-cobalt)]/20"
            aria-label="즉시 개입(Steer)"
          />
          <Button
            variant="ghost"
            size="sm"
            className="h-7 border border-primary/35 bg-primary/10 px-2 text-xs font-semibold text-primary transition-colors hover:bg-primary/15 disabled:opacity-50 dark:border-[var(--pw-cobalt)]/35 dark:bg-[var(--pw-cobalt-soft)] dark:text-[var(--pw-cobalt)]"
            onClick={steer}
            disabled={!steerText.trim()}
          >
            <Send className="mr-1 h-3 w-3" />
            개입(Steer)
          </Button>
        </div>
      )}
      {(steerApplied || props.steerSupported === false) && (
        <p
          className={cn(
            "px-3 pb-2 text-[10px] font-medium",
            props.steerSupported === false
              ? "text-slate-500 dark:text-muted-foreground"
              : "text-lime-700 dark:text-[var(--pw-lime)]",
          )}
        >
          {props.steerSupported === false
            ? "이번 턴 종료 후 적용 (Not steered — 미드턴 개입 미지원)"
            : "개입 메시지를 전달했습니다."}
        </p>
      )}
    </div>
  );
}
