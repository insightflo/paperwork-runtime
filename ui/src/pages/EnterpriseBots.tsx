import { useMemo, useState, type ReactNode } from "react";
import { Ban, Bot, Clock, Hash, Lock, Monitor, Play, Plus, Search, Square } from "lucide-react";
import { EmptyState } from "../components/EmptyState";

/* ── Enterprise Bot B4 cockpit: bots, client terminals, channels & @mentions ──
 * Data is injected through `initialData` so the layout can be unit-tested without
 * a company context and wired to the API later without touching this file. */

export type BotKind = "personal" | "team" | "company";
export type CallableBy = "owner" | "team" | "company";
export type DataScope = "self" | "team" | "company";
export type BotStatus = "active" | "paused" | "revoked";
export type TerminalKind = "personal_terminal" | "worker_node";
export type TerminalStatus = "online" | "offline";
export type ViewerRole = "owner" | "admin" | "member";

export interface EnterpriseBot {
  id: string; name: string; kind: BotKind; status: BotStatus;
  callableBy: CallableBy; dataScope: DataScope; capabilities: string[]; ownerName: string;
}
export interface ClientTerminal {
  id: string; name: string; kind: TerminalKind; status: TerminalStatus;
  ownerId: string; ownerName: string; lastHeartbeatAt: string | null;
}
export interface Channel { id: string; name: string; members: string[] }
export interface PendingOwnerApproval {
  id: string; channelId: string; botId: string; botName: string; fromUserName: string;
  toTerminalId: string; toTerminalName: string; toOwnerName: string; action: string; requestedAt: string;
}
export interface EnterpriseBotsData {
  bots: EnterpriseBot[]; terminals: ClientTerminal[]; channels: Channel[];
  pendingApprovals: PendingOwnerApproval[]; now?: string;
}
export interface EnterpriseBotsProps {
  /** Injected state; omitted → demo fallback so the page is never blank. */
  initialData?: EnterpriseBotsData;
  viewerId?: string; viewerRole?: ViewerRole;
  onRegisterTerminal?: () => void;
  onApprovalDecision?: (approvalId: string, decision: "approve" | "deny") => void;
}

export const EXEC_OWNER_ONLY_REASON =
  "Exec is owner-only on a personal terminal. Non-owner admins can Stop or Revoke this session but cannot run commands as its owner.";

/** Exec policy: worker nodes are shared; a personal terminal only executes for its owner. */
export function execPolicy(terminal: ClientTerminal, viewerId: string): { enabled: boolean; reason: string | null } {
  if (terminal.kind !== "personal_terminal" || terminal.ownerId === viewerId) return { enabled: true, reason: null };
  return { enabled: false, reason: EXEC_OWNER_ONLY_REASON };
}

const DEMO: EnterpriseBotsData = {
  now: "2026-11-26T01:00:00.000Z",
  bots: [
    { id: "b1", name: "Research Copilot", kind: "company", status: "active", callableBy: "company", dataScope: "company", capabilities: ["web.search", "doc.summarize"], ownerName: "Ops" },
    { id: "b2", name: "Standup Scribe", kind: "team", status: "active", callableBy: "team", dataScope: "team", capabilities: ["meetings.transcribe"], ownerName: "Platform" },
    { id: "b3", name: "Inbox Triage", kind: "personal", status: "paused", callableBy: "owner", dataScope: "self", capabilities: ["mail.triage"], ownerName: "Maya" },
  ],
  terminals: [
    { id: "t1", name: "maya-macbook", kind: "personal_terminal", status: "online", ownerId: "u-maya", ownerName: "Maya", lastHeartbeatAt: "2026-11-26T00:59:48.000Z" },
    { id: "t2", name: "build-node-01", kind: "worker_node", status: "online", ownerId: "u-ops", ownerName: "Ops", lastHeartbeatAt: "2026-11-26T00:59:30.000Z" },
    { id: "t3", name: "build-node-02", kind: "worker_node", status: "offline", ownerId: "u-ops", ownerName: "Ops", lastHeartbeatAt: "2026-11-26T00:41:02.000Z" },
  ],
  channels: [
    { id: "c1", name: "eng-alerts", members: ["Maya", "Dev", "Ops", "Research Copilot"] },
    { id: "c2", name: "releases", members: ["Ops", "Standup Scribe"] },
  ],
  pendingApprovals: [
    { id: "pa1", channelId: "c1", botId: "b3", botName: "Inbox Triage", fromUserName: "Dev", toTerminalId: "t1", toTerminalName: "maya-macbook", toOwnerName: "Maya", action: "run mail.triage on owner terminal", requestedAt: "2026-11-26T00:58:10.000Z" },
  ],
};

