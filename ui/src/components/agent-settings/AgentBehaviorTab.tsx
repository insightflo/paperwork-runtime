import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

/* botPolicy domain contract (stored inside adapterConfig.botPolicy, no DB migration) + shared
   policy primitives. Here so both policy tab files stay under the wave's per-file caps. */

export interface AgentFolderGrant { path: string; mode: "ro" | "rw"; }
export interface AgentMcpAccess { mode: "allow_all" | "allowlist" | "denylist"; servers: string[]; }

export interface AgentBotPolicy {
  accessLevel?: "full" | "ask" | "read_only";
  allowedFolders?: AgentFolderGrant[];
  allowComputerUse?: boolean;
  allowLocalScripts?: boolean;
  canStartNewThreads?: boolean;
  mcpAccess?: AgentMcpAccess;
  busyMessagePolicy?: "queue" | "steer" | "side_task";
  notificationLevel?: "all" | "mentions_and_approvals" | "muted";
  fastMode?: boolean;
  showPlanCard?: boolean;
  memoryLimit?: number | null;
  maxConcurrentTasks?: number | null;
}

const ACCESS_LEVELS = ["full", "ask", "read_only"] as const;
const BUSY_POLICIES = ["queue", "steer", "side_task"] as const;
const NOTIFY_LEVELS = ["all", "mentions_and_approvals", "muted"] as const;
const MCP_MODES = ["allow_all", "allowlist", "denylist"] as const;
const FOLDER_MODES = ["ro", "rw"] as const;
const BOOL_KEYS = ["allowComputerUse", "allowLocalScripts", "canStartNewThreads", "fastMode", "showPlanCard"] as const;
const ENUM_KEYS: [keyof AgentBotPolicy, readonly string[]][] = [
  ["accessLevel", ACCESS_LEVELS], ["busyMessagePolicy", BUSY_POLICIES], ["notificationLevel", NOTIFY_LEVELS],
];

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const pickEnum = <T extends readonly string[]>(value: unknown, allowed: T): T[number] | undefined =>
  typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T[number]) : undefined;
const pickBool = (value: unknown): boolean | undefined => (typeof value === "boolean" ? value : undefined);
const pickCap = (value: unknown): number | null | undefined =>
  value === null ? null : typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** Sets one optional policy field; `undefined` removes the key to keep stored JSON clean. */
export function updatePolicyField(policy: AgentBotPolicy, key: keyof AgentBotPolicy, value: unknown): AgentBotPolicy {
  const next: AgentBotPolicy = { ...policy };
  if (value === undefined) delete next[key];
  else (next as Record<string, unknown>)[key] = value;
  return next;
}

/** " a, b ,,c " → ["a", "b", "c"] — trims parts, drops empties and duplicates. */
export function parseServerNames(raw: string): string[] {
  return [...new Set(raw.split(",").map((part) => part.trim()).filter(Boolean))];
}

/** Coerce unknown stored JSON into a clean AgentBotPolicy (drops garbage keys/values). */
export function normalizeBotPolicy(raw: unknown): AgentBotPolicy {
  const src = asRecord(raw);
  const policy: AgentBotPolicy = {};
  for (const key of BOOL_KEYS) {
    const value = pickBool(src[key]);
    if (value !== undefined) policy[key] = value;
  }
  for (const [key, allowed] of ENUM_KEYS) {
    const value = pickEnum(src[key], allowed);
    if (value !== undefined) (policy as Record<string, unknown>)[key] = value;
  }
  if (Array.isArray(src.allowedFolders)) {
    const grants = src.allowedFolders
      .map((item) => {
        const rec = asRecord(item);
        const path = typeof rec.path === "string" ? rec.path.trim() : "";
        const mode = pickEnum(rec.mode, FOLDER_MODES);
        return path !== "" && mode !== undefined ? { path, mode } : null;
      })
      .filter((grant): grant is AgentFolderGrant => grant !== null);
    if (grants.length > 0) policy.allowedFolders = grants;
  }
  const mcp = asRecord(src.mcpAccess);
  const mcpMode = pickEnum(mcp.mode, MCP_MODES);
  if (mcpMode) {
    policy.mcpAccess = {
      mode: mcpMode,
      servers: Array.isArray(mcp.servers) ? mcp.servers.filter((s): s is string => typeof s === "string") : [],
    };
  }
  for (const key of ["memoryLimit", "maxConcurrentTasks"] as const) {
    const value = pickCap(src[key]);
    if (value !== undefined) policy[key] = value;
  }
  return policy;
}

