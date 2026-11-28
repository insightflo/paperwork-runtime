import { useEffect, useId, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CornerDownRight, MessageSquare, Pause, Plus, Send } from "lucide-react";
import { agentsApi } from "../api/agents";
import { collabChannelsApi, type CollabActionKind, type CollabCreateChannelInput, type CollabCreateThreadInput, type CollabMessage, type CollabPostMessageInput, type CollabThread } from "../api/collabChannels";
import { decideExceptionHuddle, getExceptionHuddle, type ExceptionHuddleRecord } from "../api/exceptionHuddles";
import { useCompany } from "../context/CompanyContext";
import { useParams } from "@/lib/router";
import { queryKeys } from "../lib/queryKeys";
import { PageSkeleton } from "../components/PageSkeleton";
import { EmptyState } from "../components/EmptyState";
import { ExceptionHuddleCard, type ExceptionHuddle as ExceptionHuddleCardModel, type ExceptionHuddleDecisionInput } from "../components/ExceptionHuddleCard";
import { Button } from "@/components/ui/button";
import { cn } from "../lib/utils";

const ASSIGNMENT_CAP = 8;
const HUDDLE_SCHEMA_VERSION = "workflow.exception-huddle.v1";
const STATUS_PILL: Record<CollabThread["status"], string> = {
  open: "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:border-emerald-400/25 dark:bg-emerald-500/10 dark:text-emerald-300",
  waiting: "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:border-amber-400/25 dark:bg-amber-500/10 dark:text-amber-300",
  paused: "border-orange-500/25 bg-orange-500/10 text-orange-700 dark:border-orange-400/25 dark:bg-orange-500/10 dark:text-orange-300",
  resolved: "border-slate-500/20 bg-slate-500/10 text-slate-600 dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-slate-300",
};
const ACTION_BADGE: Partial<Record<CollabActionKind, string>> = { channel_assign: "위임", channel_transfer: "이관", channel_reply: "질의", channel_result: "결과", user_steer: "방향 수정" };
const CARD = "tactile-card rounded-xl border border-slate-200/90 bg-white shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.05)] dark:border-white/[0.08] dark:bg-[#0e131d] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_14px_36px_-18px_rgba(0,0,0,0.7)]";
const FIELD = "w-full rounded-lg border border-slate-200/90 bg-white px-2.5 py-1.5 text-sm text-slate-900 shadow-[inset_0_1px_2px_rgba(15,23,42,0.045)] placeholder:text-slate-400 outline-none transition-colors focus:border-blue-500/60 focus:ring-2 focus:ring-blue-500/20 dark:border-white/[0.09] dark:bg-[#07090d] dark:text-[#edf2fb] dark:placeholder:text-[#5f6b7f] dark:focus:border-[#60a5fa]/50 dark:focus:ring-[#60a5fa]/20";
const PILL = "inline-flex items-center rounded-full border px-1.5 py-0.5 font-mono text-[10px] font-medium tabular-nums";
const COLUMN_HEAD = "flex items-center justify-between gap-2 border-b border-slate-200/80 bg-slate-50/85 px-3 py-2 dark:border-white/[0.07] dark:bg-[#090c12]/85";

