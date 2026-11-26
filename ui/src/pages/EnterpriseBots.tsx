import { useContext, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { QueryClientContext, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  Ban,
  Bot,
  Check,
  Clock,
  Copy,
  Hash,
  KeyRound,
  Lock,
  Monitor,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Square,
  Trash2,
  X,
} from "lucide-react";
import type { Company, CompanySecret } from "@paperclipai/shared";
import { authApi } from "../api/auth";
import {
  enterpriseBotsApi,
  type BotCapabilityMatrixEntry,
  type BotTerminalAction,
  type BotTerminalTransport,
  type CreateBotInput,
  type CreateBotResponse,
  type EnterpriseBotAuditEvent,
  type EnterpriseBotCallableBy,
  type EnterpriseBotsSnapshot,
  type HealthSample,
  type PingBotResponse,
  type RegisterTerminalResponse,
  type TerminalTelemetry,
  type UpdateBotInput,
} from "../api/enterprise-bots";
import { secretsApi } from "../api/secrets";
import { EmptyState } from "../components/EmptyState";
import { ApprovalQueueDrawer } from "../components/enterprise-bots/ApprovalQueueDrawer";
import { BotHealthSparkline } from "../components/enterprise-bots/BotHealthSparkline";
import { CapabilityMatrix, type BotCapabilityRule } from "../components/enterprise-bots/CapabilityMatrix";
import {
  ChannelInvokePreview,
  type ChannelAuditEntry,
  type ChannelInvokePreviewRequest,
  type ChannelInvokePreviewResult,
} from "../components/enterprise-bots/ChannelInvokePreview";
import { TerminalPairingBanner } from "../components/enterprise-bots/TerminalPairingBanner";
import { TerminalTelemetryCard } from "../components/enterprise-bots/TerminalTelemetryCard";
import { CompanyContext } from "../context/CompanyContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";

/* ── Enterprise Bot Cockpit: OpenBots, client terminals, channels & @mentions ──
 * Supports both live API mode (via CompanyContext + TanStack Query) and pure
 * injected `initialData` mode for deterministic unit tests without providers. */

export type BotKind = "personal" | "team" | "company";
export type CallableBy = "owner" | "self_only" | "team" | "company";
export type DataScope = "self" | "team" | "company";
export type BotStatus = "active" | "paused" | "revoked";
export type TerminalKind = "personal_terminal" | "worker_node";
export type TerminalStatus = "online" | "offline" | "revoked";
export type ViewerRole = "owner" | "admin" | "member";

export interface EnterpriseBot {
  id: string;
  name: string;
  kind: BotKind;
  status: BotStatus;
  callableBy: CallableBy;
  dataScope: DataScope;
  capabilities: string[];
  capabilityRules?: BotCapabilityRule[];
  ownerName: string;
  webhookUrl?: string | null;
  apiSecretId?: string | null;
  lastPingStatus?: string | null;
  lastPingLatencyMs?: number | null;
  healthHistory?: HealthSample[];
}

export interface ClientTerminal {
  id: string;
  name: string;
  kind: TerminalKind;
  status: TerminalStatus;
  ownerId: string;
  ownerName: string;
  lastHeartbeatAt: string | null;
  transport?: BotTerminalTransport;
  telemetry?: TerminalTelemetry | null;
  healthHistory?: HealthSample[];
}

export interface Channel {
  id: string;
  name: string;
  members: string[];
}

export interface PendingOwnerApproval {
  id: string;
  channelId: string;
  botId: string;
  botName: string;
  fromUserName: string;
  toTerminalId: string;
  toTerminalName: string;
  toOwnerName: string;
  action: string;
  requestedAt: string;
}

export interface EnterpriseBotsData {
  bots: EnterpriseBot[];
  terminals: ClientTerminal[];
  channels: Channel[];
  pendingApprovals: PendingOwnerApproval[];
  now?: string;
}

export interface AttachBotSubmitPayload extends CreateBotInput {
  newSecretName?: string;
  newSecretValue?: string;
}

export interface RegisterTerminalSubmitPayload {
  name: string;
  kind: TerminalKind;
  transport: BotTerminalTransport;
}

export interface EnterpriseBotsProps {
  /** Injected state; when omitted in live mode, fetches company snapshot via API. */
  initialData?: EnterpriseBotsData;
  viewerId?: string;
  viewerRole?: ViewerRole;
  onRegisterTerminal?: () => void;
  onApprovalDecision?: (approvalId: string, decision: "approve" | "deny") => void;
  onCreateBot?: (input: AttachBotSubmitPayload) => Promise<CreateBotResponse | void> | CreateBotResponse | void;
  onRegisterTerminalSubmit?: (
    input: RegisterTerminalSubmitPayload,
  ) => Promise<RegisterTerminalResponse | void> | RegisterTerminalResponse | void;
  onPingBot?: (botId: string) => Promise<PingBotResponse | void> | PingBotResponse | void;
  onUpdateBot?: (botId: string, patch: UpdateBotInput) => Promise<unknown> | void;
  onUpdateBotCapabilities?: (botId: string, capabilities: BotCapabilityMatrixEntry[]) => Promise<unknown> | void;
  onDeleteBot?: (botId: string) => Promise<unknown> | void;
  onCommandTerminal?: (terminalId: string, action: BotTerminalAction) => Promise<unknown> | void;
  onPreviewChannelInvoke?: (
    request: ChannelInvokePreviewRequest,
  ) => Promise<ChannelInvokePreviewResult | void> | ChannelInvokePreviewResult | void;
  auditEntries?: ChannelAuditEntry[];
}

export const EXEC_OWNER_ONLY_REASON =
  "Exec is owner-only on a personal terminal. Non-owner admins can Stop or Revoke this session but cannot run commands as its owner.";

/** Exec policy: worker nodes are shared; a personal terminal only executes for its owner. */
export function execPolicy(terminal: ClientTerminal, viewerId: string): { enabled: boolean; reason: string | null } {
  if (terminal.kind !== "personal_terminal" || terminal.ownerId === viewerId) return { enabled: true, reason: null };
  return { enabled: false, reason: EXEC_OWNER_ONLY_REASON };
}

function resolveViewerRole(explicitRole: ViewerRole | undefined, selectedCompany: Company | null): ViewerRole {
  if (explicitRole) return explicitRole;
  const companyRole = (selectedCompany as (Company & { myRole?: unknown }) | null)?.myRole;
  if (companyRole === "owner" || companyRole === "admin" || companyRole === "member") {
    return companyRole;
  }
  return "member";
}

function normalizeSnapshot(snapshot: EnterpriseBotsSnapshot): EnterpriseBotsData {
  return {
    now: snapshot.now ?? new Date().toISOString(),
    bots: (snapshot.bots ?? []).map((b) => ({
      id: b.id,
      name: b.name,
      kind: b.kind,
      status: b.status,
      callableBy: b.callableBy,
      dataScope: b.dataScope ?? "self",
      capabilities: b.capabilities ?? [],
      ownerName: b.ownerName ?? b.ownerUserId ?? "Company",
      webhookUrl: b.webhookUrl ?? null,
      apiSecretId: b.apiSecretId ?? null,
      lastPingStatus: b.lastPingStatus ?? null,
      lastPingLatencyMs: b.lastPingLatencyMs ?? null,
      healthHistory: b.healthHistory ?? [],
    })),
    terminals: (snapshot.terminals ?? []).map((t) => ({
      id: t.id,
      name: t.name,
      kind: t.kind,
      status: t.status,
      ownerId: t.ownerUserId ?? "",
      ownerName: t.ownerName ?? t.ownerUserId ?? "Company",
      lastHeartbeatAt: t.lastHeartbeatAt ?? t.lastSeenAt ?? null,
      transport: t.transport,
      telemetry: t.telemetry ?? null,
      healthHistory: t.healthHistory ?? [],
    })),
    channels: (snapshot.channels ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      members: c.members ?? [],
    })),
    pendingApprovals: snapshot.pendingApprovals ?? [],
  };
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