/* ---- Shared policy UI primitives ---- */

export function PolicySelect({ label, value, options, onChange }: {
  label: string; value: string; options: { value: string; label: string }[]; onChange: (v: string) => void;
}) {
  return (
    <select aria-label={label} className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm text-foreground outline-none focus:border-blue-500/60"
      value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  );
}

export function PolicySwitch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <button type="button" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}
        className={cn("relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors", checked ? "bg-green-600" : "bg-muted")}>
        <span className={cn("inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform", checked ? "translate-x-4.5" : "translate-x-0.5")} />
      </button>
    </div>
  );
}

export function PolicySectionHeading({ children }: { children: ReactNode }) {
  return <h4 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{children}</h4>;
}

/* ---- Tab 3: 협업 · 실행 ---- */

const CAP_KEYS = [
  { key: "memoryLimit", label: "최대 메모리 항목" }, { key: "maxConcurrentTasks", label: "최대 동시 태스크" },
] as const;

/** Collaboration & execution policy controls. `children` lets AgentConfigForm embed
    the existing Heartbeat / Run Policy section without duplicating logic. */
export function AgentBehaviorTab({ policy, onChange, children }: {
  policy: AgentBotPolicy;
  onChange: (next: AgentBotPolicy) => void;
  children?: ReactNode;
}) {
  return (
    <div className="space-y-5">
      <section className="space-y-2">
        <PolicySectionHeading>작업 중 새 메시지 처리</PolicySectionHeading>
        <PolicySelect label="작업 중 새 메시지 처리" value={policy.busyMessagePolicy ?? ""}
          onChange={(v) => onChange(updatePolicyField(policy, "busyMessagePolicy", v || undefined))}
          options={[
            { value: "", label: "기본값" }, { value: "queue", label: "대기열에 쌓기 (queue)" },
            { value: "steer", label: "현재 턴 중간 주입 (steer)" }, { value: "side_task", label: "별도 스레드 분리 (side_task)" },
          ]} />
      </section>
      <section className="space-y-2">
        <PolicySectionHeading>알림 강도</PolicySectionHeading>
        <PolicySelect label="알림 강도" value={policy.notificationLevel ?? ""}
          onChange={(v) => onChange(updatePolicyField(policy, "notificationLevel", v || undefined))}
          options={[
            { value: "", label: "기본값" }, { value: "all", label: "전체 알림 (all)" },
            { value: "mentions_and_approvals", label: "멘션·승인만 (mentions_and_approvals)" }, { value: "muted", label: "음소거 (muted)" },
          ]} />
      </section>
      <section className="space-y-2">
        <PolicySectionHeading>동작 토글</PolicySectionHeading>
        <PolicySwitch label="Fast Mode (빠른 응답 우선)" checked={policy.fastMode === true}
          onChange={(v) => onChange(updatePolicyField(policy, "fastMode", v))} />
        <PolicySwitch label="착수 확인 플랜 카드 표시" checked={policy.showPlanCard === true}
          onChange={(v) => onChange(updatePolicyField(policy, "showPlanCard", v))} />
      </section>
      <section className="space-y-2">
        <PolicySectionHeading>리소스 상한</PolicySectionHeading>
        {CAP_KEYS.map(({ key, label }) => (
          <div key={key} className="flex items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground">{label}</span>
            <input type="number" aria-label={label} value={policy[key] ?? ""}
              onChange={(e) => onChange(updatePolicyField(policy, key, e.target.value.trim() === "" ? null : Number(e.target.value)))}
              className="w-24 rounded-md border border-border bg-transparent px-2 py-1 text-right text-xs font-mono outline-none focus:border-blue-500/60" />
          </div>
        ))}
        <p className="text-[11px] text-muted-foreground">비우면 상한 없음 (unset)으로 저장됩니다.</p>
      </section>
      {children && <section className="space-y-2 border-t border-border pt-4">{children}</section>}
    </div>
  );
}
