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
  "h-6 cursor-pointer rounded px-2 text-xs whitespace-nowrap transition-colors aria-pressed:bg-[#151b28] aria-pressed:text-[#e6edf7] aria-pressed:shadow-[inset_0_0_0_1px_#242d3f] text-[#8b97ad] hover:text-[#e6edf7]";
const PANEL = "rounded-md border border-[#242d3f] bg-[#151b28]";
const ACTION =
  "inline-flex h-7 cursor-pointer items-center gap-1 rounded-md border border-[#242d3f] bg-[#111622] px-2 text-xs text-[#e6edf7] transition-colors hover:bg-[#1a2131] disabled:cursor-not-allowed disabled:opacity-50";
const STATUS_DOT: Record<TerminalStatus | BotStatus, string> = { online: "bg-[#34d399]", offline: "bg-[#8b97ad]", active: "bg-[#34d399]", paused: "bg-[#fbbf24]", revoked: "bg-[#8b97ad]" };
const FIELD = "grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs";

function since(iso: string | null, now: number): string {
  if (!iso) return "never";
  const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}
function Pill({ children, dot }: { children: ReactNode; dot: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-[#242d3f] bg-[#111622] px-2 py-0.5 text-[11px] font-medium text-[#e6edf7]">
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      {children}
    </span>
  );
}
/** 2-axis security badge: who may call the bot × whose data it can touch. */
export function SecurityBadge({ callableBy, dataScope }: { callableBy: CallableBy; dataScope: DataScope }) {
  return (
    <span data-security-badge title={`Callable by ${callableBy} · data scope ${dataScope}`}
      className="inline-flex items-center gap-1 rounded border border-[#242d3f] bg-[#0b0e14] px-1.5 py-0.5 font-mono text-[11px] text-[#5f8dff]">
      <Lock className="h-3 w-3" aria-hidden />
      {callableBy} × {dataScope}
    </span>
  );
}
function KindTag({ children }: { children: ReactNode }) {
  return <span className="rounded border border-[#242d3f] bg-[#0b0e14] px-1.5 py-0.5 font-mono text-[11px] text-[#8b97ad]">{children}</span>;
}
function Fields({ rows }: { rows: [string, ReactNode][] }) {
  return <dl className={FIELD}>{rows.map(([k, v]) => <div key={k} className="contents"><dt className="text-[#8b97ad]">{k}</dt><dd className="truncate">{v}</dd></div>)}</dl>;
}
function SectionTitle({ children }: { children: ReactNode }) {
  return <h3 className="text-[11px] uppercase tracking-[0.16em] text-[#8b97ad]">{children}</h3>;
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
    { label: "Shared Channels", value: data.channels.length, dot: "bg-[#5f8dff]", tab: "channels" },
    { label: "Pending Owner Approvals", value: data.pendingApprovals.length, dot: data.pendingApprovals.length ? STATUS_DOT.paused : STATUS_DOT.offline, tab: "channels" },
  ] as const;

  return (
    <div className="space-y-2 tabular-nums">
      {/* 1-row 4-column telemetry strip; cells jump to their tab */}
      <div className="cockpit-strip w-full gap-0" role="group" aria-label="Enterprise bot telemetry">
        {strip.map((cell) => (
          <button key={cell.label} type="button" onClick={() => setTab(cell.tab)}
            className={`cockpit-cell min-w-0 flex-1 justify-center transition-colors ${tab === cell.tab ? "bg-[#151b28] text-[#e6edf7] shadow-[inset_0_-1px_0_#5f8dff]" : "hover:bg-[#151b28] hover:text-[#e6edf7]"}`}>
            <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${cell.dot}`} />
            <span className="truncate uppercase tracking-wide">{cell.label}</span>
            <b className="ml-1">{cell.value}</b>
          </button>
        ))}
      </div>

      {/* 40px unified segmented toolbar */}
      <div className="cockpit-toolbar h-10 rounded-md border border-[#242d3f] bg-[#111622] px-2">
        <div role="group" aria-label="Enterprise bot views" className="flex shrink-0 items-center gap-0.5 rounded-md border border-[#242d3f] bg-[#0b0e14] p-0.5">
          {TABS.map((t) => (
            <button key={t.key} type="button" data-tab={t.key} aria-pressed={tab === t.key} onClick={() => setTab(t.key)} className={TAB_CLASS}>
              <t.icon className="mr-1 inline h-3 w-3 align-[-2px]" aria-hidden />{t.label}
            </button>
          ))}
        </div>
        <div className="relative ml-2 min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#8b97ad]" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={`Search ${meta.label.toLowerCase()}...`} aria-label="Search enterprise bots"
            className="h-7 w-full rounded-md border border-[#242d3f] bg-[#0b0e14] pl-7 pr-2 text-xs text-[#e6edf7] outline-none placeholder:text-[#8b97ad] focus:border-[#5f8dff] focus:ring-[#5f8dff]/40" />
        </div>
        <button type="button" onClick={onRegisterTerminal}
          className="ml-2 inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-md bg-[#2563eb] px-2.5 text-xs font-medium text-white transition-colors hover:bg-[#5f8dff]">
          <Plus className="h-3.5 w-3.5" aria-hidden />Register Terminal
        </button>
      </div>

      {/* Master-detail split: list left, inspector right (stacks below xl) */}
      <div className="grid min-w-0 gap-3 xl:grid-cols-[minmax(0,1fr)_23.5rem]">
        <div className={`${PANEL} min-w-0 overflow-hidden`}>
          {list.length === 0 ? (
            <EmptyState icon={meta.icon} message={q ? "No matches for the current search." : meta.empty} />
          ) : (
            list.map((item) => {
              const active = item.id === currentId;
              return (
                <div key={item.id} data-selected={active || undefined} onClick={() => pick(item.id)} role="button" tabIndex={0}
                  onKeyDown={(e) => e.key === "Enter" && pick(item.id)}
                  className={`flex min-w-0 cursor-pointer items-center gap-3 border-b border-[#242d3f] px-3 py-2 text-xs last:border-b-0 ${active ? "bg-[#2563eb]/15 shadow-[inset_2px_0_0_#5f8dff]" : "hover:bg-[#1a2131]"}`}>
                  {"callableBy" in item && <><Bot className="h-3.5 w-3.5 shrink-0 text-[#8b97ad]" /><span className="min-w-0 flex-1 truncate text-sm font-medium text-[#e6edf7]">{item.name}</span><KindTag>{item.kind}</KindTag><SecurityBadge callableBy={item.callableBy} dataScope={item.dataScope} /><Pill dot={STATUS_DOT[item.status]}>{item.status}</Pill></>}
                  {"ownerId" in item && <><Monitor className="h-3.5 w-3.5 shrink-0 text-[#8b97ad]" /><span className="min-w-0 flex-1 truncate text-sm font-medium text-[#e6edf7]">{item.name}</span><KindTag>{item.kind}</KindTag><span className="w-24 truncate text-[#8b97ad]">{item.ownerName}</span><span className="w-20 text-right text-[#8b97ad]">{since(item.lastHeartbeatAt, now)}</span><Pill dot={STATUS_DOT[item.status]}>{item.status}</Pill></>}
                  {"members" in item && <><Hash className="h-3.5 w-3.5 shrink-0 text-[#8b97ad]" /><span className="min-w-0 flex-1 truncate text-sm font-medium text-[#e6edf7]">{item.name}</span><span className="text-[#8b97ad]">{item.members.length} members</span><span className="text-[#8b97ad]">{data.pendingApprovals.filter((p) => p.channelId === item.id).length} approvals</span></>}
                </div>
              );
            })
          )}
        </div>
        <section aria-label={`${meta.label} detail`} className={`${PANEL} order-first min-w-0 self-start p-3 xl:order-none`}>
          {tab === "bots" && <BotDetail bot={data.bots.find((b) => b.id === currentId)} />}
          {tab === "terminals" && <TerminalDetail terminal={data.terminals.find((t) => t.id === currentId)} viewerId={viewerId} viewerRole={viewerRole} now={now} />}
          {tab === "channels" && <ChannelDetail channel={data.channels.find((c) => c.id === currentId)} approvals={data.pendingApprovals} onDecision={onApprovalDecision} />}
        </section>
      </div>
    </div>
  );
}