interface AgentRef { id: string; name: string; }
function hasHuddleSeed(thread: CollabThread, messages: CollabMessage[]) {
  if (thread.title.startsWith("[Huddle]")) return true;
  return messages.some((message) => {
    const metadata = (message as CollabMessage & { metadata?: unknown }).metadata;
    return !!metadata && typeof metadata === "object" && !Array.isArray(metadata)
      && (metadata as Record<string, unknown>).schemaVersion === HUDDLE_SCHEMA_VERSION;
  });
}
function huddleCardModel(threadId: string, huddle: ExceptionHuddleRecord, agents: AgentRef[]): ExceptionHuddleCardModel {
  const name = (agentId: string) => agents.find((agent) => agent.id === agentId)?.name ?? agentId;
  return {
    id: threadId, status: huddle.status, currentRound: huddle.currentRound, maxRounds: huddle.maxRounds,
    timeoutAt: huddle.timeoutAt, failureSummary: huddle.failureSummary, workProductLinks: huddle.workProductLinks,
    participants: { ownerName: name(huddle.participants.ownerAgentId), producerName: name(huddle.participants.producerAgentId), validatorName: name(huddle.participants.validatorAgentId) },
    decision: huddle.decision,
  };
}
function StatusPill({ status }: { status: CollabThread["status"] }) { return <span data-testid="status-badge" data-status={status} className={cn(PILL, "shrink-0", STATUS_PILL[status])}>{status}</span>; }
function MessageRow({ message, author }: { message: CollabMessage; author: string }) {
  const badge = ACTION_BADGE[message.actionKind];
  return (
    <li data-testid="message-row" className="rounded-lg border border-slate-200/75 bg-slate-50/70 px-2.5 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.75)] dark:border-white/[0.07] dark:bg-white/[0.03] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="rounded-md border border-slate-200/80 bg-white px-1.5 py-0.5 text-[10.5px] font-semibold text-slate-700 dark:border-white/[0.07] dark:bg-white/[0.05] dark:text-[#c9d3e4]">{author}</span>
        {badge && <span data-testid="action-badge" data-action={message.actionKind} className="rounded-md border border-blue-500/20 bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-blue-700 dark:border-[#60a5fa]/25 dark:bg-[#60a5fa]/10 dark:text-blue-300">{badge}</span>}
        {message.targetAgentId && <span className="text-[10px] text-slate-500 dark:text-[#8b97ad]">→ {message.targetAgentId}</span>}
        {message.expectsReply && <span className={cn(PILL, "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:border-amber-400/25 dark:bg-amber-500/10 dark:text-amber-300")}>답변 요망</span>}
      </div>
      <p className="mt-1 whitespace-pre-wrap text-[12.5px] leading-relaxed text-slate-700 dark:text-[#dbe4f0]">{message.body}</p>
    </li>
  );
}
function NewChannelForm({ agents, busy, onSubmit, onCancel }: { agents: AgentRef[]; busy: boolean; onSubmit: (input: CollabCreateChannelInput) => void; onCancel: () => void }) {
  const id = useId();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const toggleMember = (id: string) => setMemberIds((ids) => (ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id]));
  return <form className="flex flex-col gap-1.5 border-b border-slate-200/80 bg-slate-50/70 px-3 py-2.5 dark:border-white/[0.07] dark:bg-[#090c12]/70" onSubmit={(event) => {
    event.preventDefault();
    if (!name.trim() || busy) return;
    onSubmit({ name: name.trim(), description: description.trim() || undefined, memberAgentIds: memberIds });
  }}>
    <input data-testid="channel-name-input" aria-label="채널 이름" className={FIELD} value={name} onChange={(e) => setName(e.target.value)} placeholder="채널 이름" />
    <input data-testid="channel-description-input" aria-label="채널 설명" className={FIELD} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="설명 (선택)" />
    {agents.map((agent) => <label key={agent.id} htmlFor={`${id}-${agent.id}`} className="flex items-center gap-1.5 text-xs text-slate-700 dark:text-[#c9d3e4]">
      <input id={`${id}-${agent.id}`} type="checkbox" data-channel-agent={agent.id} className="h-3.5 w-3.5 accent-blue-600 dark:accent-[#60a5fa]" checked={memberIds.includes(agent.id)} onChange={() => toggleMember(agent.id)} />
      {agent.name}
    </label>)}
    <div className="flex gap-1.5">
      <Button type="submit" data-testid="channel-create-submit" size="sm" className="h-8 rounded-lg bg-blue-600 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] hover:bg-blue-700 dark:bg-[#2563eb] dark:hover:bg-[#3b82f6]" disabled={busy || !name.trim()}>만들기</Button>
      <Button type="button" size="sm" variant="ghost" className="h-8 rounded-lg px-2.5 text-xs text-slate-600 hover:bg-white dark:text-[#aab6c8] dark:hover:bg-white/[0.05]" onClick={onCancel}>취소</Button>
    </div>
  </form>;
}
function NewThreadForm({ busy, onSubmit, onCancel }: { busy: boolean; onSubmit: (input: CollabCreateThreadInput) => void; onCancel: () => void }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  return <form className="flex flex-col gap-1.5 border-b border-slate-200/80 bg-slate-50/70 px-3 py-2.5 dark:border-white/[0.07] dark:bg-[#090c12]/70" onSubmit={(event) => {
    event.preventDefault();
    if (!title.trim() || !body.trim() || busy) return;
    onSubmit({ title: title.trim(), body: body.trim() });
  }}>
    <input data-testid="thread-title-input" aria-label="스레드 제목" className={FIELD} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="스레드 제목" />
    <textarea data-testid="thread-body-input" aria-label="첫 메시지" className={cn(FIELD, "min-h-14 resize-y")} value={body} onChange={(e) => setBody(e.target.value)} placeholder="첫 메시지" />
    <div className="flex gap-1.5">
      <Button type="submit" data-testid="thread-create-submit" size="sm" className="h-8 rounded-lg bg-blue-600 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] hover:bg-blue-700 dark:bg-[#2563eb] dark:hover:bg-[#3b82f6]" disabled={busy || !title.trim() || !body.trim()}>만들기</Button>
      <Button type="button" size="sm" variant="ghost" className="h-8 rounded-lg px-2.5 text-xs text-slate-600 hover:bg-white dark:text-[#aab6c8] dark:hover:bg-white/[0.05]" onClick={onCancel}>취소</Button>
    </div>
  </form>;
}
function Composer({ agents, onSend }: { agents: AgentRef[]; onSend: (input: CollabPostMessageInput) => void }) {
  const [body, setBody] = useState("");
  const [targetAgentId, setTargetAgentId] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const mention = (name: string) => {
    setBody((draft) => `${draft}${draft && !/\s$/.test(draft) ? " " : ""}@${name} `);
    inputRef.current?.focus();
  };
  const send = (actionKind: "message" | "user_steer") => {
    const trimmed = body.trim();
    if (!trimmed) return;
    onSend({ body: trimmed, actionKind, targetAgentId: targetAgentId || null });
    setBody("");
    setTargetAgentId("");
  };
  return <div className="border-t border-slate-200/80 bg-slate-50/75 px-3 py-2.5 dark:border-white/[0.07] dark:bg-[#090c12]/85">
    {agents.length > 0 && <div role="group" aria-label="에이전트 빠른 멘션" className="mb-2 flex flex-wrap gap-1.5">
      {agents.map((agent) => <Button key={agent.id} type="button" size="sm" variant="outline" data-mention-agent={agent.id} className="h-7 rounded-full border-slate-200/90 bg-white px-2 text-[11px] text-slate-600 shadow-none hover:bg-slate-50 dark:border-white/[0.09] dark:bg-white/[0.03] dark:text-[#aab6c8] dark:hover:bg-white/[0.06]" onClick={() => mention(agent.name)}>@{agent.name}</Button>)}
    </div>}
    <textarea ref={inputRef} data-testid="composer-input" aria-label="스레드 메시지 작성" aria-keyshortcuts="Control+Enter Meta+Enter" className={cn(FIELD, "min-h-16 resize-y")} value={body} onChange={(e) => setBody(e.target.value)} onKeyDown={(event) => {
      if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey) || event.nativeEvent.isComposing) return;
      event.preventDefault();
      send("message");
    }} placeholder="@멘션으로 특정 에이전트 지정 또는 방향 수정 입력…" />
    <p className="mt-1 text-[10.5px] text-slate-500 dark:text-[#8b97ad]">Cmd/Ctrl+Enter로 전송 · Enter로 줄바꿈</p>
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
      <select data-testid="composer-target" aria-label="대상 에이전트 지정" className="h-8 rounded-lg border border-slate-200/90 bg-white px-2 text-xs text-slate-700 shadow-[inset_0_1px_2px_rgba(15,23,42,0.04)] outline-none transition-colors focus:border-blue-500/60 focus:ring-2 focus:ring-blue-500/20 dark:border-white/[0.09] dark:bg-[#07090d] dark:text-[#c9d3e4] dark:focus:border-[#60a5fa]/50 dark:focus:ring-[#60a5fa]/20" value={targetAgentId} onChange={(e) => setTargetAgentId(e.target.value)}>
        <option value="">대상 없음</option>
        {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
      </select>
      <div className="ml-auto flex gap-1.5">
        <Button type="button" data-testid="composer-send" size="sm" className="h-8 rounded-lg bg-blue-600 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] hover:bg-blue-700 dark:bg-[#2563eb] dark:hover:bg-[#3b82f6]" disabled={!body.trim()} onClick={() => send("message")}><Send className="h-3.5 w-3.5" />전송 (메시지)</Button>
        <Button type="button" data-testid="composer-steer" size="sm" variant="outline" className="h-8 rounded-lg border-slate-200/90 bg-white text-slate-700 hover:bg-slate-50 dark:border-white/[0.1] dark:bg-[#07090d] dark:text-[#c9d3e4] dark:hover:bg-white/[0.04]" disabled={!body.trim()} onClick={() => send("user_steer")}><CornerDownRight className="h-3.5 w-3.5" />즉시 방향 수정 (Steer)</Button>
      </div>
    </div>
  </div>;
}

