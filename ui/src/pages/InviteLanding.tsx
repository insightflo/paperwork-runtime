import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@/lib/router";
import { accessApi } from "../api/access";
import { authApi } from "../api/auth";
import { healthApi } from "../api/health";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { AGENT_ADAPTER_TYPES } from "@paperclipai/shared";
import type { AgentAdapterType, JoinRequest } from "@paperclipai/shared";

type JoinType = "human" | "agent";
const joinAdapterOptions: AgentAdapterType[] = [...AGENT_ADAPTER_TYPES];

const adapterLabels: Record<string, string> = {
  claude_local: "Claude (local)", codex_local: "Codex (local)",
  antigravity_local: "Antigravity (local)", gemini_local: "Gemini CLI (local)",
  opencode_local: "OpenCode (local)", commandcode_local: "Command Code (local)",
  cursor: "Cursor (local)", pi_local: "Pi (local)",
  process: "Process", http: "HTTP",
};

const ENABLED_INVITE_ADAPTERS = new Set([
  "claude_local", "codex_local", "antigravity_local", "gemini_local",
  "opencode_local", "cursor", "commandcode_local",
  "pi_local",
]);

const cardClass =
  "tactile-card rounded-xl border border-slate-200/90 bg-white p-6 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.05)] dark:border-white/[0.08] dark:bg-[#0e131d] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_14px_36px_-18px_rgba(0,0,0,0.8)]";
const eyebrowClass = "mb-1 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-[#8b97ad]";
const insetPanelClass =
  "rounded-lg border border-slate-200/80 bg-slate-50/80 p-3.5 text-xs text-slate-700 dark:border-white/[0.07] dark:bg-[#07090d]/85 dark:text-[#c9d3e4]";
const fieldLabelClass = `block ${eyebrowClass}`;
const inputClass =
  "w-full rounded-lg border border-slate-200/90 bg-white px-3 py-2 text-sm text-slate-950 outline-none transition-colors placeholder:text-slate-400 focus:border-blue-500/60 focus:ring-2 focus:ring-blue-500/20 dark:border-white/[0.1] dark:bg-[#07090d] dark:text-[#edf2fb] dark:placeholder:text-[#8b97ad]/60 dark:focus:border-[#60a5fa]/60 dark:focus:ring-[#60a5fa]/25";
const pillBase =
  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-[0.14em]";

function dateTime(value: string) {
  return new Date(value).toLocaleString();
}

function readNestedString(value: unknown, path: string[]): string | null {
  let current: unknown = value;
  for (const segment of path) {
    if (!current || typeof current !== "object") return null;
    current = (current as Record<string, unknown>)[segment];
  }
  return typeof current === "string" && current.trim().length > 0 ? current : null;
}