function BotDetail({ bot }: { bot?: EnterpriseBot }) {
  if (!bot) return <p className="text-xs text-[#8b97ad]">Select a bot to inspect its capabilities.</p>;
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2"><Bot className="mt-0.5 h-4 w-4 shrink-0 text-[#5f8dff]" /><h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-[#e6edf7]">{bot.name}</h2><Pill dot={STATUS_DOT[bot.status]}>{bot.status}</Pill></div>
      <Fields rows={[["Kind", <KindTag>{bot.kind}</KindTag>], ["Owner", bot.ownerName], ["Security", <SecurityBadge callableBy={bot.callableBy} dataScope={bot.dataScope} />]]} />
      <p className="text-[11px] leading-4 text-[#8b97ad]">Callable by <span className="text-[#5f8dff]">{bot.callableBy}</span>; reads and writes <span className="text-[#5f8dff]">{bot.dataScope}</span> data only.</p>
      <SectionTitle>Capabilities</SectionTitle>
      <div className="flex flex-wrap gap-1">{bot.capabilities.map((c) => <KindTag key={c}>{c}</KindTag>)}</div>
    </div>
  );
}

function TerminalDetail({ terminal, viewerId, viewerRole, now }: { terminal?: ClientTerminal; viewerId: string; viewerRole: ViewerRole; now: number }) {
  if (!terminal) return <p className="text-xs text-[#8b97ad]">Select a terminal to inspect heartbeat and actions.</p>;
  const exec = execPolicy(terminal, viewerId);
  const isOwner = terminal.ownerId === viewerId;
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2"><Monitor className="mt-0.5 h-4 w-4 shrink-0 text-[#5f8dff]" /><h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-[#e6edf7]">{terminal.name}</h2><Pill dot={STATUS_DOT[terminal.status]}>{terminal.status}</Pill></div>
      <Fields rows={[["Kind", <KindTag>{terminal.kind}</KindTag>], ["Owner", terminal.ownerName], ["Last heartbeat", <span title={terminal.lastHeartbeatAt ?? undefined}>{since(terminal.lastHeartbeatAt, now)}</span>], ["You", `${viewerRole}${isOwner ? " · owner" : ""}`]]} />
      <div className="flex flex-wrap gap-2" aria-label="Terminal actions">
        <button type="button" disabled={!exec.enabled} title={exec.reason ?? "Run a command on this terminal"} aria-description={exec.reason ?? undefined} data-exec-blocked={!exec.enabled || undefined} className={ACTION}>
          <Play className="h-3.5 w-3.5" aria-hidden />Exec{!exec.enabled && <Lock className="h-3 w-3" aria-hidden />}
        </button>
        <button type="button" title="Stop the running session on this terminal" className={ACTION}><Square className="h-3.5 w-3.5" aria-hidden />Stop</button>
        <button type="button" title="Revoke this terminal's access" className={ACTION}><Ban className="h-3.5 w-3.5" aria-hidden />Revoke</button>
      </div>
      {!exec.enabled && <p role="note" className="flex gap-1.5 text-[11px] leading-4 text-[#fbbf24]"><Lock className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />{exec.reason}</p>}
    </div>
  );
}

