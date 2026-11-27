import { useState } from "react";
import { cn } from "../../lib/utils";
import {
  PolicySelect,
  PolicySectionHeading,
  PolicySwitch,
  parseServerNames,
  updatePolicyField,
  type AgentBotPolicy,
  type AgentFolderGrant,
  type AgentMcpAccess,
} from "./AgentBehaviorTab";

/* ---- Tab 2: 권한 · 폴더 (OpenBot botPolicy) ---- */

export function addFolderGrant(
  grants: AgentFolderGrant[],
  rawPath: string,
  mode: AgentFolderGrant["mode"] = "ro",
): { ok: true; grants: AgentFolderGrant[] } | { ok: false; reason: "empty" | "duplicate" } {
  const path = rawPath.trim();
  if (!path) return { ok: false, reason: "empty" };
  if (grants.some((grant) => grant.path === path)) return { ok: false, reason: "duplicate" };
  return { ok: true, grants: [...grants, { path, mode }] };
}

const inputCls =
  "min-w-0 flex-1 rounded-md border border-border bg-transparent px-2.5 py-1.5 font-mono text-xs outline-none placeholder:text-muted-foreground/40 focus:border-blue-500/60";
const btnCls =
  "shrink-0 rounded-md border border-border bg-transparent px-2.5 py-1.5 text-xs text-foreground transition-colors hover:bg-accent";
const folderModeLabels: Record<AgentFolderGrant["mode"], string> = { ro: "읽기 전용", rw: "읽기·쓰기" };

export function AgentPermissionsFoldersTab({
  policy,
  onChange,
}: {
  policy: AgentBotPolicy;
  onChange: (next: AgentBotPolicy) => void;
}) {
  const [newPath, setNewPath] = useState("");
  const [newMode, setNewMode] = useState<AgentFolderGrant["mode"]>("ro");
  const [serversDraft, setServersDraft] = useState<string | null>(null);
  const folders = policy.allowedFolders ?? [];
  const mcp = policy.mcpAccess ?? { mode: "allow_all" as const, servers: [] };

  const handleAdd = () => {
    const result = addFolderGrant(folders, newPath, newMode);
    if (!result.ok) return;
    onChange(updatePolicyField(policy, "allowedFolders", result.grants));
    setNewPath("");
  };

  return (
    <div className="space-y-5">
      <section className="space-y-2">
        <PolicySectionHeading>접근 권한</PolicySectionHeading>
        <PolicySelect
          label="접근 권한"
          value={policy.accessLevel ?? ""}
          onChange={(v) => onChange(updatePolicyField(policy, "accessLevel", v || undefined))}
          options={[
            { value: "", label: "기본값" },
            { value: "full", label: "전체 허용 (full)" },
            { value: "ask", label: "실행 전 승인 (ask)" },
            { value: "read_only", label: "읽기 전용 (read_only)" },
          ]}
        />
      </section>

      <section className="space-y-2">
        <PolicySectionHeading>허용 작업 폴더</PolicySectionHeading>
        <div className="space-y-1.5">
          {folders.map((grant, index) => (
            <div key={grant.path} className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5">
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{grant.path}</span>
              <button
                type="button"
                aria-label={`폴더 모드 전환: ${grant.path}`}
                onClick={() =>
                  onChange(
                    updatePolicyField(
                      policy,
                      "allowedFolders",
                      folders.map((item, i) =>
                        i === index ? { ...item, mode: item.mode === "ro" ? ("rw" as const) : ("ro" as const) } : item,
                      ),
                    ),
                  )
                }
                className={cn(
                  "shrink-0 rounded border px-2 py-0.5 text-xs transition-colors",
                  grant.mode === "rw"
                    ? "border-green-600/40 bg-green-600/10 text-green-700"
                    : "border-border bg-transparent text-muted-foreground",
                )}
              >
                {folderModeLabels[grant.mode]}
              </button>
              <button
                type="button"
                aria-label={`폴더 삭제: ${grant.path}`}
                onClick={() => {
                  const remaining = folders.filter((_, i) => i !== index);
                  onChange(updatePolicyField(policy, "allowedFolders", remaining.length > 0 ? remaining : undefined));
                }}
                className="shrink-0 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:text-destructive"
              >
                삭제
              </button>
            </div>
          ))}
          {folders.length === 0 && (
            <p className="text-xs text-muted-foreground">등록된 폴더가 없습니다. 아래에서 폴더를 추가하세요.</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <input
            type="text"
            aria-label="새 폴더 경로"
            value={newPath}
            onChange={(e) => setNewPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleAdd();
            }}
            placeholder="/absolute/path/to/folder"
            className={inputCls}
          />
          <select
            aria-label="새 폴더 모드"
            className="shrink-0 rounded-md border border-border bg-transparent px-2 py-1.5 text-xs text-foreground outline-none"
            value={newMode}
            onChange={(e) => setNewMode(e.target.value === "rw" ? "rw" : "ro")}
          >
            <option value="ro">읽기 전용 (ro)</option>
            <option value="rw">읽기·쓰기 (rw)</option>
          </select>
          <button type="button" aria-label="폴더 추가" onClick={handleAdd} className={btnCls}>
            + 폴더 추가
          </button>
        </div>
      </section>

      <section className="space-y-2">
        <PolicySectionHeading>최소 권한</PolicySectionHeading>
        <PolicySwitch
          label="Computer Use 허용"
          checked={policy.allowComputerUse === true}
          onChange={(v) => onChange(updatePolicyField(policy, "allowComputerUse", v))}
        />
        <PolicySwitch
          label="로컬 스크립트 자동 실행"
          checked={policy.allowLocalScripts === true}
          onChange={(v) => onChange(updatePolicyField(policy, "allowLocalScripts", v))}
        />
        <PolicySwitch
          label="자율 새 스레드 개시"
          checked={policy.canStartNewThreads === true}
          onChange={(v) => onChange(updatePolicyField(policy, "canStartNewThreads", v))}
        />
      </section>

      <section className="space-y-2">
        <PolicySectionHeading>MCP 서버 접근</PolicySectionHeading>
        <PolicySelect
          label="MCP 서버 접근"
          value={mcp.mode}
          onChange={(mode) =>
            onChange(updatePolicyField(policy, "mcpAccess", { mode: mode as AgentMcpAccess["mode"], servers: mcp.servers }))
          }
          options={[
            { value: "allow_all", label: "전체 허용 (allow_all)" },
            { value: "allowlist", label: "허용 목록 (allowlist)" },
            { value: "denylist", label: "차단 목록 (denylist)" },
          ]}
        />
        {mcp.mode !== "allow_all" && (
          <input
            type="text"
            aria-label="MCP 서버 이름"
            value={serversDraft ?? mcp.servers.join(", ")}
            onChange={(e) => setServersDraft(e.target.value)}
            onBlur={() => {
              if (serversDraft === null) return;
              onChange(updatePolicyField(policy, "mcpAccess", { mode: mcp.mode, servers: parseServerNames(serversDraft) }));
              setServersDraft(null);
            }}
            placeholder="예: filesystem, github"
            className={inputCls}
          />
        )}
      </section>
    </div>
  );
}