interface IssuedTokenBanner {
  label: string;
  token: string;
  hint: string;
}

interface PairingBannerState {
  terminalId: string;
  terminalName: string;
  oneTimeToken: string;
  lastSeenAt: string | null;
}

function mapAuditEvents(events: EnterpriseBotAuditEvent[]): ChannelAuditEntry[] {
  return events.map((ev) => {
    const details = ev.details ?? {};
    const outcome =
      typeof details.outcome === "string"
        ? details.outcome
        : typeof details.decision === "string"
          ? details.decision
          : "recorded";
    const detail =
      typeof details.reason === "string"
        ? details.reason
        : typeof details.capabilityKey === "string"
          ? `${details.capabilityKey}${typeof details.executionTarget === "string" ? ` · ${details.executionTarget}` : ""}`
          : null;
    return {
      id: ev.id,
      timestamp: ev.createdAt,
      actor: ev.actorId || ev.actorType,
      action: ev.action,
      outcome,
      detail,
    };
  });
}

function toCapabilityRules(bot: EnterpriseBot): BotCapabilityRule[] {
  if (bot.capabilityRules) return bot.capabilityRules;
  const defaultCallable: EnterpriseBotCallableBy =
    bot.callableBy === "owner" ? "self_only" : bot.callableBy;
  return bot.capabilities.map((capabilityKey) => ({
    capabilityKey,
    callableBy: defaultCallable,
    dataScope: bot.dataScope,
    requiresApproval: bot.kind === "personal",
  }));
}

const TAB_CLASS =
  "h-7 cursor-pointer rounded-md px-2.5 text-xs font-medium whitespace-nowrap transition-colors aria-pressed:bg-white aria-pressed:text-slate-950 aria-pressed:shadow-[0_1px_2px_rgba(15,23,42,0.08)] dark:aria-pressed:bg-[#141c2b] dark:aria-pressed:text-[#edf2fb] dark:aria-pressed:shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] text-slate-600 hover:text-slate-950 dark:text-[#8b97ad] dark:hover:text-[#edf2fb]";
const PANEL =
  "tactile-card rounded-xl border border-slate-200/90 bg-white dark:bg-none dark:border-white/[0.08] dark:bg-[#0e131d]";
const ACTION =
  "inline-flex h-7.5 cursor-pointer items-center gap-1.5 rounded-lg border border-slate-200/90 bg-white px-2.5 text-xs font-medium text-slate-800 transition-colors hover:border-blue-500/40 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/[0.1] dark:bg-[#090d14] dark:text-[#edf2fb] dark:hover:border-[#60a5fa]/40 dark:hover:bg-[#141b29]";
const DANGER_ACTION =
  "inline-flex h-7.5 cursor-pointer items-center gap-1.5 rounded-lg border border-rose-500/30 bg-rose-500/10 px-2.5 text-xs font-medium text-rose-700 transition-colors hover:border-rose-500/50 hover:bg-rose-500/15 disabled:cursor-not-allowed disabled:opacity-50 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300 dark:hover:bg-rose-500/20";
const INPUT_CLASS =
  "h-8 w-full rounded-lg border border-slate-200/90 bg-white px-2.5 text-xs text-slate-900 outline-none placeholder:text-slate-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-white/[0.09] dark:bg-[#090d14] dark:text-[#edf2fb] dark:placeholder:text-[#8b97ad] dark:focus:border-[#60a5fa] dark:focus:ring-[#60a5fa]/25";
const STATUS_DOT: Record<TerminalStatus | BotStatus, string> = {
  online: "bg-lime-500 shadow-[0_0_8px_rgba(163,230,53,0.7)] animate-pulse dark:bg-[#a3e635]",
  offline: "bg-slate-400 dark:bg-[#64748b]",
  active: "bg-lime-500 shadow-[0_0_8px_rgba(163,230,53,0.7)] animate-pulse dark:bg-[#a3e635]",
  paused: "bg-amber-500 shadow-[0_0_6px_rgba(245,158,11,0.55)] dark:bg-[#f59e0b]",
  revoked: "bg-slate-400 dark:bg-[#64748b]",
};
const FIELD = "grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs";

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

export function EnterpriseBots(props: EnterpriseBotsProps) {
  const companyCtx = useContext(CompanyContext);
  const queryClient = useContext(QueryClientContext);

  if (!props.initialData && companyCtx?.selectedCompanyId && queryClient) {
    return (
      <LiveEnterpriseBots
        {...props}
        companyId={companyCtx.selectedCompanyId}
        selectedCompany={companyCtx.selectedCompany}
      />
    );
  }

  return (
    <EnterpriseBotsCockpit
      data={props.initialData ?? DEMO}
      viewerId={props.viewerId ?? ""}
      viewerRole={resolveViewerRole(props.viewerRole, companyCtx?.selectedCompany ?? null)}
      secrets={[]}
      isLoading={false}
      loadError={null}
      onRegisterTerminal={props.onRegisterTerminal}
      onApprovalDecision={props.onApprovalDecision}
      onCreateBot={props.onCreateBot}
      onRegisterTerminalSubmit={props.onRegisterTerminalSubmit}
      onPingBot={props.onPingBot}
      onUpdateBot={props.onUpdateBot}
      onUpdateBotCapabilities={props.onUpdateBotCapabilities}
      onDeleteBot={props.onDeleteBot}
      onCommandTerminal={props.onCommandTerminal}
      onPreviewChannelInvoke={props.onPreviewChannelInvoke}
      auditEntries={props.auditEntries ?? []}
    />
  );
}