export function CollabChannels() {
  const { selectedCompanyId: companyId } = useCompany();
  const queryClient = useQueryClient();
  const { channelId: routeChannelId } = useParams<{ channelId?: string }>();
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [showChannelForm, setShowChannelForm] = useState(false);
  const [showThreadForm, setShowThreadForm] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const agentsQuery = useQuery({ queryKey: queryKeys.agents.list(companyId ?? ""), queryFn: () => agentsApi.list(companyId!), enabled: !!companyId });
  const channelsQuery = useQuery({ queryKey: ["collab-channels", companyId], queryFn: () => collabChannelsApi.listChannels(companyId!), enabled: !!companyId });
  const channels = channelsQuery.data ?? [];
  const selectedChannel = channels.find((channel) => channel.id === selectedChannelId) ?? null;
  const threadsQuery = useQuery({ queryKey: ["collab-threads", companyId, selectedChannel?.id ?? ""], queryFn: () => collabChannelsApi.listThreads(companyId!, selectedChannel!.id), enabled: !!companyId && !!selectedChannel });
  const threads = threadsQuery.data ?? [];
  const selectedThread = threads.find((thread) => thread.id === selectedThreadId) ?? null;
  const messagesQuery = useQuery({ queryKey: ["collab-messages", companyId, selectedChannel?.id ?? "", selectedThread?.id ?? ""], queryFn: () => collabChannelsApi.listMessages(companyId!, selectedChannel!.id, selectedThread!.id), enabled: !!companyId && !!selectedChannel && !!selectedThread });
  const messages = messagesQuery.data ?? [];
  const agents: AgentRef[] = (agentsQuery.data ?? []).map((agent) => ({ id: agent.id, name: agent.name }));
  const agentLabel = (id: string | null) => agents.find((agent) => agent.id === id)?.name ?? "에이전트";
  const authorLabel = (message: CollabMessage) => message.authorType === "user" ? "사람" : message.authorType === "system" ? "시스템" : agentLabel(message.authorId);
  const isHuddleThread = !!selectedThread && hasHuddleSeed(selectedThread, messages);
  const huddleQuery = useQuery({
    queryKey: ["exception-huddle", companyId, selectedThread?.id ?? ""],
    queryFn: () => getExceptionHuddle(companyId!, selectedThread!.id),
    enabled: !!companyId && !!selectedThread && isHuddleThread,
  });

  useEffect(() => {
    if (routeChannelId) { setSelectedChannelId(routeChannelId); return; }
    if (!selectedChannelId && channels.length > 0) setSelectedChannelId(channels[0]!.id);
  }, [routeChannelId, channels, selectedChannelId]);
  useEffect(() => {
    if (threads.length === 0) { if (selectedThreadId) setSelectedThreadId(null); return; }
    if (!threads.some((thread) => thread.id === selectedThreadId)) setSelectedThreadId(threads[0]!.id);
  }, [threads, selectedThreadId]);

  const runMutation = async (action: () => Promise<unknown>) => {
    try { await action(); setActionError(null); }
    catch { setActionError("요청이 실패했습니다. 잠시 후 다시 시도해 주세요."); }
  };
  const createChannelMutation = useMutation({
    mutationFn: (input: CollabCreateChannelInput) => collabChannelsApi.createChannel(companyId!, input),
    onSuccess: () => { setShowChannelForm(false); void queryClient.invalidateQueries({ queryKey: ["collab-channels"] }); },
  });
  const createThreadMutation = useMutation({
    mutationFn: ({ channelId, input }: { channelId: string; input: CollabCreateThreadInput }) => collabChannelsApi.createThread(companyId!, channelId, input),
    onSuccess: () => { setShowThreadForm(false); void queryClient.invalidateQueries({ queryKey: ["collab-threads"] }); },
  });
  const postMessageMutation = useMutation({
    mutationFn: ({ threadId, input }: { threadId: string; input: CollabPostMessageInput }) => collabChannelsApi.postMessage(companyId!, selectedChannel!.id, threadId, input),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["collab-messages"] }),
  });
  const resumeThreadMutation = useMutation({
    mutationFn: ({ channelId, threadId }: { channelId: string; threadId: string }) => collabChannelsApi.resumeThread(companyId!, channelId, threadId),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["collab-threads"] }); void queryClient.invalidateQueries({ queryKey: ["collab-messages"] }); },
  });
  const decideHuddleMutation = useMutation({
    mutationFn: ({ threadId, actorAgentId, decision }: { threadId: string; actorAgentId: string; decision: ExceptionHuddleDecisionInput }) =>
      decideExceptionHuddle(companyId!, threadId, { actorAgentId, decision }),
    onSuccess: (_result, { threadId }) => { void queryClient.invalidateQueries({ queryKey: ["exception-huddle", companyId, threadId] }); void queryClient.invalidateQueries({ queryKey: ["collab-threads"] }); void queryClient.invalidateQueries({ queryKey: ["collab-messages"] }); },
  });

  if (!companyId || channelsQuery.isLoading || agentsQuery.isLoading) return <main className="p-3">
    <h1 className="sr-only">채널 협업</h1>
    {!companyId ? <p role="status" aria-live="polite">회사를 선택하면 채널 협업을 볼 수 있습니다.</p>
      : <div role="status" aria-label="채널 협업 불러오는 중" aria-live="polite"><PageSkeleton /></div>}
  </main>;

  return <main aria-label="채널 협업" className="flex min-h-0 flex-1 flex-col gap-3 p-3 tabular-nums">
    <h1 className="sr-only">채널 협업</h1>
    {channelsQuery.error && <p role="alert" className="text-xs text-destructive">채널을 불러오지 못했습니다.</p>}
    {agentsQuery.error && <p role="alert" className="text-xs text-destructive">에이전트를 불러오지 못했습니다.</p>}
    {actionError && <p role="alert" className="text-xs text-destructive">{actionError}</p>}
    <div className="flex min-h-0 flex-1 flex-col gap-3 lg:flex-row">
      <section aria-label="채널 목록" className={cn(CARD, "flex w-full shrink-0 flex-col overflow-hidden lg:w-60")}>
        <header className={COLUMN_HEAD}>
          <h2 className="text-[13px] font-semibold tracking-tight text-slate-950 dark:text-[#edf2fb]">Channels</h2>
          <Button type="button" size="sm" variant="ghost" data-testid="new-channel-toggle" className="h-7 rounded-lg px-2 text-xs text-slate-600 hover:bg-white dark:text-[#aab6c8] dark:hover:bg-white/[0.05]" onClick={() => { setShowChannelForm((open) => !open); setActionError(null); }}><Plus className="h-3.5 w-3.5" />새 채널</Button>
        </header>
        {showChannelForm && <NewChannelForm agents={agents} busy={createChannelMutation.isPending} onSubmit={(input) => void runMutation(() => createChannelMutation.mutateAsync(input))} onCancel={() => setShowChannelForm(false)} />}
        <ul className="flex flex-col gap-0.5 overflow-y-auto p-2">
          {channels.map((channel) => <li key={channel.id}>
            <button type="button" data-channel-row={channel.id} onClick={() => { setSelectedChannelId(channel.id); setSelectedThreadId(null); setShowThreadForm(false); }} className={cn("w-full rounded-lg border px-2.5 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/35 dark:focus-visible:ring-[#60a5fa]/35", channel.id === selectedChannelId ? "border-blue-500/35 bg-blue-500/[0.08] text-slate-950 shadow-[inset_2px_0_0_#2563eb,inset_0_1px_0_rgba(255,255,255,0.75)] dark:border-[#60a5fa]/35 dark:bg-[#60a5fa]/[0.1] dark:text-[#edf2fb] dark:shadow-[inset_2px_0_0_#60a5fa]" : "border-transparent text-slate-600 hover:border-slate-200/90 hover:bg-slate-50 dark:text-[#aab6c8] dark:hover:border-white/[0.07] dark:hover:bg-white/[0.04]")}>
              <span className="block truncate text-[12.5px] font-medium"><span className="font-mono text-[11px] text-slate-500 dark:text-[#8b97ad]">#{channel.slug}</span> {channel.name}</span>
              <span className="mt-0.5 block truncate text-[10.5px] text-slate-500 dark:text-[#8b97ad]">{channel.memberAgentIds.length}명 · {channel.description ?? "설명 없음"}</span>
            </button>
          </li>)}
        </ul>
      </section>
      <section aria-label="스레드 목록" className={cn(CARD, "flex w-full shrink-0 flex-col overflow-hidden lg:w-72")}>
        <header className={COLUMN_HEAD}>
          <h2 className="text-[13px] font-semibold tracking-tight text-slate-950 dark:text-[#edf2fb]">Threads</h2>
          <Button type="button" size="sm" variant="ghost" data-testid="new-thread-toggle" className="h-7 rounded-lg px-2 text-xs text-slate-600 hover:bg-white dark:text-[#aab6c8] dark:hover:bg-white/[0.05]" disabled={!selectedChannel} onClick={() => { setShowThreadForm((open) => !open); setActionError(null); }}><Plus className="h-3.5 w-3.5" />새 스레드</Button>
        </header>
        {showThreadForm && selectedChannel && <NewThreadForm busy={createThreadMutation.isPending} onSubmit={(input) => void runMutation(() => createThreadMutation.mutateAsync({ channelId: selectedChannel.id, input }))} onCancel={() => setShowThreadForm(false)} />}
        {threadsQuery.error ? <p role="alert" className="px-3 py-2 text-xs text-destructive">스레드를 불러오지 못했습니다.</p> : <ul className="flex flex-col gap-1 overflow-y-auto p-2">
          {threads.map((thread) => <li key={thread.id}>
            <button type="button" data-thread-row={thread.id} onClick={() => setSelectedThreadId(thread.id)} className={cn("w-full rounded-lg border px-2.5 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/35 dark:focus-visible:ring-[#60a5fa]/35", thread.id === selectedThreadId ? "border-blue-500/35 bg-blue-500/[0.08] shadow-[inset_2px_0_0_#2563eb,inset_0_1px_0_rgba(255,255,255,0.75)] dark:border-[#60a5fa]/35 dark:bg-[#60a5fa]/[0.1] dark:shadow-[inset_2px_0_0_#60a5fa]" : "border-slate-200/80 bg-white/70 hover:border-slate-300 hover:bg-slate-50 dark:border-white/[0.07] dark:bg-white/[0.025] dark:hover:border-white/[0.12] dark:hover:bg-white/[0.05]")}>
              <span className="flex items-center gap-1.5">
                <StatusPill status={thread.status} />
                <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{thread.title}</span>
                <span data-testid="assignment-count" title={`할당 ${thread.assignmentCount}/${ASSIGNMENT_CAP}`} className={cn(PILL, thread.assignmentCount >= ASSIGNMENT_CAP ? "border-orange-500/25 bg-orange-500/10 text-orange-700 dark:border-orange-400/25 dark:bg-orange-500/10 dark:text-orange-300" : "border-slate-200/90 bg-slate-100 text-slate-500 dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-[#8b97ad]")}>{thread.assignmentCount}/{ASSIGNMENT_CAP}</span>
              </span>
              <span className="mt-1 block text-[10.5px] text-slate-500 dark:text-[#8b97ad]">답변 {thread.replyCount} · {thread.createdByActorType === "user" ? "사람 생성" : "에이전트 생성"}</span>
            </button>
          </li>)}
        </ul>}
      </section>
      <section aria-label="스레드 타임라인" className={cn(CARD, "flex min-w-0 flex-1 flex-col overflow-hidden")}>
        {channels.length === 0 && !channelsQuery.error ? <div className="flex flex-1 items-center justify-center p-8">
          <div className="max-w-md rounded-xl border border-slate-200/90 bg-slate-50/85 p-7 text-center shadow-[inset_0_1px_0_rgba(255,255,255,0.85)] dark:border-white/[0.08] dark:bg-[#090c12]/90 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
            <MessageSquare aria-hidden="true" className="mx-auto mb-3 h-8 w-8 text-slate-400 dark:text-[#8b97ad]" />
            <h2 className="text-lg font-semibold tracking-tight text-slate-950 dark:text-[#edf2fb]">Paperwork에서 팀 대화를 시작하세요</h2>
            <p className="mt-2 text-sm leading-relaxed text-slate-600 dark:text-[#8b97ad]">팀이나 에이전트와 대화할 채널을 만들어 보세요. 채널 이름을 정하고 함께할 에이전트를 선택하면 됩니다.</p>
            <p className="mt-2 text-sm leading-relaxed text-slate-600 dark:text-[#8b97ad]">채널 안에서 새 스레드(대화)를 열고, @멘션으로 에이전트에게 말을 걸어 보세요.</p>
            <Button type="button" className="mt-5 rounded-lg bg-blue-600 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] hover:bg-blue-700 dark:bg-[#2563eb] dark:hover:bg-[#3b82f6]" data-testid="onboarding-create-channel" onClick={() => { setShowChannelForm(true); setActionError(null); }}><Plus className="h-4 w-4" />첫 채널 만들기</Button>
          </div>
        </div> : !selectedThread ? <div className="flex flex-1 items-center justify-center p-8"><EmptyState icon={MessageSquare} message="왼쪽에서 스레드를 선택하면 타임라인이 열립니다." /></div> : <>
          <header className={cn(COLUMN_HEAD, "flex-wrap")}>
            <div className="flex min-w-0 items-center gap-2">
              <h2 className="min-w-0 truncate text-[13px] font-semibold tracking-tight text-slate-950 dark:text-[#edf2fb]">{selectedThread.title}</h2>
              <StatusPill status={selectedThread.status} />
            </div>
            <span className="text-[10.5px] text-slate-500 dark:text-[#8b97ad]">담당 {selectedThread.ownerAgentId ? agentLabel(selectedThread.ownerAgentId) : "미지정"} · 할당 {selectedThread.assignmentCount}/{ASSIGNMENT_CAP}</span>
          </header>
          {selectedThread.status === "paused" && <div data-testid="paused-banner" aria-live="polite" className="flex flex-wrap items-center gap-2 border-b border-amber-500/25 bg-amber-500/[0.08] px-3 py-2 dark:border-amber-400/25 dark:bg-amber-500/[0.09]">
            <Pause className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-300" />
            <span className="min-w-0 flex-1 text-xs text-amber-700 dark:text-amber-200">할당 한도({ASSIGNMENT_CAP})에 도달해 일시 중지되었습니다. 승인 후 계속 진행할 수 있습니다.</span>
            <Button type="button" data-testid="resume-continue" size="sm" disabled={resumeThreadMutation.isPending} onClick={() => void runMutation(() => resumeThreadMutation.mutateAsync({ channelId: selectedChannel!.id, threadId: selectedThread.id }))}>승인 후 계속 (Continue)</Button>
          </div>}
          {isHuddleThread && <div className="border-b border-slate-200/80 bg-slate-50/55 px-2.5 py-2 dark:border-white/[0.07] dark:bg-white/[0.025]">
            {huddleQuery.isLoading ? <p role="status" aria-live="polite" className="text-xs text-slate-500 dark:text-[#8b97ad]">예외 허들 정보를 불러오는 중입니다.</p>
              : huddleQuery.error ? <p role="alert" className="text-xs text-destructive">예외 허들 정보를 불러오지 못했습니다.</p>
                : huddleQuery.data ? <ExceptionHuddleCard
                  huddle={huddleCardModel(selectedThread.id, huddleQuery.data.huddle, agents)}
                  canDecide
                  isSubmitting={decideHuddleMutation.isPending}
                  onDecide={(decision) => decideHuddleMutation.mutateAsync({
                    threadId: selectedThread.id, actorAgentId: huddleQuery.data.huddle.participants.ownerAgentId, decision,
                  }).then(() => undefined)}
                /> : null}
          </div>}
          {messagesQuery.error && <p role="alert" className="px-3 py-2 text-xs text-destructive">메시지를 불러오지 못했습니다.</p>}
          <ul className="flex flex-1 flex-col gap-2 overflow-y-auto p-3">
            {messages.map((message) => <MessageRow key={message.id} message={message} author={authorLabel(message)} />)}
          </ul>
          <Composer agents={agents} onSend={(input) => void runMutation(() => postMessageMutation.mutateAsync({ threadId: selectedThread.id, input }))} />
        </>}
      </section>
    </div>
  </main>;
}

export default CollabChannels;