const TABS = [
  { key: "bots", label: "Bots & Capabilities", icon: Bot, empty: "No bots registered." },
  { key: "terminals", label: "Client Terminals", icon: Monitor, empty: "No terminals registered." },
  { key: "channels", label: "Channels & @mentions", icon: Hash, empty: "No shared channels yet." },
] as const;
type Tab = (typeof TABS)[number]["key"];

const TAB_CLASS =
  "h-7 cursor-pointer rounded-md px-2.5 text-xs font-medium whitespace-nowrap transition-colors aria-pressed:bg-white aria-pressed:text-slate-950 aria-pressed:shadow-[0_1px_2px_rgba(15,23,42,0.08)] dark:aria-pressed:bg-[#141c2b] dark:aria-pressed:text-[#edf2fb] dark:aria-pressed:shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] text-slate-600 hover:text-slate-950 dark:text-[#8b97ad] dark:hover:text-[#edf2fb]";
const PANEL =
  "rounded-xl border border-slate-200/90 bg-white shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] dark:border-white/[0.08] dark:bg-[#0e131d] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_6px_24px_-10px_rgba(0,0,0,0.65)]";
const ACTION =
  "inline-flex h-7.5 cursor-pointer items-center gap-1.5 rounded-lg border border-slate-200/90 bg-white px-2.5 text-xs font-medium text-slate-800 transition-colors hover:border-blue-500/40 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/[0.1] dark:bg-[#090d14] dark:text-[#edf2fb] dark:hover:border-[#60a5fa]/40 dark:hover:bg-[#141b29]";
const STATUS_DOT: Record<TerminalStatus | BotStatus, string> = {
  online: "bg-lime-500 shadow-[0_0_8px_rgba(163,230,53,0.7)] animate-pulse dark:bg-[#a3e635]",
  offline: "bg-slate-400 dark:bg-[#64748b]",
  active: "bg-lime-500 shadow-[0_0_8px_rgba(163,230,53,0.7)] animate-pulse dark:bg-[#a3e635]",
  paused: "bg-amber-500 shadow-[0_0_6px_rgba(245,158,11,0.55)] dark:bg-[#f59e0b]",
  revoked: "bg-slate-400 dark:bg-[#64748b]",
};
const FIELD = "grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs";

function since(iso: string | null, now: number): string {
  if (!iso) return "never";
  const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}