function LiveEnterpriseBots({
  companyId,
  selectedCompany,
  viewerId,
  viewerRole,
  onRegisterTerminal,
  onApprovalDecision,
  onCreateBot,
  onRegisterTerminalSubmit,
  onPingBot,
  onUpdateBot,
  onUpdateBotCapabilities,
  onDeleteBot,
  onCommandTerminal,
  onPreviewChannelInvoke,
  auditEntries,
}: EnterpriseBotsProps & { companyId: string; selectedCompany: Company | null }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();

  const snapshotQuery = useQuery({
    queryKey: queryKeys.enterpriseBots.snapshot(companyId),
    queryFn: () => enterpriseBotsApi.getSnapshot(companyId),
  });

  const auditQuery = useQuery({
    queryKey: queryKeys.enterpriseBots.audit(companyId),
    queryFn: () => enterpriseBotsApi.getAudit(companyId, 50),
  });

  const secretsQuery = useQuery({
    queryKey: queryKeys.secrets.list(companyId),
    queryFn: () => secretsApi.list(companyId),
  });

  const sessionQuery = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });

  const resolvedViewerId = viewerId ?? sessionQuery.data?.user?.id ?? "";
  const resolvedViewerRole = resolveViewerRole(viewerRole, selectedCompany);
  const normalizedData = useMemo<EnterpriseBotsData>(
    () =>
      snapshotQuery.data
        ? normalizeSnapshot(snapshotQuery.data)
        : { bots: [], terminals: [], channels: [], pendingApprovals: [] },
    [snapshotQuery.data],
  );
  const resolvedAuditEntries = useMemo<ChannelAuditEntry[]>(
    () => auditEntries ?? mapAuditEvents(auditQuery.data?.events ?? []),
    [auditEntries, auditQuery.data],
  );

  const invalidateSnapshot = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.enterpriseBots.snapshot(companyId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.enterpriseBots.audit(companyId) }),
    ]);

  const handleCreateBot = async (input: AttachBotSubmitPayload) => {
    if (onCreateBot) return onCreateBot(input);
    let apiSecretId = input.apiSecretId ?? null;
    if (input.newSecretName && input.newSecretValue) {
      const createdSecret = await secretsApi.create(companyId, {
        name: input.newSecretName,
        value: input.newSecretValue,
      });
      apiSecretId = createdSecret.id;
      void queryClient.invalidateQueries({ queryKey: queryKeys.secrets.list(companyId) });
    }
    const { newSecretName: _n, newSecretValue: _v, ...botBody } = input;
    const result = await enterpriseBotsApi.createBot(companyId, {
      ...botBody,
      apiSecretId,
    });
    await invalidateSnapshot();
    pushToast({
      title: `OpenBot "${result.bot.name}" attached`,
      body: result.inboundToken ? "Copy the one-time inbound token now." : undefined,
      tone: "success",
    });
    return result;
  };

  const handleRegisterTerminalSubmit = async (input: RegisterTerminalSubmitPayload) => {
    if (onRegisterTerminalSubmit) return onRegisterTerminalSubmit(input);
    const result = await enterpriseBotsApi.registerTerminal({
      companyId,
      name: input.name,
      kind: input.kind,
      transport: input.transport,
    });
    await invalidateSnapshot();
    pushToast({
      title: `Terminal "${result.terminal.name}" registered`,
      body: "Copy the one-time terminal token now.",
      tone: "success",
    });
    return result;
  };

  const handlePingBot = async (botId: string) => {
    if (onPingBot) return onPingBot(botId);
    const result = await enterpriseBotsApi.pingBot(companyId, botId);
    pushToast({
      title: result.ok ? "Bot ping succeeded" : "Bot ping failed",
      body: result.ok
        ? [result.status != null ? `HTTP ${result.status}` : null, result.latencyMs != null ? `${result.latencyMs}ms` : null]
            .filter(Boolean)
            .join(" · ") || "Reachable"
        : result.error ?? `Status ${result.status ?? "error"}`,
      tone: result.ok ? "success" : "error",
    });
    return result;
  };

  const handleUpdateBot = async (botId: string, patch: UpdateBotInput) => {
    if (onUpdateBot) return onUpdateBot(botId, patch);
    const result = await enterpriseBotsApi.updateBot(companyId, botId, patch);
    await invalidateSnapshot();
    pushToast({
      title: patch.status === "paused" ? "Bot paused" : patch.status === "active" ? "Bot resumed" : "Bot updated",
      body: result.bot.name,
      tone: "success",
    });
    return result;
  };

  const handleUpdateBotCapabilities = async (botId: string, capabilities: BotCapabilityMatrixEntry[]) => {
    if (onUpdateBotCapabilities) return onUpdateBotCapabilities(botId, capabilities);
    const result = await enterpriseBotsApi.updateBotCapabilities(companyId, botId, capabilities);
    await invalidateSnapshot();
    pushToast({
      title: "Bot capabilities saved",
      body: `${result.bot.name} (${result.capabilities.length})`,
      tone: "success",
    });
    return result;
  };

  const handlePreviewChannelInvoke = async (
    request: ChannelInvokePreviewRequest,
  ): Promise<ChannelInvokePreviewResult | void> => {
    if (onPreviewChannelInvoke) return onPreviewChannelInvoke(request);
    const res = await enterpriseBotsApi.previewChannelInvoke(request.channelId, {
      companyId,
      targetBotId: request.targetBotId,
      capabilityKey: request.capabilityKey,
      executionTarget: request.executionTarget === "channel_only" ? "none" : request.executionTarget,
    });
    return {
      outcome: res.outcome,
      forcedFilter: res.forcedFilter,
      reasonCode: res.reason,
      summary: res.reason,
    };
  };

  const handleDeleteBot = async (botId: string) => {
    if (onDeleteBot) return onDeleteBot(botId);
    const result = await enterpriseBotsApi.deleteBot(companyId, botId);
    await invalidateSnapshot();
    pushToast({ title: "Bot revoked", tone: "warn" });
    return result;
  };

  const handleCommandTerminal = async (terminalId: string, action: BotTerminalAction) => {
    if (onCommandTerminal) return onCommandTerminal(terminalId, action);
    const result = await enterpriseBotsApi.commandTerminal(terminalId, { companyId, action });
    await invalidateSnapshot();
    pushToast({
      title: `Terminal ${action} ${result.decision.allowed ? "sent" : "blocked"}`,
      body: result.decision.reason || result.terminal.name,
      tone: result.decision.allowed ? "success" : "warn",
    });
    return result;
  };

  const handleApprovalDecision = async (approvalId: string, decision: "approve" | "deny") => {
    if (onApprovalDecision) {
      onApprovalDecision(approvalId, decision);
      return;
    }
    const apiDecision = decision === "approve" ? "approved" : "rejected";
    await enterpriseBotsApi.decideApproval(companyId, approvalId, apiDecision);
    await invalidateSnapshot();
    pushToast({
      title: decision === "approve" ? "Channel invocation approved" : "Channel invocation denied",
      tone: decision === "approve" ? "success" : "warn",
    });
  };

  return (
    <EnterpriseBotsCockpit
      data={normalizedData}
      viewerId={resolvedViewerId}
      viewerRole={resolvedViewerRole}
      secrets={secretsQuery.data ?? []}
      isLoading={snapshotQuery.isLoading}
      loadError={snapshotQuery.error instanceof Error ? snapshotQuery.error.message : null}
      onRetry={() => void snapshotQuery.refetch()}
      onRegisterTerminal={onRegisterTerminal}
      onApprovalDecision={handleApprovalDecision}
      onCreateBot={handleCreateBot}
      onRegisterTerminalSubmit={handleRegisterTerminalSubmit}
      onPingBot={handlePingBot}
      onUpdateBot={handleUpdateBot}
      onUpdateBotCapabilities={handleUpdateBotCapabilities}
      onDeleteBot={handleDeleteBot}
      onCommandTerminal={handleCommandTerminal}
      onPreviewChannelInvoke={handlePreviewChannelInvoke}
      auditEntries={resolvedAuditEntries}
      onActionError={(title, err) =>
        pushToast({
          title,
          body: err instanceof Error ? err.message : "Request failed",
          tone: "error",
        })
      }
    />
  );
}

