import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CornerDownRight, MoveRight, Plus, Send } from "lucide-react";
import type { Agent } from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { Button } from "@/components/ui/button";

export const CHANNEL_ASSIGNMENT_LIMIT = 8;
export const CHANNEL_REPLY_BADGE_MAX = 2;

export interface ChannelAgentRef {
  id: string;
  name: string;
  urlKey?: string | null;
}

export interface MentionRouting {
  mentioned: ChannelAgentRef[];
  body: string;
}

/** Deterministic @mention parser — no LLM calls. Longest agent name wins at each @token. */
export function resolveMentionRouting(text: string, agents: ChannelAgentRef[]): MentionRouting {
  const mentioned: ChannelAgentRef[] = [];
  const seen = new Set<string>();
  let body = text;
  const sorted = [...agents].sort((a, b) => b.name.length - a.name.length);
  for (const agent of sorted) {
    // JS \b fails after CJK names (non-word chars) — use an explicit boundary lookahead.
    const pattern = new RegExp(`@${escapeRegExp(agent.name)}(?=$|[\\s,.!?;:\\)\\]])`, "gi");
    if (pattern.test(body)) {
      body = body.replace(pattern, " ").replace(/\s{2,}/g, " ");
      if (!seen.has(agent.id)) {
        seen.add(agent.id);
        mentioned.push(agent);
      }
    }
  }
  return { mentioned, body: body.trim() };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export type ChannelCardAction = "assign" | "transfer" | "reply" | "result";

export interface ChannelTaskCard {
  id: string;
  issueId?: string | null;
  title: string;
  assigneeAgentId: string | null;
  assigneeName: string | null;
  hops: number;
  replies: number;
  status: "open" | "done";
  lastAction: ChannelCardAction;
  createdAt: string;
}

const VALID_ACTIONS = new Set<ChannelCardAction>(["assign", "transfer", "reply", "result"]);

export function isValidChannelCard(value: unknown): value is ChannelTaskCard {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Partial<ChannelTaskCard>;
  return (
    typeof c.id === "string" && c.id.length > 0 &&
    typeof c.title === "string" &&
    typeof c.hops === "number" && Number.isFinite(c.hops) &&
    typeof c.replies === "number" && Number.isFinite(c.replies) &&
    (c.status === "open" || c.status === "done") &&
    typeof c.lastAction === "string" && VALID_ACTIONS.has(c.lastAction as ChannelCardAction) &&
    typeof c.createdAt === "string"
  );
}

export function pickNextTransferAssignee(agentRefs: ChannelAgentRef[], currentAssigneeId: string | null): ChannelAgentRef | undefined {
  if (agentRefs.length === 0) return undefined;
  const idx = agentRefs.findIndex((a) => a.id === currentAssigneeId);
  if (idx < 0) return agentRefs[0];
  for (let offset = 1; offset < agentRefs.length; offset += 1) {
    const candidate = agentRefs[(idx + offset) % agentRefs.length];
    if (candidate && candidate.id !== currentAssigneeId) return candidate;
  }
  return undefined;
}

export function hopBadgeText(card: Pick<ChannelTaskCard, "hops">): string { return `${card.hops} / ${CHANNEL_ASSIGNMENT_LIMIT}`; }
export function isAtHopLimit(card: Pick<ChannelTaskCard, "hops">): boolean { return card.hops >= CHANNEL_ASSIGNMENT_LIMIT; }
export function canTransfer(card: Pick<ChannelTaskCard, "hops" | "status">): boolean { return card.status === "open" && !isAtHopLimit(card); }

const storageKey = (companyId: string) => `paperclip.channelBoard.${companyId}`;

export function loadChannelCards(companyId: string): ChannelTaskCard[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(storageKey(companyId));
    const parsed = raw ? (JSON.parse(raw) as unknown[]) : [];
    return Array.isArray(parsed) ? parsed.filter(isValidChannelCard) : [];
  } catch { return []; }
}

export function saveChannelCards(companyId: string, cards: ChannelTaskCard[]): void {
  if (typeof localStorage === "undefined") return;
  try { localStorage.setItem(storageKey(companyId), JSON.stringify(cards)); } catch { /* storage full/blocked */ }
}

const ACTION_LABEL: Record<ChannelCardAction, string> = { assign: "할당", transfer: "이관", reply: "회신", result: "완료 보고" };