function Pill({ children, dot, tone = "neutral" }: { children: ReactNode; dot: string; tone?: "live" | "warn" | "neutral" }) {
  const toneClass =
    tone === "live"
      ? "border-lime-500/30 bg-lime-500/10 text-lime-800 dark:border-[#a3e635]/30 dark:bg-[#a3e635]/10 dark:text-[#d9f99d]"
      : tone === "warn"
        ? "border-amber-500/35 bg-amber-500/10 text-amber-800 dark:border-[#f59e0b]/35 dark:bg-[#f59e0b]/10 dark:text-[#fcd34d]"
        : "border-slate-200/90 bg-slate-100/80 text-slate-700 dark:border-white/[0.08] dark:bg-[#090d14] dark:text-[#cbd5e1]";
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium ${toneClass}`}>
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      {children}
    </span>
  );
}
function statusTone(status: TerminalStatus | BotStatus): "live" | "warn" | "neutral" {
  if (status === "online" || status === "active") return "live";
  if (status === "paused") return "warn";
  return "neutral";
}
/** 2-axis security badge: who may call the bot × whose data it can touch. */
export function SecurityBadge({ callableBy, dataScope }: { callableBy: CallableBy; dataScope: DataScope }) {
  return (
    <span
      data-security-badge
      title={`Callable by ${callableBy} · data scope ${dataScope}`}
      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-blue-500/25 bg-blue-500/10 px-1.5 py-0.5 font-mono text-[11px] text-blue-700 dark:border-[#60a5fa]/30 dark:bg-[#60a5fa]/10 dark:text-[#93c5fd]"
    >
      <Lock className="h-3 w-3" aria-hidden />
      {callableBy} × {dataScope}
    </span>
  );
}
function KindTag({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-md border border-slate-200/90 bg-slate-100/80 px-1.5 py-0.5 font-mono text-[11px] text-slate-600 dark:border-white/[0.08] dark:bg-[#07090d] dark:text-[#8b97ad]">
      {children}
    </span>
  );
}
function Fields({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className={FIELD}>
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-slate-500 dark:text-[#8b97ad]">{k}</dt>
          <dd className="truncate text-slate-900 dark:text-[#edf2fb]">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
function SectionTitle({ children }: { children: ReactNode }) {
  return <h3 className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-[#8b97ad]">{children}</h3>;
}

export function EnterpriseBots({ initialData, viewerId = "u-admin", viewerRole = "admin", onRegisterTerminal, onApprovalDecision }: EnterpriseBotsProps) {
  const data = initialData ?? DEMO;
  const [tab, setTab] = useState<Tab>("bots");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Partial<Record<Tab, string>>>({});
  const now = Date.parse(data.now ?? new Date().toISOString());

  const q = search.trim().toLowerCase();
  const lists = useMemo(() => ({
    bots: data.bots.filter((b) => !q || `${b.name} ${b.ownerName} ${b.kind}`.toLowerCase().includes(q)),
    terminals: data.terminals.filter((t) => !q || `${t.name} ${t.ownerName} ${t.kind}`.toLowerCase().includes(q)),
    channels: data.channels.filter((c) => !q || `${c.name} ${c.members.join(" ")}`.toLowerCase().includes(q)),
  }), [data, q]);
  const list = lists[tab];
  const currentId = list.some((item) => item.id === selected[tab]) ? selected[tab] : list[0]?.id;
  const pick = (id: string) => setSelected((s) => ({ ...s, [tab]: id }));
  const meta = TABS.find((t) => t.key === tab)!;
  const strip = [
    { label: "Active Bots", value: data.bots.filter((b) => b.status === "active").length, dot: STATUS_DOT.active, tab: "bots" },
    { label: "Online Terminals", value: data.terminals.filter((t) => t.status === "online").length, dot: STATUS_DOT.online, tab: "terminals" },
    { label: "Shared Channels", value: data.channels.length, dot: "bg-blue-500 dark:bg-[#60a5fa]", tab: "channels" },
    { label: "Pending Owner Approvals", value: data.pendingApprovals.length, dot: data.pendingApprovals.length ? STATUS_DOT.paused : STATUS_DOT.offline, tab: "channels" },
  ] as const;

  return (
    <div className="space-y-3 tabular-nums">
      {/* 1-row 4-column Combo 1 telemetry strip; cells jump to their tab */}
      <div
        className="grid w-full grid-cols-2 divide-x divide-slate-200/80 overflow-hidden rounded-xl border border-slate-200/90 bg-white shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] dark:divide-white/[0.06] dark:border-white/[0.08] dark:bg-[#0e131d] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_4px_20px_-8px_rgba(0,0,0,0.65)] sm:grid-cols-4"
        role="group"
        aria-label="Enterprise bot telemetry"
      >
        {strip.map((cell) => (
          <button
            key={cell.label}
            type="button"
            onClick={() => setTab(cell.tab)}
            className={`flex h-10 min-w-0 cursor-pointer items-center justify-center gap-2 px-3 text-xs transition-colors ${
              tab === cell.tab
                ? "bg-slate-100/90 text-slate-950 shadow-[inset_0_-2px_0_#2563eb] dark:bg-[#151d2b] dark:text-[#edf2fb] dark:shadow-[inset_0_-2px_0_#60a5fa]"
                : "text-slate-600 hover:bg-slate-50 hover:text-slate-900 dark:text-[#8b97ad] dark:hover:bg-[#141b29] dark:hover:text-[#edf2fb]"
            }`}
          >
            <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${cell.dot}`} />
            <span className="truncate text-[11px] font-semibold uppercase tracking-[0.1em]">{cell.label}</span>
            <b className="ml-0.5 font-mono text-xs font-semibold text-slate-950 dark:text-[#edf2fb]">{cell.value}</b>
          </button>
        ))}
      </div>

      {/* Unified tactile segmented toolbar */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200/90 bg-slate-50/95 p-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.85)] dark:border-white/[0.08] dark:bg-[#090d14] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
        <div
          role="group"
          aria-label="Enterprise bot views"
          className="flex shrink-0 items-center gap-0.5 rounded-lg border border-slate-200/90 bg-slate-100/90 p-0.5 dark:border-white/[0.08] dark:bg-[#07090d]"
        >
          {TABS.map((t) => (
            <button key={t.key} type="button" data-tab={t.key} aria-pressed={tab === t.key} onClick={() => setTab(t.key)} className={TAB_CLASS}>
              <t.icon className="mr-1.5 inline h-3.5 w-3.5 align-[-2px]" aria-hidden />{t.label}
            </button>
          ))}
        </div>
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400 dark:text-[#8b97ad]" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={`Search ${meta.label.toLowerCase()}...`}
            aria-label="Search enterprise bots"
            className="h-8 w-full rounded-lg border border-slate-200/90 bg-white pl-8 pr-3 text-xs text-slate-900 outline-none placeholder:text-slate-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-white/[0.09] dark:bg-[#0e131d] dark:text-[#edf2fb] dark:placeholder:text-[#8b97ad] dark:focus:border-[#60a5fa] dark:focus:ring-[#60a5fa]/25"
          />
        </div>
        <button
          type="button"
          onClick={onRegisterTerminal}
          className="inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg bg-blue-600 px-3 text-xs font-semibold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] transition-colors hover:bg-blue-500 dark:bg-[#2563eb] dark:hover:bg-[#3b82f6]"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden />Register Terminal
        </button>
      </div>

      {/* Balanced widescreen 58/42 master-detail split with 2-3 col tactile card grid */}
      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,58%)_minmax(0,42%)] xl:items-start">
        <div className={`${PANEL} min-w-0 p-3`}>
          {list.length === 0 ? (
            <EmptyState icon={meta.icon} message={q ? "No matches for the current search." : meta.empty} />
          ) : (
            <div className="grid gap-2.5 sm:grid-cols-2 2xl:grid-cols-3">
              {list.map((item) => {
                const active = item.id === currentId;
                return (
                  <div
                    key={item.id}
                    data-selected={active || undefined}
                    onClick={() => pick(item.id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => e.key === "Enter" && pick(item.id)}
                    className={`flex min-w-0 cursor-pointer flex-col gap-2.5 rounded-xl border p-3 text-xs transition-all ${
                      active
                        ? "border-blue-500/50 bg-blue-50/70 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_0_0_1px_rgba(37,99,235,0.2)] dark:border-[#60a5fa]/50 dark:bg-[#131c2e] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_0_0_1px_rgba(96,165,250,0.2)]"
                        : "border-slate-200/80 bg-slate-50/60 hover:border-slate-300 hover:bg-white dark:border-white/[0.07] dark:bg-[#090d14] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] dark:hover:border-white/[0.14] dark:hover:bg-[#121826]"
                    }`}
                  >
                    {"callableBy" in item && (
                      <>
                        <div className="flex min-w-0 items-center justify-between gap-2">
                          <div className="flex min-w-0 items-center gap-2">
                            <Bot className="h-4 w-4 shrink-0 text-blue-600 dark:text-[#60a5fa]" />
                            <span className="min-w-0 truncate text-sm font-semibold text-slate-950 dark:text-[#edf2fb]">{item.name}</span>
                          </div>
                          <Pill dot={STATUS_DOT[item.status]} tone={statusTone(item.status)}>{item.status}</Pill>
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <KindTag>{item.kind}</KindTag>
                          <SecurityBadge callableBy={item.callableBy} dataScope={item.dataScope} />
                        </div>
                        <div className="mt-auto flex items-center justify-between gap-2 border-t border-slate-200/70 pt-2 text-[11px] text-slate-500 dark:border-white/[0.06] dark:text-[#8b97ad]">
                          <span className="truncate">Owner: <span className="font-medium text-slate-800 dark:text-[#cbd5e1]">{item.ownerName}</span></span>
                          <span className="shrink-0 font-mono">{item.capabilities.length} cap{item.capabilities.length === 1 ? "" : "s"}</span>
                        </div>
                      </>
                    )}
                    {"ownerId" in item && (
                      <>
                        <div className="flex min-w-0 items-center justify-between gap-2">
                          <div className="flex min-w-0 items-center gap-2">
                            <Monitor className="h-4 w-4 shrink-0 text-blue-600 dark:text-[#60a5fa]" />
                            <span className="min-w-0 truncate text-sm font-semibold text-slate-950 dark:text-[#edf2fb]">{item.name}</span>
                          </div>
                          <Pill dot={STATUS_DOT[item.status]} tone={statusTone(item.status)}>{item.status}</Pill>
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <KindTag>{item.kind}</KindTag>
                        </div>
                        <div className="mt-auto flex items-center justify-between gap-2 border-t border-slate-200/70 pt-2 text-[11px] text-slate-500 dark:border-white/[0.06] dark:text-[#8b97ad]">
                          <span className="truncate font-medium text-slate-700 dark:text-[#cbd5e1]">{item.ownerName}</span>
                          <span className="shrink-0 font-mono">{since(item.lastHeartbeatAt, now)}</span>
                        </div>
                      </>
                    )}
                    {"members" in item && (
                      <>
                        <div className="flex min-w-0 items-center justify-between gap-2">
                          <div className="flex min-w-0 items-center gap-2">
                            <Hash className="h-4 w-4 shrink-0 text-blue-600 dark:text-[#60a5fa]" />
                            <span className="min-w-0 truncate text-sm font-semibold text-slate-950 dark:text-[#edf2fb]">{item.name}</span>
                          </div>
                          {data.pendingApprovals.filter((p) => p.channelId === item.id).length > 0 && (
                            <Pill dot={STATUS_DOT.paused} tone="warn">
                              {data.pendingApprovals.filter((p) => p.channelId === item.id).length} pending
                            </Pill>
                          )}
                        </div>
                        <div className="mt-auto flex items-center justify-between gap-2 border-t border-slate-200/70 pt-2 text-[11px] text-slate-500 dark:border-white/[0.06] dark:text-[#8b97ad]">
                          <span>{item.members.length} members</span>
                          <span>{data.pendingApprovals.filter((p) => p.channelId === item.id).length} approvals</span>
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <section aria-label={`${meta.label} detail`} className={`${PANEL} order-first min-w-0 self-start p-4 xl:order-none`}>
          {tab === "bots" && <BotDetail bot={data.bots.find((b) => b.id === currentId)} />}
          {tab === "terminals" && <TerminalDetail terminal={data.terminals.find((t) => t.id === currentId)} viewerId={viewerId} viewerRole={viewerRole} now={now} />}
          {tab === "channels" && <ChannelDetail channel={data.channels.find((c) => c.id === currentId)} approvals={data.pendingApprovals} onDecision={onApprovalDecision} />}
        </section>
      </div>
    </div>
  );
}

function BotDetail({ bot }: { bot?: EnterpriseBot }) {
  if (!bot) return <p className="text-xs text-slate-500 dark:text-[#8b97ad]">Select a bot to inspect its capabilities.</p>;
  return (
    <div className="space-y-3.5">
      <div className="flex items-start gap-2.5 border-b border-slate-200/80 pb-3 dark:border-white/[0.06]">
        <Bot className="mt-0.5 h-4 w-4 shrink-0 text-blue-600 dark:text-[#60a5fa]" />
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-950 dark:text-[#edf2fb]">{bot.name}</h2>
        <Pill dot={STATUS_DOT[bot.status]} tone={statusTone(bot.status)}>{bot.status}</Pill>
      </div>
      <Fields rows={[["Kind", <KindTag>{bot.kind}</KindTag>], ["Owner", bot.ownerName], ["Security", <SecurityBadge callableBy={bot.callableBy} dataScope={bot.dataScope} />]]} />
      <p className="rounded-lg border border-slate-200/80 bg-slate-50/80 px-3 py-2 text-[11px] leading-4 text-slate-600 dark:border-white/[0.06] dark:bg-[#090d14] dark:text-[#8b97ad]">
        Callable by <span className="font-medium text-blue-700 dark:text-[#60a5fa]">{bot.callableBy}</span>; reads and writes <span className="font-medium text-blue-700 dark:text-[#60a5fa]">{bot.dataScope}</span> data only.
      </p>
      <div className="space-y-2">
        <SectionTitle>Capabilities</SectionTitle>
        <div className="flex flex-wrap gap-1.5">{bot.capabilities.map((c) => <KindTag key={c}>{c}</KindTag>)}</div>
      </div>
    </div>
  );
}

function TerminalDetail({ terminal, viewerId, viewerRole, now }: { terminal?: ClientTerminal; viewerId: string; viewerRole: ViewerRole; now: number }) {
  if (!terminal) return <p className="text-xs text-slate-500 dark:text-[#8b97ad]">Select a terminal to inspect heartbeat and actions.</p>;
  const exec = execPolicy(terminal, viewerId);
  const isOwner = terminal.ownerId === viewerId;
  return (
    <div className="space-y-3.5">
      <div className="flex items-start gap-2.5 border-b border-slate-200/80 pb-3 dark:border-white/[0.06]">
        <Monitor className="mt-0.5 h-4 w-4 shrink-0 text-blue-600 dark:text-[#60a5fa]" />
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-950 dark:text-[#edf2fb]">{terminal.name}</h2>
        <Pill dot={STATUS_DOT[terminal.status]} tone={statusTone(terminal.status)}>{terminal.status}</Pill>
      </div>
      <Fields rows={[["Kind", <KindTag>{terminal.kind}</KindTag>], ["Owner", terminal.ownerName], ["Last heartbeat", <span className="font-mono" title={terminal.lastHeartbeatAt ?? undefined}>{since(terminal.lastHeartbeatAt, now)}</span>], ["You", `${viewerRole}${isOwner ? " · owner" : ""}`]]} />
      <div className="flex flex-wrap gap-2" aria-label="Terminal actions">
        <button type="button" disabled={!exec.enabled} title={exec.reason ?? "Run a command on this terminal"} aria-description={exec.reason ?? undefined} data-exec-blocked={!exec.enabled || undefined} className={ACTION}>
          <Play className="h-3.5 w-3.5" aria-hidden />Exec{!exec.enabled && <Lock className="h-3 w-3" aria-hidden />}
        </button>
        <button type="button" title="Stop the running session on this terminal" className={ACTION}><Square className="h-3.5 w-3.5" aria-hidden />Stop</button>
        <button type="button" title="Revoke this terminal's access" className={ACTION}><Ban className="h-3.5 w-3.5" aria-hidden />Revoke</button>
      </div>
      {!exec.enabled && (
        <p role="note" className="flex gap-2 rounded-lg border border-amber-500/35 bg-amber-500/10 p-2.5 text-[11px] leading-4 text-amber-800 dark:border-[#f59e0b]/30 dark:bg-[#f59e0b]/10 dark:text-[#fcd34d]">
          <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />{exec.reason}
        </p>
      )}
    </div>
  );
}

function ChannelDetail({ channel, approvals, onDecision }: { channel?: Channel; approvals: PendingOwnerApproval[]; onDecision?: EnterpriseBotsProps["onApprovalDecision"] }) {
  const queue = channel ? approvals.filter((p) => p.channelId === channel.id) : approvals;
  return (
    <div className="space-y-3.5">
      <div className="flex items-start gap-2.5 border-b border-slate-200/80 pb-3 dark:border-white/[0.06]">
        <Hash className="mt-0.5 h-4 w-4 shrink-0 text-blue-600 dark:text-[#60a5fa]" />
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-950 dark:text-[#edf2fb]">{channel?.name ?? "All channels"}</h2>
      </div>
      {channel ? (
        <div className="space-y-2">
          <SectionTitle>Members · {channel.members.length}</SectionTitle>
          <div className="flex flex-wrap gap-1.5">{channel.members.map((m) => <KindTag key={m}>{m}</KindTag>)}</div>
        </div>
      ) : (
        <p className="text-xs text-slate-500 dark:text-[#8b97ad]">Select a channel to see its members.</p>
      )}
      <div className="space-y-2">
        <SectionTitle>Pending owner approvals · {queue.length}</SectionTitle>
        {queue.length === 0 ? (
          <p className="text-xs text-slate-500 dark:text-[#8b97ad]">No cross-user personal bot → personal terminal invocations waiting.</p>
        ) : queue.map((p) => (
          <div
            key={p.id}
            data-pending-approval={p.id}
            className="space-y-2 rounded-xl border border-amber-500/30 bg-amber-50/60 p-3 text-xs dark:border-[#f59e0b]/25 dark:bg-[#090d14] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]"
          >
            <div className="flex items-center gap-1.5 text-slate-950 dark:text-[#edf2fb]">
              <Bot className="h-3.5 w-3.5 text-blue-600 dark:text-[#60a5fa]" aria-hidden />
              <span className="min-w-0 flex-1 truncate font-semibold">{p.botName}</span>
              <KindTag>personal</KindTag>
            </div>
            <p className="text-slate-600 dark:text-[#8b97ad]">
              <span className="font-medium text-slate-900 dark:text-[#edf2fb]">{p.fromUserName}</span> asks to {p.action} on{" "}
              <span className="font-medium text-blue-700 dark:text-[#60a5fa]">{p.toTerminalName}</span> ({p.toOwnerName})
            </p>
            <p className="flex items-center gap-1 font-mono text-[11px] text-slate-500 dark:text-[#8b97ad]">
              <Clock className="h-3 w-3" aria-hidden />{p.requestedAt}
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => onDecision?.(p.id, "approve")}
                className="inline-flex h-7.5 cursor-pointer items-center gap-1 rounded-lg bg-blue-600 px-3 text-xs font-semibold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] transition-colors hover:bg-blue-500 dark:bg-[#2563eb] dark:hover:bg-[#3b82f6]"
              >
                Approve
              </button>
              <button type="button" onClick={() => onDecision?.(p.id, "deny")} className={ACTION}>Deny</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