interface EnterpriseBotsCockpitProps {
  data: EnterpriseBotsData;
  viewerId: string;
  viewerRole: ViewerRole;
  secrets: CompanySecret[];
  isLoading: boolean;
  loadError: string | null;
  onRetry?: () => void;
  onRegisterTerminal?: () => void;
  onApprovalDecision?: (approvalId: string, decision: "approve" | "deny") => Promise<void> | void;
  onCreateBot?: (input: AttachBotSubmitPayload) => Promise<CreateBotResponse | void> | CreateBotResponse | void;
  onRegisterTerminalSubmit?: (
    input: RegisterTerminalSubmitPayload,
  ) => Promise<RegisterTerminalResponse | void> | RegisterTerminalResponse | void;
  onPingBot?: (botId: string) => Promise<PingBotResponse | void> | PingBotResponse | void;
  onUpdateBot?: (botId: string, patch: UpdateBotInput) => Promise<unknown> | void;
  onUpdateBotCapabilities?: (botId: string, capabilities: BotCapabilityMatrixEntry[]) => Promise<unknown> | void;
  onDeleteBot?: (botId: string) => Promise<unknown> | void;
  onCommandTerminal?: (terminalId: string, action: BotTerminalAction) => Promise<unknown> | void;
  onPreviewChannelInvoke?: (
    request: ChannelInvokePreviewRequest,
  ) => Promise<ChannelInvokePreviewResult | void> | ChannelInvokePreviewResult | void;
  auditEntries: ChannelAuditEntry[];
  onActionError?: (title: string, err: unknown) => void;
}