function ChannelDetail({ channel, approvals, onDecision }: { channel?: Channel; approvals: PendingOwnerApproval[]; onDecision?: EnterpriseBotsProps["onApprovalDecision"] }) {
  const queue = channel ? approvals.filter((p) => p.channelId === channel.id) : approvals;
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2"><Hash className="mt-0.5 h-4 w-4 shrink-0 text-[#5f8dff]" /><h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-[#e6edf7]">{channel?.name ?? "All channels"}</h2></div>
      {channel ? <><SectionTitle>Members · {channel.members.length}</SectionTitle><div className="flex flex-wrap gap-1">{channel.members.map((m) => <KindTag key={m}>{m}</KindTag>)}</div></> : <p className="text-xs text-[#8b97ad]">Select a channel to see its members.</p>}
      <SectionTitle>Pending owner approvals · {queue.length}</SectionTitle>
      {queue.length === 0 ? <p className="text-xs text-[#8b97ad]">No cross-user personal bot → personal terminal invocations waiting.</p> : queue.map((p) => (
        <div key={p.id} data-pending-approval={p.id} className="space-y-1.5 rounded-md border border-[#242d3f] bg-[#111622] p-2 text-xs">
          <div className="flex items-center gap-1.5 text-[#e6edf7]"><Bot className="h-3.5 w-3.5 text-[#5f8dff]" aria-hidden /><span className="min-w-0 flex-1 truncate font-medium">{p.botName}</span><KindTag>personal</KindTag></div>
          <p className="text-[#8b97ad]"><span className="text-[#e6edf7]">{p.fromUserName}</span> asks to {p.action} on <span className="text-[#5f8dff]">{p.toTerminalName}</span> ({p.toOwnerName})</p>
          <p className="flex items-center gap-1 text-[11px] text-[#8b97ad]"><Clock className="h-3 w-3" aria-hidden />{p.requestedAt}</p>
          <div className="flex gap-1.5">
            <button type="button" onClick={() => onDecision?.(p.id, "approve")} className={`${ACTION} border-[#2563eb] bg-[#2563eb] hover:bg-[#5f8dff]`}>Approve</button>
            <button type="button" onClick={() => onDecision?.(p.id, "deny")} className={ACTION}>Deny</button>
          </div>
        </div>
      ))}
    </div>
  );
}
