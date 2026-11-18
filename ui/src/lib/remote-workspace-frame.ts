export interface FrameAgentSummary {
  id: string;
  name: string;
  role?: string | null;
  title?: string | null;
  status?: string | null;
  preview: "";
}

export interface FrameCompanySummary {
  id: string;
  name: string;
  issuePrefix?: string | null;
  brandColor?: string | null;
}

export interface RemoteWorkspaceFrame {
  savedAt: number;
  selectedCompanyId: string | null;
  selectedAgentId: string | null;
  recentAgentIds: string[];
  companies: FrameCompanySummary[];
  agents: FrameAgentSummary[];
  unreadCounts: Record<string, number>;
}

export type FrameStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

const FRAME_KEY_PREFIX = "paperclip:remote-frame:v1:";
const RECENT_AGENTS_CAP = 4;
export const FRAME_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function defaultStorage(): FrameStorage | null {
  return typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
}

function frameKey(accountId: string, serverId: string): string {
  return `${FRAME_KEY_PREFIX}${encodeURIComponent(accountId)}:${encodeURIComponent(serverId)}`;
}

function asOptionalString(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return value;
  return typeof value === "string" ? value : undefined;
}

export function scrubAgentFrameSummary(input: Record<string, unknown>): FrameAgentSummary | null {
  if (typeof input.id !== "string" || typeof input.name !== "string") return null;
  return {
    id: input.id,
    name: input.name,
    role: asOptionalString(input.role),
    title: asOptionalString(input.title),
    status: asOptionalString(input.status),
    preview: "",
  };
}

export function scrubCompanyFrameSummary(input: Record<string, unknown>): FrameCompanySummary | null {
  if (typeof input.id !== "string" || typeof input.name !== "string") return null;
  return {
    id: input.id,
    name: input.name,
    issuePrefix: asOptionalString(input.issuePrefix),
    brandColor: asOptionalString(input.brandColor),
  };
}

function normalizeUnreadCounts(counts: unknown): Record<string, number> {
  if (!counts || typeof counts !== "object" || Array.isArray(counts)) return {};
  return Object.fromEntries(
    Object.entries(counts).filter(([, count]) => typeof count === "number" && Number.isFinite(count) && count > 0),
  ) as Record<string, number>;
}

function decodeFrame(raw: unknown, nowMs: number): RemoteWorkspaceFrame | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.savedAt !== "number" || nowMs - rec.savedAt > FRAME_MAX_AGE_MS) return null;
  if (!Array.isArray(rec.agents)) return null;
  const agents = rec.agents
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map(scrubAgentFrameSummary)
    .filter((item): item is FrameAgentSummary => item !== null);
  const companies = Array.isArray(rec.companies)
    ? rec.companies
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
        .map(scrubCompanyFrameSummary)
        .filter((item): item is FrameCompanySummary => item !== null)
    : [];
  return {
    savedAt: rec.savedAt,
    selectedCompanyId: typeof rec.selectedCompanyId === "string" ? rec.selectedCompanyId : null,
    selectedAgentId: typeof rec.selectedAgentId === "string" ? rec.selectedAgentId : null,
    recentAgentIds: Array.isArray(rec.recentAgentIds)
      ? rec.recentAgentIds.filter((id): id is string => typeof id === "string").slice(0, RECENT_AGENTS_CAP)
      : [],
    companies,
    agents,
    unreadCounts: normalizeUnreadCounts(rec.unreadCounts),
  };
}

export function readRemoteWorkspaceFrame(
  accountId: string,
  serverId: string,
  storage: FrameStorage | null = defaultStorage(),
  nowMs: number = Date.now(),
): RemoteWorkspaceFrame | null {
  if (!storage) return null;
  try {
    const encoded = storage.getItem(frameKey(accountId, serverId));
    return encoded ? decodeFrame(JSON.parse(encoded), nowMs) : null;
  } catch {
    return null;
  }
}

export function saveRemoteWorkspaceFrame(
  accountId: string,
  serverId: string,
  update: Partial<Omit<RemoteWorkspaceFrame, "savedAt" | "recentAgentIds" | "agents" | "companies">> & {
    agents?: Array<Record<string, unknown>>;
    companies?: Array<Record<string, unknown>>;
  },
  storage: FrameStorage | null = defaultStorage(),
  nowMs: number = Date.now(),
): RemoteWorkspaceFrame | null {
  if (!storage) return null;
  const current = readRemoteWorkspaceFrame(accountId, serverId, storage, nowMs);
  const nextSelectedAgentId =
    update.selectedAgentId !== undefined ? update.selectedAgentId : (current?.selectedAgentId ?? null);
  const prevRecent = current?.recentAgentIds ?? [];
  const recentAgentIds = nextSelectedAgentId
    ? [nextSelectedAgentId, ...prevRecent.filter((id) => id !== nextSelectedAgentId)].slice(0, RECENT_AGENTS_CAP)
    : prevRecent;
  const agents = (update.agents ?? current?.agents ?? [])
    .map((item) => scrubAgentFrameSummary(item as unknown as Record<string, unknown>))
    .filter((item): item is FrameAgentSummary => item !== null);
  const companies = (update.companies ?? current?.companies ?? [])
    .map((item) => scrubCompanyFrameSummary(item as unknown as Record<string, unknown>))
    .filter((item): item is FrameCompanySummary => item !== null);
  const frame: RemoteWorkspaceFrame = {
    savedAt: nowMs,
    selectedCompanyId:
      update.selectedCompanyId !== undefined ? update.selectedCompanyId : (current?.selectedCompanyId ?? null),
    selectedAgentId: nextSelectedAgentId,
    recentAgentIds,
    companies,
    agents,
    unreadCounts: normalizeUnreadCounts(update.unreadCounts ?? current?.unreadCounts ?? {}),
  };
  try {
    storage.setItem(frameKey(accountId, serverId), JSON.stringify(frame));
  } catch {
    return frame;
  }
  return frame;
}

export function deleteRemoteWorkspaceFrames(
  accountId: string | null,
  keepServerIds: readonly string[] = [],
  storage: FrameStorage | null = defaultStorage(),
): void {
  if (!storage) return;
  const accountPrefix = accountId === null ? FRAME_KEY_PREFIX : `${FRAME_KEY_PREFIX}${encodeURIComponent(accountId)}:`;
  const keepKeys = new Set(accountId === null ? [] : keepServerIds.map((id) => frameKey(accountId, id)));
  const keysToDelete: string[] = [];
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (key && key.startsWith(accountPrefix) && !keepKeys.has(key)) keysToDelete.push(key);
  }
  for (const key of keysToDelete) storage.removeItem(key);
}