export function InviteLandingPage() {
  const queryClient = useQueryClient();
  const params = useParams();
  const token = (params.token ?? "").trim();
  const [joinType, setJoinType] = useState<JoinType>("human");
  const [agentName, setAgentName] = useState("");
  const [adapterType, setAdapterType] = useState<AgentAdapterType>("claude_local");
  const [capabilities, setCapabilities] = useState("");
  const [result, setResult] = useState<{ kind: "bootstrap" | "join"; payload: unknown } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
  });
  const sessionQuery = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });
  const inviteQuery = useQuery({
    queryKey: queryKeys.access.invite(token),
    queryFn: () => accessApi.getInvite(token),
    enabled: token.length > 0,
    retry: false,
  });

  const invite = inviteQuery.data;
  const allowedJoinTypes = invite?.allowedJoinTypes ?? "both";
  const availableJoinTypes = useMemo(() => {
    if (invite?.inviteType === "bootstrap_ceo") return ["human"] as JoinType[];
    if (allowedJoinTypes === "both") return ["human", "agent"] as JoinType[];
    return [allowedJoinTypes] as JoinType[];
  }, [invite?.inviteType, allowedJoinTypes]);

  useEffect(() => {
    if (!availableJoinTypes.includes(joinType)) {
      setJoinType(availableJoinTypes[0] ?? "human");
    }
  }, [availableJoinTypes, joinType]);

  const requiresAuthForHuman =
    joinType === "human" &&
    healthQuery.data?.deploymentMode === "authenticated" &&
    !sessionQuery.data;

  const acceptMutation = useMutation({
    mutationFn: async () => {
      if (!invite) throw new Error("Invite not found");
      if (invite.inviteType === "bootstrap_ceo") {
        return accessApi.acceptInvite(token, { requestType: "human" });
      }
      if (joinType === "human") {
        return accessApi.acceptInvite(token, { requestType: "human" });
      }
      return accessApi.acceptInvite(token, {
        requestType: "agent",
        agentName: agentName.trim(),
        adapterType,
        capabilities: capabilities.trim() || null,
      });
    },
    onSuccess: async (payload) => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
      await queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      const asBootstrap =
        payload && typeof payload === "object" && "bootstrapAccepted" in (payload as Record<string, unknown>);
      setResult({ kind: asBootstrap ? "bootstrap" : "join", payload });
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Failed to accept invite");
    },
  });

  if (!token) {
    return (
      <div className="mx-auto max-w-xl px-4 py-10 tabular-nums">
        <div className={cardClass}>
          <span className={`${pillBase} border-rose-500/30 bg-rose-500/10 text-rose-700 dark:border-rose-400/30 dark:bg-rose-500/12 dark:text-rose-300`}>
            Invite access
          </span>
          <p className="mt-3 text-sm text-rose-700 dark:text-rose-300">Invalid invite token.</p>
        </div>
      </div>
    );
  }

  if (inviteQuery.isLoading || healthQuery.isLoading || sessionQuery.isLoading) {
    return (
      <div className="mx-auto max-w-xl px-4 py-10 tabular-nums">
        <div className={`${cardClass} flex items-center gap-2.5 text-sm text-slate-600 dark:text-[#8b97ad]`}>
          <span aria-hidden className="h-2 w-2 animate-pulse rounded-full bg-blue-500 dark:bg-[#60a5fa]" />
          Loading invite...
        </div>
      </div>
    );
  }

  if (inviteQuery.error || !invite) {
    return (
      <div className="mx-auto max-w-xl px-4 py-10 tabular-nums">
        <div className={cardClass}>
          <span className={`${pillBase} border-rose-500/30 bg-rose-500/10 text-rose-700 dark:border-rose-400/30 dark:bg-rose-500/12 dark:text-rose-300`}>
            Invite access
          </span>
          <h1 className="mt-3 text-lg font-semibold tracking-tight text-slate-950 dark:text-[#edf2fb]">Invite not available</h1>
          <p className="mt-2 text-sm text-slate-600 dark:text-[#8b97ad]">
            This invite may be expired, revoked, or already used.
          </p>
        </div>
      </div>
    );
  }

  if (result?.kind === "bootstrap") {
    return (
      <div className="mx-auto max-w-xl px-4 py-10 tabular-nums">
        <div className={cardClass}>
          <span className={`${pillBase} border-lime-500/30 bg-lime-500/10 text-lime-700 dark:border-[#a3e635]/30 dark:bg-[#a3e635]/12 dark:text-[#a3e635]`}>
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-lime-500 shadow-[0_0_6px_rgba(163,230,53,0.75)] dark:bg-[#a3e635]" />
            Bootstrap access
          </span>
          <h1 className="mt-3 text-lg font-semibold tracking-tight text-slate-950 dark:text-[#edf2fb]">Bootstrap complete</h1>
          <p className="mt-2 text-sm text-slate-600 dark:text-[#8b97ad]">
            The first instance admin is now configured. You can continue to the board.
          </p>
          <Button
            asChild
            className="mt-5 rounded-lg bg-blue-600 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] hover:bg-blue-700 dark:bg-[#2563eb] dark:hover:bg-[#3b82f6]"
          >
            <Link to="/">Open board</Link>
          </Button>
        </div>
      </div>
    );
  }

  if (result?.kind === "join") {
    const payload = result.payload as JoinRequest & {
      claimSecret?: string;
      claimApiKeyPath?: string;
      onboarding?: Record<string, unknown>;
      diagnostics?: Array<{
        code: string;
        level: "info" | "warn";
        message: string;
        hint?: string;
      }>;
    };
    const claimSecret = typeof payload.claimSecret === "string" ? payload.claimSecret : null;
    const claimApiKeyPath = typeof payload.claimApiKeyPath === "string" ? payload.claimApiKeyPath : null;
    const onboardingSkillUrl = readNestedString(payload.onboarding, ["skill", "url"]);
    const onboardingSkillPath = readNestedString(payload.onboarding, ["skill", "path"]);
    const onboardingInstallPath = readNestedString(payload.onboarding, ["skill", "installPath"]);
    const onboardingTextUrl = readNestedString(payload.onboarding, ["textInstructions", "url"]);
    const onboardingTextPath = readNestedString(payload.onboarding, ["textInstructions", "path"]);
    const diagnostics = Array.isArray(payload.diagnostics) ? payload.diagnostics : [];
    return (
      <div className="mx-auto max-w-xl px-4 py-10 tabular-nums">
        <div className={cardClass}>
          <span className={`${pillBase} border-amber-500/30 bg-amber-500/10 text-amber-800 dark:border-[#f59e0b]/35 dark:bg-[#f59e0b]/12 dark:text-[#f59e0b]`}>
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-amber-500 dark:bg-[#f59e0b]" />
            Join approval
          </span>
          <h1 className="mt-3 text-lg font-semibold tracking-tight text-slate-950 dark:text-[#edf2fb]">Join request submitted</h1>
          <p className="mt-2 text-sm text-slate-600 dark:text-[#8b97ad]">
            Your request is pending admin approval. You will not have access until approved.
          </p>
          <div className={`mt-4 ${insetPanelClass}`}>
            <div className={eyebrowClass}>Request ID</div>
            <div className="font-mono text-slate-900 dark:text-[#edf2fb]">{payload.id}</div>
          </div>
          {claimSecret && claimApiKeyPath && (
            <div className="mt-3 space-y-1 rounded-lg border border-amber-500/30 bg-amber-500/8 p-3.5 text-xs text-slate-800 dark:border-[#f59e0b]/35 dark:bg-[#f59e0b]/10 dark:text-[#edf2fb]">
              <p className="mb-1 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-amber-800 dark:text-[#f59e0b]">
                One-time claim secret (save now)
              </p>
              <p className="break-all font-mono">{claimSecret}</p>
              <p className="break-all font-mono text-slate-600 dark:text-[#c9d3e4]">POST {claimApiKeyPath}</p>
            </div>
          )}
          {(onboardingSkillUrl || onboardingSkillPath || onboardingInstallPath) && (
            <div className={`mt-3 space-y-1 ${insetPanelClass}`}>
              <p className={eyebrowClass}>Paperwork skill bootstrap</p>
              {onboardingSkillUrl && <p className="break-all font-mono text-slate-900 dark:text-[#edf2fb]">GET {onboardingSkillUrl}</p>}
              {!onboardingSkillUrl && onboardingSkillPath && <p className="break-all font-mono text-slate-900 dark:text-[#edf2fb]">GET {onboardingSkillPath}</p>}
              {onboardingInstallPath && <p className="break-all font-mono text-slate-600 dark:text-[#8b97ad]">Install to {onboardingInstallPath}</p>}
            </div>
          )}
          {(onboardingTextUrl || onboardingTextPath) && (
            <div className={`mt-3 space-y-1 ${insetPanelClass}`}>
              <p className={eyebrowClass}>Agent-readable onboarding text</p>
              {onboardingTextUrl && <p className="break-all font-mono text-slate-900 dark:text-[#edf2fb]">GET {onboardingTextUrl}</p>}
              {!onboardingTextUrl && onboardingTextPath && <p className="break-all font-mono text-slate-900 dark:text-[#edf2fb]">GET {onboardingTextPath}</p>}
            </div>
          )}
          {diagnostics.length > 0 && (
            <div className={`mt-3 space-y-2 ${insetPanelClass}`}>
              <p className={eyebrowClass}>Connectivity diagnostics</p>
              {diagnostics.map((diag) => (
                <div key={`${diag.code}:${diag.message}`} className="space-y-0.5">
                  <p className={diag.level === "warn" ? "font-medium text-amber-700 dark:text-[#f59e0b]" : "text-blue-700 dark:text-[#60a5fa]"}>
                    [{diag.level}] {diag.message}
                  </p>
                  {diag.hint && <p className="break-all font-mono text-slate-600 dark:text-[#8b97ad]">{diag.hint}</p>}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl px-4 py-10 tabular-nums">
      <div className={cardClass}>
        <span className={`${pillBase} border-blue-500/25 bg-blue-500/10 text-blue-700 dark:border-[#60a5fa]/30 dark:bg-[#60a5fa]/12 dark:text-[#60a5fa]`}>
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-blue-500 shadow-[0_0_6px_rgba(96,165,250,0.65)] dark:bg-[#60a5fa]" />
          {invite.inviteType === "bootstrap_ceo" ? "Bootstrap access" : "Invite intake"}
        </span>
        <h1 className="mt-3 text-xl font-semibold tracking-tight text-slate-950 dark:text-[#edf2fb]">
          {invite.inviteType === "bootstrap_ceo" ? "Bootstrap your Paperwork instance" : "Join this Paperwork company"}
        </h1>
        <p className="mt-2 text-sm text-slate-600 dark:text-[#8b97ad]">Invite expires {dateTime(invite.expiresAt)}.</p>

        {invite.inviteType !== "bootstrap_ceo" && (
          <div className="mt-5 inline-flex gap-1.5 rounded-lg border border-slate-200/90 bg-slate-100/80 p-1 dark:border-white/[0.08] dark:bg-[#07090d]">
            {availableJoinTypes.map((type) => (
              <button
                key={type}
                type="button"
                onClick={() => setJoinType(type)}
                className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                  joinType === type
                    ? "bg-blue-600 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] dark:bg-[#2563eb]"
                    : "text-slate-600 hover:text-slate-950 dark:text-[#8b97ad] dark:hover:text-[#edf2fb]"
                }`}
              >
                Join as {type}
              </button>
            ))}
          </div>
        )}

        {joinType === "agent" && invite.inviteType !== "bootstrap_ceo" && (
          <div className={`mt-4 space-y-3 ${insetPanelClass}`}>
            <label className="block text-sm">
              <span className={fieldLabelClass}>Agent name</span>
              <input
                className={inputClass}
                value={agentName}
                onChange={(event) => setAgentName(event.target.value)}
              />
            </label>
            <label className="block text-sm">
              <span className={fieldLabelClass}>Adapter type</span>
              <select
                className={inputClass}
                value={adapterType}
                onChange={(event) => setAdapterType(event.target.value as AgentAdapterType)}
              >
                {joinAdapterOptions.map((type) => (
                  <option key={type} value={type} disabled={!ENABLED_INVITE_ADAPTERS.has(type)}>
                    {adapterLabels[type] ?? type}{!ENABLED_INVITE_ADAPTERS.has(type) ? " (Coming soon)" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm">
              <span className={fieldLabelClass}>Capabilities (optional)</span>
              <textarea
                className={inputClass}
                rows={4}
                value={capabilities}
                onChange={(event) => setCapabilities(event.target.value)}
              />
            </label>
          </div>
        )}

        {requiresAuthForHuman && (
          <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/8 p-3.5 text-sm text-amber-900 dark:border-[#f59e0b]/35 dark:bg-[#f59e0b]/10 dark:text-[#fde68a]">
            Sign in or create an account before submitting a human join request.
            <div className="mt-2.5">
              <Button
                asChild
                size="sm"
                variant="outline"
                className="rounded-lg border-amber-500/40 bg-white text-amber-900 hover:bg-amber-50 dark:border-[#f59e0b]/40 dark:bg-[#07090d] dark:text-[#fde68a] dark:hover:bg-[#f59e0b]/15"
              >
                <Link to={`/auth?next=${encodeURIComponent(`/invite/${token}`)}`}>Sign in / Create account</Link>
              </Button>
            </div>
          </div>
        )}

        {error && (
          <p className="mt-4 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-700 dark:border-rose-400/30 dark:bg-rose-500/12 dark:text-rose-300">
            {error}
          </p>
        )}

        <Button
          className="mt-5 rounded-lg bg-blue-600 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] hover:bg-blue-700 dark:bg-[#2563eb] dark:hover:bg-[#3b82f6]"
          disabled={
            acceptMutation.isPending ||
            (joinType === "agent" && invite.inviteType !== "bootstrap_ceo" && agentName.trim().length === 0) ||
            requiresAuthForHuman
          }
          onClick={() => acceptMutation.mutate()}
        >
          {acceptMutation.isPending
            ? "Submitting…"
            : invite.inviteType === "bootstrap_ceo"
              ? "Accept bootstrap invite"
              : "Submit join request"}
        </Button>
      </div>
    </div>
  );
}