export function ChannelCollaborationBoard(props: { companyId: string }) {
  const { companyId } = props;
  const [board, setBoard] = useState<{ companyId: string; cards: ChannelTaskCard[] }>(() => ({
    companyId,
    cards: loadChannelCards(companyId),
  }));
  const activeCompanyRef = useRef(companyId);
  activeCompanyRef.current = companyId;
  useEffect(() => {
    setBoard((prev) => (prev.companyId === companyId ? prev : { companyId, cards: loadChannelCards(companyId) }));
  }, [companyId]);
  useEffect(() => {
    if (board.companyId === companyId) saveChannelCards(board.companyId, board.cards);
  }, [companyId, board]);

  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  const { data: agents } = useQuery({ queryKey: queryKeys.agents.list(companyId), queryFn: () => agentsApi.list(companyId) });
  const agentRefs = useMemo<ChannelAgentRef[]>(() => (agents ?? []).map((a: Agent) => ({ id: a.id, name: a.name, urlKey: a.urlKey ?? null })), [agents]);
  const routing = useMemo(() => resolveMentionRouting(draft, agentRefs), [draft, agentRefs]);
  const visibleCards = board.companyId === companyId ? board.cards : loadChannelCards(companyId);

  const applyToCompany = (targetCo: string, fn: (prev: ChannelTaskCard[]) => ChannelTaskCard[]) => {
    if (activeCompanyRef.current === targetCo) {
      setBoard((prev) => (prev.companyId === targetCo ? { companyId: targetCo, cards: fn(prev.cards) } : prev));
    } else {
      saveChannelCards(targetCo, fn(loadChannelCards(targetCo)));
    }
  };

  const dispatchWakeup = async (agentId: string, message: string) => {
    try { await agentsApi.wakeup(agentId, { source: "on_demand", reason: "channel_dispatch", payload: { message } }); }
    catch { setNotice("에이전트 깨우기 실패 — 카드는 저장되었습니다."); }
  };

  const assign = async () => {
    const targetCo = companyId;
    const target = routing.mentioned[0];
    const title = routing.body || draft.trim();
    if (!title) return;
    const card: ChannelTaskCard = {
      id: `cc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      issueId: null, title, assigneeAgentId: target?.id ?? null, assigneeName: target?.name ?? null,
      hops: 1, replies: 0, status: "open", lastAction: "assign", createdAt: new Date().toISOString(),
    };
    applyToCompany(targetCo, (prev) => [card, ...prev]);
    setDraft("");
    if (target) {
      try {
        const created = await issuesApi.create(targetCo, { title, assigneeAgentId: target.id });
        if (created?.id) {
          applyToCompany(targetCo, (prev) => prev.map((c) => (c.id === card.id ? { ...c, issueId: created.id } : c)));
        }
      } catch { /* issue creation best-effort */ }
      await dispatchWakeup(target.id, `[협업 채널] ${title}`);
    }
  };

  const transfer = async (card: ChannelTaskCard) => {
    const targetCo = companyId;
    if (!canTransfer(card)) return;
    const nextAgent = pickNextTransferAssignee(agentRefs, card.assigneeAgentId);
    if (!nextAgent) return;
    applyToCompany(targetCo, (prev) =>
      prev.map((c) => (c.id === card.id ? { ...c, hops: c.hops + 1, assigneeAgentId: nextAgent.id, assigneeName: nextAgent.name, lastAction: "transfer" as const } : c)),
    );
    await dispatchWakeup(nextAgent.id, `[협업 이관] ${card.title}`);
  };

  const reply = (card: ChannelTaskCard) => {
    applyToCompany(companyId, (prev) => prev.map((c) => (c.id === card.id ? { ...c, replies: c.replies + 1, lastAction: "reply" } : c)));
  };

  const reportDone = (card: ChannelTaskCard) => {
    applyToCompany(companyId, (prev) => prev.map((c) => (c.id === card.id ? { ...c, status: "done" as const, lastAction: "result" } : c)));
    if (card.issueId) issuesApi.update(card.issueId, { status: "done" }).catch(() => undefined);
  };

  return (
    <div className="space-y-3 tabular-nums">
      <div className="tactile-card rounded-[12px] border-slate-200/90 p-3 text-slate-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_10px_28px_rgba(15,23,42,0.10)] dark:border-white/[0.08] dark:text-slate-100 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_10px_28px_rgba(0,0,0,0.42)] [--openbot-surface-25d-bg:#ffffff] dark:[--openbot-surface-25d-bg:#0e131d] space-y-2" style={{ backgroundColor: "var(--openbot-surface-25d-bg)" }}>
        <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={2} placeholder="메시지를 입력하고 @에이전트를 멘션하세요…" className="w-full resize-y rounded-[10px] border border-slate-200/90 bg-white px-2.5 py-2 text-sm text-slate-900 outline-none transition-colors placeholder:text-slate-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/15 dark:border-white/[0.09] dark:bg-[#090c12] dark:text-slate-100 dark:placeholder:text-slate-500 dark:focus:border-[#60a5fa] dark:focus:ring-[#60a5fa]/20" aria-label="채널 메시지" />
        {routing.mentioned.length > 0 && (
          <p className="font-mono text-[11px] font-medium text-blue-700 dark:text-[#60a5fa]">라우팅: {routing.mentioned.map((a) => `@${a.name}`).join(", ")}</p>
        )}
        <div className="flex justify-end">
          <Button size="sm" className="h-7 bg-blue-600 px-3 text-xs text-white hover:bg-blue-500 dark:bg-[#60a5fa] dark:text-[#06101f] dark:hover:bg-[#7db5fb]" onClick={assign} disabled={!draft.trim()}><Plus className="h-3.5 w-3.5 mr-1" />할당</Button>
        </div>
      </div>

      {notice && <p className="rounded-[8px] border border-amber-500/25 bg-amber-500/10 px-2 py-1 text-[11px] font-medium text-amber-800 dark:border-[#f59e0b]/30 dark:bg-[#f59e0b]/12 dark:text-[#f59e0b]">{notice}</p>}

      {visibleCards.length === 0 ? (
        <p className="rounded-[10px] border border-dashed border-slate-300/80 bg-white/70 px-3 py-4 text-center text-xs text-slate-500 dark:border-white/[0.12] dark:bg-[#0e131d]/70 dark:text-[#8f9db3]">아직 채널 작업 카드가 없습니다.</p>
      ) : (
        <div className="space-y-2">
          {visibleCards.map((card) => (
            <div key={card.id} className={cn("tactile-card tactile-card-interactive rounded-[12px] border-slate-200/90 bg-white px-3 py-2 text-slate-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_8px_22px_rgba(15,23,42,0.07)] dark:border-white/[0.08] dark:bg-[#0e131d] dark:text-slate-100 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_8px_22px_rgba(0,0,0,0.34)] space-y-1.5", card.status === "done" && "opacity-60")}>
              <div className="flex items-center gap-2 text-sm">
                <span className="flex-1 min-w-0 truncate font-medium text-slate-950 dark:text-slate-50">{card.title}</span>
                <span
                  className={cn(
                    "shrink-0 rounded-full border px-2 py-0.5 font-mono text-[10px] tabular-nums",
                    isAtHopLimit(card)
                      ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:border-[#f59e0b]/35 dark:bg-[#f59e0b]/12 dark:text-[#f59e0b]"
                      : "border-slate-200/90 bg-slate-100 text-slate-500 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-[#8f9db3]",
                  )}
                  title={isAtHopLimit(card) ? "이관 상한 도달" : "할당 홉 수"}
                >
                  {hopBadgeText(card)}
                </span>
              </div>
              <div className="flex items-center gap-2 text-[11px] text-slate-500 dark:text-[#8f9db3]">
                <span className={cn(card.assigneeName && "font-medium text-blue-700 dark:text-[#60a5fa]")}>{card.assigneeName ? `@${card.assigneeName}` : "미할당"}</span>
                <span>·</span>
                <span>{ACTION_LABEL[card.lastAction]}</span>
                {card.replies > 0 && (
                  <><span>·</span><span className="flex items-center gap-0.5 tabular-nums"><CornerDownRight className="h-3 w-3" />회신 {Math.min(card.replies, CHANNEL_REPLY_BADGE_MAX)}/{CHANNEL_REPLY_BADGE_MAX}</span></>
                )}
                {card.status === "done" && <span className="font-medium text-lime-700 dark:text-[#a3e635]">완료됨</span>}
                <span className="ml-auto flex items-center gap-1">
                  {card.status === "open" && (
                    <>
                      <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[10px]" disabled={!canTransfer(card)} onClick={() => transfer(card)} title={isAtHopLimit(card) ? "8/8 홉 상한 — 이관 불가" : "다음 에이전트로 이관"}><MoveRight className="h-3 w-3 mr-0.5" />이관</Button>
                      <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[10px]" disabled={card.replies >= CHANNEL_REPLY_BADGE_MAX} onClick={() => reply(card)}><Send className="h-3 w-3 mr-0.5" />회신</Button>
                      <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[10px]" onClick={() => reportDone(card)}>완료 보고</Button>
                    </>
                  )}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