function EnterpriseBotsCockpit({
  data,
  viewerId,
  viewerRole,
  secrets,
  isLoading,
  loadError,
  onRetry,
  onRegisterTerminal,
  onApprovalDecision,
  onCreateBot,
  onRegisterTerminalSubmit,
  onPingBot,
  onUpdateBot,
  onUpdateBotCapabilities,
  onDeleteBot,
  onCommandTerminal,
  onPreviewChannelInvoke,
  auditEntries,
  onActionError,
}: EnterpriseBotsCockpitProps) {
  const [tab, setTab] = useState<Tab>("bots");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Partial<Record<Tab, string>>>({});
  const [attachOpen, setAttachOpen] = useState(false);
  const [registerTerminalOpen, setRegisterTerminalOpen] = useState(false);
  const [approvalDrawerOpen, setApprovalDrawerOpen] = useState(false);
  const [issuedToken, setIssuedToken] = useState<IssuedTokenBanner | null>(null);
  const [pairingBanner, setPairingBanner] = useState<PairingBannerState | null>(null);
  const [tokenCopied, setTokenCopied] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [pingResults, setPingResults] = useState<Record<string, PingBotResponse>>({});
  const [pingSamples, setPingSamples] = useState<Record<string, HealthSample[]>>({});
  const now = Date.parse(data.now ?? new Date().toISOString());
  const canAdmin = viewerRole === "owner" || viewerRole === "admin";
  const serverUrl =
    typeof window !== "undefined" && window.location?.origin ? window.location.origin : "http://localhost:3100";
  const pairedTerminal = pairingBanner
    ? data.terminals.find((t) => t.id === pairingBanner.terminalId)
    : undefined;

  const q = search.trim().toLowerCase();
  const lists = useMemo(
    () => ({
      bots: data.bots.filter((b) => !q || `${b.name} ${b.ownerName} ${b.kind}`.toLowerCase().includes(q)),
      terminals: data.terminals.filter((t) => !q || `${t.name} ${t.ownerName} ${t.kind}`.toLowerCase().includes(q)),
      channels: data.channels.filter((c) => !q || `${c.name} ${c.members.join(" ")}`.toLowerCase().includes(q)),
    }),
    [data, q],
  );
  const list = lists[tab];
  const currentId = list.some((item) => item.id === selected[tab]) ? selected[tab] : list[0]?.id;
  const pick = (id: string) => setSelected((s) => ({ ...s, [tab]: id }));
  const meta = TABS.find((t) => t.key === tab)!;

  const strip = [
    { label: "Active Bots", value: data.bots.filter((b) => b.status === "active").length, dot: STATUS_DOT.active, tab: "bots" as Tab, openApprovals: false },
    { label: "Online Terminals", value: data.terminals.filter((t) => t.status === "online").length, dot: STATUS_DOT.online, tab: "terminals" as Tab, openApprovals: false },
    { label: "Shared Channels", value: data.channels.length, dot: "bg-blue-500 dark:bg-[#60a5fa]", tab: "channels" as Tab, openApprovals: false },
    { label: "Pending Owner Approvals", value: data.pendingApprovals.length, dot: data.pendingApprovals.length ? STATUS_DOT.paused : STATUS_DOT.offline, tab: null, openApprovals: true },
  ] as const;

  const runAction = async (key: string, errorTitle: string, fn: () => Promise<unknown> | unknown) => {
    setBusyAction(key);
    try {
      return await fn();
    } catch (err) {
      onActionError?.(errorTitle, err);
      return undefined;
    } finally {
      setBusyAction(null);
    }
  };

  const handleCopyToken = async () => {
    if (!issuedToken) return;
    try {
      await navigator.clipboard?.writeText(issuedToken.token);
      setTokenCopied(true);
      window.setTimeout(() => setTokenCopied(false), 2000);
    } catch {
      // Clipboard API may be unavailable in non-secure contexts; token remains selectable.
    }
  };

  return (
    <div className="space-y-3 tabular-nums">
      {/* 1-row 4-cell Combo 1 telemetry strip; cells jump to their tab */}
      <div
        className="cockpit-strip h-10 w-full gap-0 overflow-x-auto rounded-xl border border-slate-200/90 bg-white px-0 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] dark:border-white/[0.08] dark:bg-[#0e131d] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_4px_20px_-8px_rgba(0,0,0,0.65)]"
        role="group"
        aria-label="Enterprise bot telemetry"
      >
        {strip.map((cell) => {
          const isActive = cell.openApprovals ? approvalDrawerOpen : tab === cell.tab && !approvalDrawerOpen;
          return (
            <button
              key={cell.label}
              type="button"
              onClick={() => (cell.openApprovals ? setApprovalDrawerOpen(true) : setTab(cell.tab))}
              className={`cockpit-cell flex-1 min-w-0 cursor-pointer justify-center px-3 transition-colors ${
                isActive
                  ? "bg-slate-100/90 text-slate-950 shadow-[inset_0_-2px_0_#2563eb] dark:bg-[#151d2b] dark:text-[#edf2fb] dark:shadow-[inset_0_-2px_0_#60a5fa]"
                  : "text-slate-600 hover:bg-slate-50 hover:text-slate-900 dark:text-[#8b97ad] dark:hover:bg-[#141b29] dark:hover:text-[#edf2fb]"
              }`}
            >
              <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${cell.dot}`} />
              <span className="truncate text-[11px] font-semibold uppercase tracking-[0.1em]">{cell.label}</span>
              <b className="ml-0.5 font-mono text-xs font-semibold text-slate-950 dark:text-[#edf2fb]">{cell.value}</b>
            </button>
          );
        })}
      </div>

      {/* Unified Combo 1 40px tactile cockpit toolbar */}
      <div className="cockpit-toolbar tactile-card h-10 w-full gap-2 overflow-x-auto rounded-xl border border-slate-200/90 bg-white px-1.5 dark:border-white/[0.08] dark:bg-none dark:bg-[#0e131d]">
        <div
          role="group"
          aria-label="Enterprise bot views"
          className="flex shrink-0 items-center gap-0.5 rounded-lg border border-slate-200/90 bg-slate-100/90 p-0.5 dark:border-white/[0.08] dark:bg-[#07090d]"
        >
          {TABS.map((t) => (
            <button key={t.key} type="button" data-tab={t.key} aria-pressed={tab === t.key} onClick={() => setTab(t.key)} className={TAB_CLASS}>
              <t.icon className="mr-1.5 inline h-3.5 w-3.5 align-[-2px]" aria-hidden />
              {t.label}
            </button>
          ))}
        </div>
        <div className="relative min-w-[160px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400 dark:text-[#8b97ad]" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={`Search ${meta.label.toLowerCase()}...`}
            aria-label="Search enterprise bots"
            className="h-7 w-full rounded-lg border border-slate-200/90 bg-slate-50/70 pl-8 pr-3 text-xs text-slate-900 outline-none placeholder:text-slate-400 focus:border-blue-500 focus:bg-white focus:ring-2 focus:ring-blue-500/20 dark:border-white/[0.09] dark:bg-[#090d14] dark:text-[#edf2fb] dark:placeholder:text-[#8b97ad] dark:focus:border-[#60a5fa] dark:focus:ring-[#60a5fa]/25"
          />
        </div>
        <button
          type="button"
          onClick={() => setAttachOpen(true)}
          className="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg bg-blue-600 px-2.5 text-xs font-semibold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] transition-colors hover:bg-blue-500 dark:bg-[#2563eb] dark:hover:bg-[#3b82f6]"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden />
          Attach OpenBot
        </button>
        <button
          type="button"
          onClick={() => {
            onRegisterTerminal?.();
            setRegisterTerminalOpen(true);
          }}
          className="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-slate-200/90 bg-white px-2.5 text-xs font-medium text-slate-800 transition-colors hover:border-blue-500/40 hover:bg-slate-50 dark:border-white/[0.1] dark:bg-[#090d14] dark:text-[#edf2fb] dark:hover:border-[#60a5fa]/40 dark:hover:bg-[#141b29]"
        >
          <Monitor className="h-3.5 w-3.5" aria-hidden />
          Register Terminal
        </button>
      </div>

      {/* OpenBot-style terminal pairing banner (env-var daemon & doctor commands + live heartbeat) */}
      {pairingBanner && (
        <TerminalPairingBanner
          terminalId={pairingBanner.terminalId}
          terminalName={pairingBanner.terminalName}
          oneTimeToken={pairingBanner.oneTimeToken}
          serverUrl={serverUrl}
          lastSeenAt={pairedTerminal?.lastHeartbeatAt ?? pairingBanner.lastSeenAt}
          onDismiss={() => setPairingBanner(null)}
        />
      )}

      {/* One-time bot inbound bearer token banner (pcp_bot_...) */}
      {issuedToken && (
        <div
          role="status"
          data-issued-token-banner
          className="tactile-card flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-500/40 bg-amber-50/80 px-3.5 py-2.5 text-xs dark:border-[#f59e0b]/40 dark:bg-none dark:bg-[#0e131d]"
        >
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex items-center gap-1.5 font-semibold text-amber-900 dark:text-[#fcd34d]">
              <KeyRound className="h-3.5 w-3.5 shrink-0" aria-hidden />
              <span>{issuedToken.label}</span>
            </div>
            <p className="text-[11px] text-amber-800/90 dark:text-[#cbd5e1]">{issuedToken.hint}</p>
            <code
              data-issued-token
              className="block truncate rounded-md border border-amber-500/30 bg-white/90 px-2.5 py-1 font-mono text-[11px] text-slate-950 select-all dark:border-white/[0.08] dark:bg-[#07090d] dark:text-[#d9f99d]"
            >
              {issuedToken.token}
            </code>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button type="button" onClick={() => void handleCopyToken()} className={ACTION}>
              {tokenCopied ? <Check className="h-3.5 w-3.5 text-lime-600 dark:text-[#a3e635]" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
              {tokenCopied ? "Copied" : "Copy token"}
            </button>
            <button
              type="button"
              aria-label="Dismiss token banner"
              onClick={() => {
                setIssuedToken(null);
                setTokenCopied(false);
              }}
              className={ACTION}
            >
              <X className="h-3.5 w-3.5" aria-hidden />
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Load error state */}
      {loadError && (
        <div className={`${PANEL} flex items-center justify-between gap-3 px-4 py-3 text-xs text-rose-700 dark:text-rose-300`}>
          <span>Failed to load enterprise bots: {loadError}</span>
          {onRetry && (
            <button type="button" onClick={onRetry} className={ACTION}>
              <RefreshCw className="h-3.5 w-3.5" aria-hidden />
              Retry
            </button>
          )}
        </div>
      )}

      {/* Balanced widescreen 58/42 master-detail split with 2-3 col tactile card grid */}
      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,58%)_minmax(0,42%)] xl:items-start">
        <div className={`${PANEL} min-w-0 p-3`}>
          {isLoading ? (
            <div className="flex items-center justify-center py-12 text-xs text-slate-500 dark:text-[#8b97ad]">
              Loading enterprise bots...
            </div>
          ) : list.length === 0 ? (
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
          {tab === "bots" && (
            <BotDetail
              bot={data.bots.find((b) => b.id === currentId)}
              canAdmin={canAdmin}
              pingResult={currentId ? pingResults[currentId] : undefined}
              extraSamples={currentId ? pingSamples[currentId] : undefined}
              busyAction={busyAction}
              onPing={
                onPingBot
                  ? (botId) =>
                      void runAction(`ping:${botId}`, "Ping failed", async () => {
                        const res = await onPingBot(botId);
                        if (res) {
                          setPingResults((prev) => ({ ...prev, [botId]: res }));
                          const sample: HealthSample = {
                            ts: res.checkedAt ?? new Date().toISOString(),
                            ok: res.ok,
                            rttMs: res.latencyMs ?? null,
                            statusCode: typeof res.status === "number" ? res.status : null,
                            errorRef: res.error ?? null,
                          };
                          setPingSamples((prev) => ({
                            ...prev,
                            [botId]: [...(prev[botId] ?? []), sample].slice(-20),
                          }));
                        }
                      })
                  : undefined
              }
              onToggleStatus={
                onUpdateBot
                  ? (bot) =>
                      void runAction(`status:${bot.id}`, "Failed to update bot", () =>
                        onUpdateBot(bot.id, { status: bot.status === "paused" ? "active" : "paused" }),
                      )
                  : undefined
              }
              onSaveCapabilities={
                onUpdateBotCapabilities
                  ? (botId, next) =>
                      void runAction(`caps:${botId}`, "Failed to save capabilities", () =>
                        onUpdateBotCapabilities(botId, next),
                      )
                  : undefined
              }
              onRevoke={
                onDeleteBot
                  ? (botId) => void runAction(`delete:${botId}`, "Failed to revoke bot", () => onDeleteBot(botId))
                  : undefined
              }
            />
          )}
          {tab === "terminals" && (
            <TerminalDetail
              terminal={data.terminals.find((t) => t.id === currentId)}
              viewerId={viewerId}
              viewerRole={viewerRole}
              now={now}
              busyAction={busyAction}
              onCommand={
                onCommandTerminal
                  ? (terminalId, action) =>
                      void runAction(`term:${terminalId}:${action}`, `Terminal ${action} failed`, () =>
                        onCommandTerminal(terminalId, action),
                      )
                  : undefined
              }
            />
          )}
          {tab === "channels" && (
            <ChannelDetail
              channel={data.channels.find((c) => c.id === currentId)}
              bots={data.bots}
              approvals={data.pendingApprovals}
              auditEntries={auditEntries}
              busyAction={busyAction}
              onPreview={
                onPreviewChannelInvoke
                  ? async (request) =>
                      (await runAction(`preview:${request.channelId}`, "Dry-run preview failed", () =>
                        onPreviewChannelInvoke(request),
                      )) as ChannelInvokePreviewResult | undefined
                  : undefined
              }
              onDecision={
                onApprovalDecision
                  ? (approvalId, decision) =>
                      void runAction(`approval:${approvalId}`, "Failed to submit approval decision", () =>
                        onApprovalDecision(approvalId, decision),
                      )
                  : undefined
              }
            />
          )}
        </section>
      </div>

      <ApprovalQueueDrawer
        open={approvalDrawerOpen}
        approvals={data.pendingApprovals}
        canAdmin={canAdmin}
        viewerId={viewerId}
        busyApprovalId={busyAction?.startsWith("approval:") ? busyAction.slice("approval:".length) : null}
        now={now}
        onClose={() => setApprovalDrawerOpen(false)}
        onDecision={
          onApprovalDecision
            ? (approvalId, decision) =>
                void runAction(`approval:${approvalId}`, "Failed to submit approval decision", () =>
                  onApprovalDecision(approvalId, decision),
                )
            : undefined
        }
      />

      {attachOpen && (
        <AttachOpenBotModal
          secrets={secrets}
          busy={busyAction === "create-bot"}
          onClose={() => setAttachOpen(false)}
          onSubmit={async (payload) => {
            const res = await runAction("create-bot", "Failed to attach OpenBot", () => onCreateBot?.(payload));
            const created = res as CreateBotResponse | undefined;
            if (created?.inboundToken) {
              setIssuedToken({
                label: `One-time inbound token for ${created.bot?.name ?? payload.name}`,
                token: created.inboundToken,
                hint: "Store this pcp_bot_ token securely now. It will not be shown again.",
              });
              setTokenCopied(false);
            }
            setAttachOpen(false);
          }}
        />
      )}

      {registerTerminalOpen && (
        <RegisterTerminalModal
          busy={busyAction === "register-terminal"}
          onClose={() => setRegisterTerminalOpen(false)}
          onSubmit={async (payload) => {
            const res = await runAction("register-terminal", "Failed to register terminal", () =>
              onRegisterTerminalSubmit?.(payload),
            );
            const created = res as RegisterTerminalResponse | undefined;
            if (created?.token) {
              setPairingBanner({
                terminalId: created.terminal?.id ?? "",
                terminalName: created.terminal?.name ?? payload.name,
                oneTimeToken: created.token,
                lastSeenAt: created.terminal?.lastSeenAt ?? null,
              });
            }
            setRegisterTerminalOpen(false);
          }}
        />
      )}
    </div>
  );
}

function BotDetail({
  bot,
  canAdmin,
  pingResult,
  extraSamples,
  busyAction,
  onPing,
  onToggleStatus,
  onSaveCapabilities,
  onRevoke,
}: {
  bot?: EnterpriseBot;
  canAdmin: boolean;
  pingResult?: PingBotResponse;
  extraSamples?: HealthSample[];
  busyAction: string | null;
  onPing?: (botId: string) => void;
  onToggleStatus?: (bot: EnterpriseBot) => void;
  onSaveCapabilities?: (botId: string, capabilities: BotCapabilityMatrixEntry[]) => void;
  onRevoke?: (botId: string) => void;
}) {
  const capabilityRules = useMemo(() => (bot ? toCapabilityRules(bot) : []), [bot]);
  if (!bot) return <p className="text-xs text-slate-500 dark:text-[#8b97ad]">Select a bot to inspect its capabilities.</p>;
  const isPaused = bot.status === "paused";
  const isRevoked = bot.status === "revoked";
  const combinedSamples = [...(bot.healthHistory ?? []), ...(extraSamples ?? [])].slice(-20);
  const rows: [string, ReactNode][] = [
    ["Kind", <KindTag>{bot.kind}</KindTag>],
    ["Owner", bot.ownerName],
    ["Security", <SecurityBadge callableBy={bot.callableBy} dataScope={bot.dataScope} />],
  ];
  if (bot.webhookUrl) {
    rows.push(["Webhook", <span className="font-mono text-[11px]">{bot.webhookUrl}</span>]);
  }
  return (
    <div className="space-y-3.5">
      <div className="flex items-start gap-2.5 border-b border-slate-200/80 pb-3 dark:border-white/[0.06]">
        <Bot className="mt-0.5 h-4 w-4 shrink-0 text-blue-600 dark:text-[#60a5fa]" />
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-950 dark:text-[#edf2fb]">{bot.name}</h2>
        <Pill dot={STATUS_DOT[bot.status]} tone={statusTone(bot.status)}>{bot.status}</Pill>
      </div>
      <Fields rows={rows} />
      <p className="rounded-lg border border-slate-200/80 bg-slate-50/80 px-3 py-2 text-[11px] leading-4 text-slate-600 dark:border-white/[0.06] dark:bg-[#090d14] dark:text-[#8b97ad]">
        Callable by <span className="font-medium text-blue-700 dark:text-[#60a5fa]">{bot.callableBy}</span>; reads and writes{" "}
        <span className="font-medium text-blue-700 dark:text-[#60a5fa]">{bot.dataScope}</span> data only.
      </p>
      <div className="flex flex-wrap items-center gap-2" aria-label="Bot actions">
        <button
          type="button"
          disabled={!onPing || isRevoked || busyAction !== null}
          onClick={() => onPing?.(bot.id)}
          className={ACTION}
        >
          <Activity className="h-3.5 w-3.5" aria-hidden />
          Test Ping
        </button>
        <BotHealthSparkline samples={combinedSamples} slots={20} width={112} height={24} />
        <button
          type="button"
          disabled={!onToggleStatus || isRevoked || busyAction !== null}
          onClick={() => onToggleStatus?.(bot)}
          className={ACTION}
        >
          {isPaused ? <Play className="h-3.5 w-3.5" aria-hidden /> : <Pause className="h-3.5 w-3.5" aria-hidden />}
          {isPaused ? "Resume" : "Pause"}
        </button>
        <button
          type="button"
          disabled={!onRevoke || isRevoked || busyAction !== null}
          onClick={() => onRevoke?.(bot.id)}
          className={DANGER_ACTION}
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden />
          Revoke
        </button>
      </div>
      {pingResult && (
        <div
          data-ping-result
          className={`rounded-lg border px-3 py-2 font-mono text-[11px] ${
            pingResult.ok
              ? "border-lime-500/30 bg-lime-500/10 text-lime-800 dark:border-[#a3e635]/30 dark:text-[#d9f99d]"
              : "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300"
          }`}
        >
          {pingResult.ok
            ? `Ping OK${pingResult.status != null ? ` (${pingResult.status})` : ""}${pingResult.latencyMs != null ? ` · ${pingResult.latencyMs}ms` : ""}`
            : `Ping failed: ${pingResult.error ?? pingResult.status ?? "unreachable"}`}
        </div>
      )}
      <CapabilityMatrix
        capabilities={capabilityRules}
        canAdmin={canAdmin && !isRevoked}
        saving={busyAction === `caps:${bot.id}`}
        onSave={(next) => onSaveCapabilities?.(bot.id, next)}
      />
    </div>
  );
}

function TerminalDetail({
  terminal,
  viewerId,
  viewerRole,
  now,
  busyAction,
  onCommand,
}: {
  terminal?: ClientTerminal;
  viewerId: string;
  viewerRole: ViewerRole;
  now: number;
  busyAction: string | null;
  onCommand?: (terminalId: string, action: BotTerminalAction) => void;
}) {
  if (!terminal) return <p className="text-xs text-slate-500 dark:text-[#8b97ad]">Select a terminal to inspect heartbeat and actions.</p>;
  const exec = execPolicy(terminal, viewerId);
  const isOwner = Boolean(viewerId) && terminal.ownerId === viewerId;
  const isRevoked = terminal.status === "revoked";
  return (
    <div className="space-y-3.5">
      <div className="flex items-start gap-2.5 border-b border-slate-200/80 pb-3 dark:border-white/[0.06]">
        <Monitor className="mt-0.5 h-4 w-4 shrink-0 text-blue-600 dark:text-[#60a5fa]" />
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-950 dark:text-[#edf2fb]">{terminal.name}</h2>
        <Pill dot={STATUS_DOT[terminal.status]} tone={statusTone(terminal.status)}>{terminal.status}</Pill>
      </div>
      <Fields
        rows={[
          ["Kind", <KindTag>{terminal.kind}</KindTag>],
          ["Owner", terminal.ownerName],
          ["Last heartbeat", <span className="font-mono" title={terminal.lastHeartbeatAt ?? undefined}>{since(terminal.lastHeartbeatAt, now)}</span>],
          ["You", `${viewerRole}${isOwner ? " · owner" : ""}`],
        ]}
      />
      <TerminalTelemetryCard
        telemetry={{
          transport: terminal.transport ?? "outbound_wss",
          os: terminal.telemetry?.os ?? null,
          arch: terminal.telemetry?.arch ?? null,
          daemonVersion: terminal.telemetry?.daemonVersion ?? null,
          rttMs: terminal.telemetry?.lastRttMs ?? null,
          cpuPercent: terminal.telemetry?.cpuPct ?? null,
          memoryMb: terminal.telemetry?.memRssMb ?? null,
          lastHeartbeatAt: terminal.lastHeartbeatAt,
          samples: terminal.healthHistory ?? [],
        }}
        now={now}
      />
      <div className="flex flex-wrap gap-2" aria-label="Terminal actions">
        <button
          type="button"
          disabled={!exec.enabled || isRevoked || busyAction !== null}
          onClick={() => onCommand?.(terminal.id, "exec")}
          title={exec.reason ?? "Run a command on this terminal"}
          aria-description={exec.reason ?? undefined}
          data-exec-blocked={!exec.enabled || undefined}
          className={ACTION}
        >
          <Play className="h-3.5 w-3.5" aria-hidden />
          Exec
          {!exec.enabled && <Lock className="h-3 w-3" aria-hidden />}
        </button>
        <button
          type="button"
          disabled={isRevoked || busyAction !== null}
          onClick={() => onCommand?.(terminal.id, "stop")}
          title="Stop the running session on this terminal"
          className={ACTION}
        >
          <Square className="h-3.5 w-3.5" aria-hidden />
          Stop
        </button>
        <button
          type="button"
          disabled={isRevoked || busyAction !== null}
          onClick={() => onCommand?.(terminal.id, "revoke")}
          title="Revoke this terminal's access"
          className={DANGER_ACTION}
        >
          <Ban className="h-3.5 w-3.5" aria-hidden />
          Revoke
        </button>
      </div>
      {!exec.enabled && (
        <p role="note" className="flex gap-2 rounded-lg border border-amber-500/35 bg-amber-500/10 p-2.5 text-[11px] leading-4 text-amber-800 dark:border-[#f59e0b]/30 dark:bg-[#f59e0b]/10 dark:text-[#fcd34d]">
          <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          {exec.reason}
        </p>
      )}
    </div>
  );
}

function ChannelDetail({
  channel,
  bots,
  approvals,
  auditEntries,
  busyAction,
  onPreview,
  onDecision,
}: {
  channel?: Channel;
  bots: EnterpriseBot[];
  approvals: PendingOwnerApproval[];
  auditEntries: ChannelAuditEntry[];
  busyAction: string | null;
  onPreview?: (
    request: ChannelInvokePreviewRequest,
  ) => Promise<ChannelInvokePreviewResult | void> | ChannelInvokePreviewResult | void;
  onDecision?: (approvalId: string, decision: "approve" | "deny") => void;
}) {
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
      {channel && (
        <ChannelInvokePreview
          channelId={channel.id}
          channelName={channel.name}
          bots={bots.map((b) => ({
            id: b.id,
            name: b.name,
            kind: b.kind,
            capabilities: b.capabilities,
          }))}
          auditEntries={auditEntries}
          busy={busyAction === `preview:${channel.id}`}
          onPreview={onPreview}
        />
      )}
      <div className="space-y-2">
        <SectionTitle>Pending owner approvals · {queue.length}</SectionTitle>
        {queue.length === 0 ? (
          <p className="text-xs text-slate-500 dark:text-[#8b97ad]">No cross-user personal bot → personal terminal invocations waiting.</p>
        ) : (
          queue.map((p) => (
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
                <Clock className="h-3 w-3" aria-hidden />
                {p.requestedAt}
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={busyAction !== null}
                  onClick={() => onDecision?.(p.id, "approve")}
                  className="inline-flex h-7.5 cursor-pointer items-center gap-1 rounded-lg bg-blue-600 px-3 text-xs font-semibold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] transition-colors hover:bg-blue-500 disabled:opacity-50 dark:bg-[#2563eb] dark:hover:bg-[#3b82f6]"
                >
                  Approve
                </button>
                <button type="button" disabled={busyAction !== null} onClick={() => onDecision?.(p.id, "deny")} className={ACTION}>
                  Deny
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function AttachOpenBotModal({
  secrets,
  busy,
  onClose,
  onSubmit,
}: {
  secrets: CompanySecret[];
  busy: boolean;
  onClose: () => void;
  onSubmit: (payload: AttachBotSubmitPayload) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<BotKind>("team");
  const [callableBy, setCallableBy] = useState<EnterpriseBotCallableBy>("team");
  const [dataScope, setDataScope] = useState<DataScope>("team");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [secretMode, setSecretMode] = useState<"none" | "existing" | "new">("none");
  const [apiSecretId, setApiSecretId] = useState("");
  const [newSecretName, setNewSecretName] = useState("");
  const [newSecretValue, setNewSecretValue] = useState("");
  const [capabilitiesText, setCapabilitiesText] = useState("");

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    const capabilities = capabilitiesText
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    await onSubmit({
      name: name.trim(),
      kind,
      callableBy,
      dataScope,
      webhookUrl: webhookUrl.trim() || null,
      apiSecretId: secretMode === "existing" && apiSecretId ? apiSecretId : null,
      newSecretName: secretMode === "new" ? newSecretName.trim() : undefined,
      newSecretValue: secretMode === "new" ? newSecretValue : undefined,
      capabilities,
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-xs">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Attach OpenBot"
        className={`${PANEL} w-full max-w-lg space-y-4 p-5`}
      >
        <div className="flex items-center justify-between border-b border-slate-200/80 pb-3 dark:border-white/[0.06]">
          <div className="flex items-center gap-2">
            <Bot className="h-4 w-4 text-blue-600 dark:text-[#60a5fa]" aria-hidden />
            <h2 className="text-sm font-semibold text-slate-950 dark:text-[#edf2fb]">Attach OpenBot</h2>
          </div>
          <button type="button" aria-label="Close Attach OpenBot dialog" onClick={onClose} className={ACTION}>
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-3 text-xs">
          <label className="block space-y-1">
            <span className="font-medium text-slate-700 dark:text-[#cbd5e1]">Bot Name</span>
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Research Copilot"
              aria-label="Bot Name"
              className={INPUT_CLASS}
            />
          </label>

          <div className="grid grid-cols-3 gap-2.5">
            <label className="block space-y-1">
              <span className="font-medium text-slate-700 dark:text-[#cbd5e1]">Kind</span>
              <select aria-label="Bot Kind" value={kind} onChange={(e) => setKind(e.target.value as BotKind)} className={INPUT_CLASS}>
                <option value="personal">personal</option>
                <option value="team">team</option>
                <option value="company">company</option>
              </select>
            </label>
            <label className="block space-y-1">
              <span className="font-medium text-slate-700 dark:text-[#cbd5e1]">Callable By</span>
              <select
                aria-label="Callable By"
                value={callableBy}
                onChange={(e) => setCallableBy(e.target.value as EnterpriseBotCallableBy)}
                className={INPUT_CLASS}
              >
                <option value="self_only">self_only</option>
                <option value="team">team</option>
                <option value="company">company</option>
              </select>
            </label>
            <label className="block space-y-1">
              <span className="font-medium text-slate-700 dark:text-[#cbd5e1]">Data Scope</span>
              <select
                aria-label="Data Scope"
                value={dataScope}
                onChange={(e) => setDataScope(e.target.value as DataScope)}
                className={INPUT_CLASS}
              >
                <option value="self">self</option>
                <option value="team">team</option>
                <option value="company">company</option>
              </select>
            </label>
          </div>

          <label className="block space-y-1">
            <span className="font-medium text-slate-700 dark:text-[#cbd5e1]">Webhook URL (optional)</span>
            <input
              type="url"
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
              placeholder="https://bot.example.com/webhook"
              aria-label="Webhook URL"
              className={INPUT_CLASS}
            />
          </label>

          <div className="space-y-2 rounded-lg border border-slate-200/80 bg-slate-50/70 p-2.5 dark:border-white/[0.06] dark:bg-[#090d14]">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-slate-700 dark:text-[#cbd5e1]">API Secret (optional)</span>
              <select
                aria-label="API Secret Mode"
                value={secretMode}
                onChange={(e) => setSecretMode(e.target.value as "none" | "existing" | "new")}
                className="h-7 rounded-md border border-slate-200/90 bg-white px-2 text-[11px] text-slate-800 dark:border-white/[0.09] dark:bg-[#0e131d] dark:text-[#edf2fb]"
              >
                <option value="none">None</option>
                <option value="existing">Use existing secret</option>
                <option value="new">Create new secret</option>
              </select>
            </div>
            {secretMode === "existing" && (
              <select
                aria-label="Existing Secret"
                value={apiSecretId}
                onChange={(e) => setApiSecretId(e.target.value)}
                className={INPUT_CLASS}
              >
                <option value="">Select a company secret...</option>
                {secrets.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            )}
            {secretMode === "new" && (
              <div className="grid grid-cols-2 gap-2">
                <input
                  value={newSecretName}
                  onChange={(e) => setNewSecretName(e.target.value)}
                  placeholder="Secret name (e.g. OPENBOT_KEY)"
                  aria-label="New Secret Name"
                  className={INPUT_CLASS}
                />
                <input
                  type="password"
                  value={newSecretValue}
                  onChange={(e) => setNewSecretValue(e.target.value)}
                  placeholder="Secret value"
                  aria-label="New Secret Value"
                  className={INPUT_CLASS}
                />
              </div>
            )}
          </div>

          <label className="block space-y-1">
            <span className="font-medium text-slate-700 dark:text-[#cbd5e1]">Capabilities (comma-separated)</span>
            <input
              value={capabilitiesText}
              onChange={(e) => setCapabilitiesText(e.target.value)}
              placeholder="web.search, doc.summarize"
              aria-label="Capabilities"
              className={INPUT_CLASS}
            />
          </label>

          <div className="flex justify-end gap-2 border-t border-slate-200/80 pt-3 dark:border-white/[0.06]">
            <button type="button" onClick={onClose} className={ACTION}>
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy || !name.trim()}
              className="inline-flex h-7.5 cursor-pointer items-center gap-1.5 rounded-lg bg-blue-600 px-3 text-xs font-semibold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] transition-colors hover:bg-blue-500 disabled:opacity-50 dark:bg-[#2563eb] dark:hover:bg-[#3b82f6]"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden />
              {busy ? "Attaching..." : "Attach Bot"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function RegisterTerminalModal({
  busy,
  onClose,
  onSubmit,
}: {
  busy: boolean;
  onClose: () => void;
  onSubmit: (payload: RegisterTerminalSubmitPayload) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<TerminalKind>("personal_terminal");
  const [transport, setTransport] = useState<BotTerminalTransport>("outbound_wss");

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    await onSubmit({ name: name.trim(), kind, transport });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-xs">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Register Terminal"
        className={`${PANEL} w-full max-w-md space-y-4 p-5`}
      >
        <div className="flex items-center justify-between border-b border-slate-200/80 pb-3 dark:border-white/[0.06]">
          <div className="flex items-center gap-2">
            <Monitor className="h-4 w-4 text-blue-600 dark:text-[#60a5fa]" aria-hidden />
            <h2 className="text-sm font-semibold text-slate-950 dark:text-[#edf2fb]">Register Terminal</h2>
          </div>
          <button type="button" aria-label="Close Register Terminal dialog" onClick={onClose} className={ACTION}>
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-3 text-xs">
          <label className="block space-y-1">
            <span className="font-medium text-slate-700 dark:text-[#cbd5e1]">Terminal Name</span>
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. maya-macbook"
              aria-label="Terminal Name"
              className={INPUT_CLASS}
            />
          </label>

          <div className="grid grid-cols-2 gap-2.5">
            <label className="block space-y-1">
              <span className="font-medium text-slate-700 dark:text-[#cbd5e1]">Kind</span>
              <select
                aria-label="Terminal Kind"
                value={kind}
                onChange={(e) => setKind(e.target.value as TerminalKind)}
                className={INPUT_CLASS}
              >
                <option value="personal_terminal">personal_terminal</option>
                <option value="worker_node">worker_node</option>
              </select>
            </label>
            <label className="block space-y-1">
              <span className="font-medium text-slate-700 dark:text-[#cbd5e1]">Transport</span>
              <select
                aria-label="Terminal Transport"
                value={transport}
                onChange={(e) => setTransport(e.target.value as BotTerminalTransport)}
                className={INPUT_CLASS}
              >
                <option value="outbound_wss">outbound_wss</option>
                <option value="tailscale_direct">tailscale_direct</option>
              </select>
            </label>
          </div>

          <div className="flex justify-end gap-2 border-t border-slate-200/80 pt-3 dark:border-white/[0.06]">
            <button type="button" onClick={onClose} className={ACTION}>
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy || !name.trim()}
              className="inline-flex h-7.5 cursor-pointer items-center gap-1.5 rounded-lg bg-blue-600 px-3 text-xs font-semibold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] transition-colors hover:bg-blue-500 disabled:opacity-50 dark:bg-[#2563eb] dark:hover:bg-[#3b82f6]"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden />
              {busy ? "Registering..." : "Create Terminal"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
