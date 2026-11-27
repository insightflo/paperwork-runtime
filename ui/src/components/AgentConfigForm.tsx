import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Agent, EnvBinding } from "@paperclipai/shared";
import { AGENT_ADAPTER_TYPES } from "@paperclipai/shared";
import type { AdapterModel } from "../api/agents";
import { agentsApi } from "../api/agents";
import { instanceSettingsApi } from "../api/instanceSettings";
import { secretsApi } from "../api/secrets";
import { assetsApi } from "../api/assets";
import {
  DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX,
  DEFAULT_CODEX_LOCAL_MODEL,
} from "@paperclipai/adapter-codex-local";
import { Button } from "@/components/ui/button";
import { FolderOpen, Heart } from "lucide-react";
import { cn } from "../lib/utils";
import { queryKeys } from "../lib/queryKeys";
import { useCompany } from "../context/CompanyContext";
import {
  Field,
  ToggleField,
  ToggleWithNumber,
  CollapsibleSection,
  DraftInput,
  DraftNumberInput,
  help,
  adapterLabels,
} from "./agent-config-primitives";
import { isAdapterTypeEnabled } from "./agent-config-adapter-types";
import { AgentFallbackChainEditor, normalizeFallbackOrder } from "./AgentFallbackChainEditor";
import { AgentPermissionsFoldersTab } from "./agent-settings/AgentPermissionsFoldersTab";
import { normalizeBotPolicy, type AgentBotPolicy } from "./agent-settings/AgentBehaviorTab";
import { AgentBehaviorTab } from "./agent-settings/AgentBehaviorTab";
import { defaultCreateValues, getStaticThinkingEffortOptions } from "./agent-config-defaults";
import { getUIAdapter } from "../adapters";
import { ClaudeLocalAdvancedFields } from "../adapters/claude-local/config-fields";
import { CommandCodeLocalAdvancedFields } from "../adapters/commandcode-local/config-fields";
import { MarkdownEditor } from "./MarkdownEditor";
import { ChoosePathButton } from "./PathInstructionsModal";
import { ReportsToPicker } from "./ReportsToPicker";
import { shouldShowLegacyWorkingDirectoryField } from "../lib/legacy-agent-config";
import { useAdapterModelEfforts } from "../hooks/useAdapterModelEfforts";
import { buildCommandCodeEffortOptions, shouldResetCommandCodeEffort } from "../lib/commandcode-efforts";
import {
  sessionTokenThresholdFieldValue,
  updateSessionTokenThreshold,
} from "../lib/session-compaction-ui";

/* ---- Create mode values ---- */

// Canonical type lives in @paperclipai/adapter-utils; re-exported here
// so existing imports from this file keep working.
export type { CreateConfigValues } from "@paperclipai/adapter-utils";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import {
  AdapterEnvironmentResult,
  AdapterTypeDropdown,
  EnvVarEditor,
  ModelDropdown,
  ThinkingEffortDropdown,
} from "./agent-config-form-fields";

const tactileInputClass = "w-full rounded-md border border-slate-200/90 bg-white px-2.5 py-1.5 text-sm font-mono text-slate-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.85)] outline-none transition-[border-color,box-shadow] placeholder:text-slate-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-white/[0.1] dark:bg-[#090c12] dark:text-[#eef2f8] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] dark:placeholder:text-[#627089] dark:focus:border-[#60a5fa] dark:focus:ring-[#60a5fa]/25";

/* ---- Props ---- */

type AgentConfigFormProps = {
  adapterModels?: AdapterModel[];
  onDirtyChange?: (dirty: boolean) => void;
  onSaveActionChange?: (save: (() => void) | null) => void;
  onCancelActionChange?: (cancel: (() => void) | null) => void;
  hideInlineSave?: boolean;
  showAdapterTypeField?: boolean;
  showAdapterTestEnvironmentButton?: boolean;
  showCreateRunPolicySection?: boolean;
  hideInstructionsFile?: boolean;
  /** Hide the prompt template field from the Identity section (used when it's shown in a separate Prompts tab). */
  hidePromptTemplate?: boolean;
  /** "cards" renders each section as heading + bordered card (for settings pages). Default: "inline" (border-b dividers). */
  sectionLayout?: "inline" | "cards";
} & (
  | {
      mode: "create";
      values: CreateConfigValues;
      onChange: (patch: Partial<CreateConfigValues>) => void;
    }
  | {
      mode: "edit";
      agent: Agent;
      onSave: (patch: Record<string, unknown>) => void;
      isSaving?: boolean;
    }
);

/* ---- Edit mode overlay (dirty tracking) ---- */

interface Overlay {
  identity: Record<string, unknown>;
  adapterType?: string;
  adapterConfig: Record<string, unknown>;
  heartbeat: Record<string, unknown>;
  runtime: Record<string, unknown>;
}

const emptyOverlay: Overlay = {
  identity: {},
  adapterConfig: {},
  heartbeat: {},
  runtime: {},
};

/** Stable empty object used as fallback for missing env config to avoid new-object-per-render. */
const EMPTY_ENV: Record<string, EnvBinding> = {};

/** Merge config columns with env merged at the env-key level (server mergeAgentConfig parity). */
function mergeConfigColumns(adapterConfig: unknown, agentConfig: unknown): Record<string, unknown> {
  const adapter = (adapterConfig ?? {}) as Record<string, unknown>;
  const agent = (agentConfig ?? {}) as Record<string, unknown>;
  const merged = { ...adapter, ...agent };
  const asEnv = (value: unknown): Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const adapterEnv = asEnv(adapter.env);
  const agentEnv = asEnv(agent.env);
  if (Object.keys(adapterEnv).length > 0 || Object.keys(agentEnv).length > 0) {
    merged.env = { ...adapterEnv, ...agentEnv };
  }
  return merged;
}

function isOverlayDirty(o: Overlay): boolean {
  return (
    Object.keys(o.identity).length > 0 ||
    o.adapterType !== undefined ||
    Object.keys(o.adapterConfig).length > 0 ||
    Object.keys(o.heartbeat).length > 0 ||
    Object.keys(o.runtime).length > 0
  );
}

function parseCommaArgs(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatArgList(value: unknown): string {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .join(", ");
  }
  return typeof value === "string" ? value : "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/* ---- Form ---- */

export function AgentConfigForm(props: AgentConfigFormProps) {
  const { mode, adapterModels: externalModels } = props;
  const isCreate = mode === "create";
  const cards = props.sectionLayout === "cards";
  const showAdapterTypeField = props.showAdapterTypeField ?? true;
  const showAdapterTestEnvironmentButton = props.showAdapterTestEnvironmentButton ?? true;
  const showCreateRunPolicySection = props.showCreateRunPolicySection ?? true;
  const hideInstructionsFile = props.hideInstructionsFile ?? false;
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();

  const { data: availableSecrets = [] } = useQuery({
    queryKey: selectedCompanyId ? queryKeys.secrets.list(selectedCompanyId) : ["secrets", "none"],
    queryFn: () => secretsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const createSecret = useMutation({
    mutationFn: (input: { name: string; value: string }) => {
      if (!selectedCompanyId) throw new Error("Select a company to create secrets");
      return secretsApi.create(selectedCompanyId, input);
    },
    onSuccess: () => {
      if (!selectedCompanyId) return;
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.list(selectedCompanyId) });
    },
  });

  const uploadMarkdownImage = useMutation({
    mutationFn: async ({ file, namespace }: { file: File; namespace: string }) => {
      if (!selectedCompanyId) throw new Error("Select a company to upload images");
      return assetsApi.uploadImage(selectedCompanyId, file, namespace);
    },
  });

  // ---- Edit mode: overlay for dirty tracking ----
  const [overlay, setOverlay] = useState<Overlay>(emptyOverlay);
  const agentRef = useRef<Agent | null>(null);

  // Clear overlay when agent data refreshes (after save)
  useEffect(() => {
    if (!isCreate) {
      if (agentRef.current !== null && props.agent !== agentRef.current) {
        setOverlay({ ...emptyOverlay });
      }
      agentRef.current = props.agent;
    }
  }, [isCreate, !isCreate ? props.agent : undefined]); // eslint-disable-line react-hooks/exhaustive-deps

  const isDirty = !isCreate && isOverlayDirty(overlay);

  /** Read effective value: overlay if dirty, else original */
  function eff<T>(group: keyof Omit<Overlay, "adapterType">, field: string, original: T): T {
    const o = overlay[group];
    if (field in o) return o[field] as T;
    return original;
  }

  /** Mark field dirty in overlay */
  function mark(group: keyof Omit<Overlay, "adapterType">, field: string, value: unknown) {
    setOverlay((prev) => ({
      ...prev,
      [group]: { ...prev[group], [field]: value },
    }));
  }

  /** Build accumulated patch and send to parent */
  const handleCancel = useCallback(() => {
    setOverlay({ ...emptyOverlay });
  }, []);

  const handleSave = useCallback(() => {
    if (isCreate || !isDirty) return;
    const agent = props.agent;
    const patch: Record<string, unknown> = {};

    if (Object.keys(overlay.identity).length > 0) {
      Object.assign(patch, overlay.identity);
    }
    if (overlay.adapterType !== undefined) {
      patch.adapterType = overlay.adapterType;
      // When adapter type changes, send only the new config — don't merge
      // with old config since old adapter fields are meaningless for the new type
      patch.adapterConfig = overlay.adapterConfig;
    } else if (Object.keys(overlay.adapterConfig).length > 0) {
      const existing = mergeConfigColumns(agent.adapterConfig, agent.agentConfig);
      patch.adapterConfig = { ...existing, ...overlay.adapterConfig };
    }
    if (Object.keys(overlay.heartbeat).length > 0) {
      const existingRc = (agent.runtimeConfig ?? {}) as Record<string, unknown>;
      const existingHb = (existingRc.heartbeat ?? {}) as Record<string, unknown>;
      patch.runtimeConfig = { ...existingRc, heartbeat: { ...existingHb, ...overlay.heartbeat } };
    }
    if (Object.keys(overlay.runtime).length > 0) {
      Object.assign(patch, overlay.runtime);
    }

    props.onSave(patch);
  }, [isCreate, isDirty, overlay, props]);

  useEffect(() => {
    if (!isCreate) {
      props.onDirtyChange?.(isDirty);
      props.onSaveActionChange?.(handleSave);
      props.onCancelActionChange?.(handleCancel);
    }
  }, [isCreate, isDirty, props.onDirtyChange, props.onSaveActionChange, props.onCancelActionChange, handleSave, handleCancel]);

  useEffect(() => {
    if (isCreate) return;
    return () => {
      props.onSaveActionChange?.(null);
      props.onCancelActionChange?.(null);
      props.onDirtyChange?.(false);
    };
  }, [isCreate, props.onDirtyChange, props.onSaveActionChange, props.onCancelActionChange]);

  // ---- Resolve values ----
  const config = !isCreate
    ? mergeConfigColumns(props.agent.adapterConfig, props.agent.agentConfig)
    : {};
  const runtimeConfig = !isCreate ? ((props.agent.runtimeConfig ?? {}) as Record<string, unknown>) : {};
  const heartbeat = !isCreate ? ((runtimeConfig.heartbeat ?? {}) as Record<string, unknown>) : {};
  const storedSessionCompaction =
    heartbeat.sessionCompaction ?? heartbeat.sessionRotation ?? runtimeConfig.sessionCompaction;
  // [session rotation] nested heartbeat key — overlay wins, original falls back.
  // Kept whole-object so sibling sessionCompaction keys (maxSessionRuns 등) are never dropped.
  const sessionCompaction = !isCreate
    ? {
      ...(typeof storedSessionCompaction === "object" && storedSessionCompaction !== null && !Array.isArray(storedSessionCompaction)
        ? storedSessionCompaction as Record<string, unknown>
        : {}),
      ...((overlay.heartbeat.sessionCompaction as Record<string, unknown> | undefined) ?? {}),
    }
    : {};

  const adapterType = isCreate
    ? props.values.adapterType
    : overlay.adapterType ?? props.agent.adapterType;
  const sessionTokenDefault = sessionTokenThresholdFieldValue(adapterType, {});
  const isLocal =
    adapterType === "claude_local" ||
    adapterType === "codex_local" ||
    adapterType === "commandcode_local" ||
    adapterType === "pi_local";
  const supportsAdapterFallback =
    adapterType === "claude_local" ||
    adapterType === "codex_local" ||
    adapterType === "commandcode_local" ||
    adapterType === "pi_local";
  // [stage28-w2] 라이브 쿼터 제한/쿨다운 스냅샷 — 폴백 체인 각 행에 게이트 배지로 표시.
  // 조회 실패 시 배지 없이 조용히 폴백(데이터 null)하므로 편집 흐름을 막지 않는다.
  const usageLimitGateQuery = useQuery({
    queryKey: ["instance", "usage-limit-gate"] as const,
    queryFn: () => instanceSettingsApi.getUsageLimitGate(),
    enabled: supportsAdapterFallback,
    retry: false,
    staleTime: 30_000,
  });
  const showLegacyWorkingDirectoryField =
    isLocal && shouldShowLegacyWorkingDirectoryField({ isCreate, adapterConfig: config });
  const uiAdapter = useMemo(() => getUIAdapter(adapterType), [adapterType]);

  // Fetch adapter models for the effective adapter type
  const {
    data: fetchedModels,
    error: fetchedModelsError,
  } = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.agents.adapterModels(selectedCompanyId, adapterType)
      : ["agents", "none", "adapter-models", adapterType],
    queryFn: () => agentsApi.adapterModels(selectedCompanyId!, adapterType),
    enabled: Boolean(selectedCompanyId),
  });
  const models = fetchedModels ?? externalModels ?? [];

  const { data: companyAgents = [] } = useQuery({
    queryKey: selectedCompanyId ? queryKeys.agents.list(selectedCompanyId) : ["agents", "none", "list"],
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: Boolean(!isCreate && selectedCompanyId),
  });

  /** Props passed to adapter-specific config field components */
  const adapterFieldProps = {
    mode,
    isCreate,
    adapterType,
    values: isCreate ? props.values : null,
    set: isCreate ? (patch: Partial<CreateConfigValues>) => props.onChange(patch) : null,
    config,
    eff: eff as <T>(group: "adapterConfig", field: string, original: T) => T,
    mark: mark as (group: "adapterConfig", field: string, value: unknown) => void,
    models,
    hideInstructionsFile,
  };

  // Section toggle state — advanced always starts collapsed
  const [runPolicyAdvancedOpen, setRunPolicyAdvancedOpen] = useState(false);
  // [stage30-w5] 4-tab progressive disclosure. All form state stays in this component,
  // so switching tabs never loses in-progress changes.
  const [activeTab, setActiveTab] = useState<"basic" | "permissions" | "behavior" | "advanced">("basic");
  // [stage30-w5] Bot policy (OpenBot botPolicy) — stored in adapterConfig.botPolicy.
  // CreateConfigValues has no botPolicy slot, so create mode keeps it in local state
  // (not persisted on create yet); edit mode persists via the adapterConfig overlay.
  const [createBotPolicy, setCreateBotPolicy] = useState<AgentBotPolicy>({});
  const currentBotPolicy = isCreate
    ? createBotPolicy
    : normalizeBotPolicy(eff("adapterConfig", "botPolicy", config.botPolicy));
  function updateBotPolicy(next: AgentBotPolicy) {
    if (isCreate) {
      setCreateBotPolicy(next);
      return;
    }
    mark("adapterConfig", "botPolicy", Object.keys(next).length > 0 ? next : undefined);
  }
  // Popover states
  const [modelOpen, setModelOpen] = useState(false);
  const [thinkingEffortOpen, setThinkingEffortOpen] = useState(false);

  // Create mode helpers
  const val = isCreate ? props.values : null;
  const set = isCreate
    ? (patch: Partial<CreateConfigValues>) => props.onChange(patch)
    : null;

  function buildAdapterConfigForTest(): Record<string, unknown> {
    if (isCreate) {
      return uiAdapter.buildAdapterConfig(val!);
    }
    const base = config as Record<string, unknown>;
    return { ...base, ...overlay.adapterConfig };
  }

  const testEnvironment = useMutation({
    mutationFn: async () => {
      if (!selectedCompanyId) {
        throw new Error("Select a company to test adapter environment");
      }
      return agentsApi.testEnvironment(selectedCompanyId, adapterType, {
        adapterConfig: buildAdapterConfigForTest(),
      });
    },
  });

  // Current model for display
  const currentModelId = isCreate
    ? val!.model
    : eff("adapterConfig", "model", String(config.model ?? ""));

  function handleModelChange(modelId: string) {
    if (isCreate) {
      set!({ model: modelId });
      return;
    }
    mark("adapterConfig", "model", modelId || undefined);
  }
  const currentFallbackConfig = isCreate
    ? {}
    : asRecord(eff("adapterConfig", "fallback", asRecord(config.fallback)));
  const currentFallbackCommand = isCreate
    ? (val!.fallbackCommand ?? "")
    : String(
        eff(
          "adapterConfig",
          "fallbackCommand",
          String(config.fallbackCommand ?? currentFallbackConfig.command ?? ""),
        ) ?? "",
      );

  function markFallbackConfigField(field: string, value: unknown) {
    if (isCreate) return;
    const next = {
      ...asRecord(eff("adapterConfig", "fallback", asRecord(config.fallback))),
    };
    if (value === undefined || value === "") {
      delete next[field];
    } else {
      next[field] = value;
    }
    mark("adapterConfig", "fallback", Object.keys(next).length > 0 ? next : undefined);
  }

  // Automatic failover defaults to on; absent/true both mean enabled.
  const currentFallbackAutomatic = isCreate
    ? val!.fallbackAutomatic !== false
    : currentFallbackConfig.automatic !== false;
  const currentFallbackOrder = isCreate
    ? (val!.fallbackOrder ?? [])
    : normalizeFallbackOrder(currentFallbackConfig.order);
  const fallbackAvailableAdapters = useMemo(
    () =>
      AGENT_ADAPTER_TYPES
        .filter((type) => isAdapterTypeEnabled(type))
        .map((type) => ({ type, label: adapterLabels[type] ?? type })),
    [],
  );

  const { data: commandCodeEfforts, isSuccess: commandCodeEffortsLoaded } = useAdapterModelEfforts(
    selectedCompanyId,
    adapterType,
    currentModelId,
  );
  const thinkingEffortKey =
    adapterType === "codex_local"
      ? "modelReasoningEffort"
      : adapterType === "pi_local"
        ? "thinking"
        : "effort";
  const thinkingEffortOptions =
    adapterType === "commandcode_local"
      ? buildCommandCodeEffortOptions(commandCodeEfforts ?? [])
      : getStaticThinkingEffortOptions(adapterType);
  const currentThinkingEffort = isCreate
    ? val!.thinkingEffort
    : adapterType === "codex_local"
      ? eff(
          "adapterConfig",
          "modelReasoningEffort",
          String(config.modelReasoningEffort ?? config.reasoningEffort ?? ""),
        )
      : adapterType === "pi_local"
        ? eff("adapterConfig", "thinking", String(config.thinking ?? ""))
        : eff("adapterConfig", "effort", String(config.effort ?? ""));
  // When the Command Code model changes, a previously-selected effort may no
  // longer be supported by the new model. Reset to Auto ONLY after the effort
  // list has been successfully loaded — never while loading, to avoid clearing
  // a valid selection before the query resolves.
  useEffect(() => {
    if (adapterType !== "commandcode_local") return;
    if (!shouldResetCommandCodeEffort(currentThinkingEffort, commandCodeEfforts, commandCodeEffortsLoaded)) return;
    if (isCreate) {
      set!({ thinkingEffort: "" });
    } else {
      mark("adapterConfig", "effort", undefined);
    }
  }, [adapterType, currentThinkingEffort, commandCodeEfforts, commandCodeEffortsLoaded, isCreate]);
  const codexSearchEnabled = adapterType === "codex_local"
    ? (isCreate ? Boolean(val!.search) : eff("adapterConfig", "search", Boolean(config.search)))
    : false;
  const effectiveRuntimeConfig = useMemo(() => {
    if (isCreate) {
      return {
        heartbeat: {
          enabled: val!.heartbeatEnabled,
          intervalSec: val!.intervalSec,
        },
      };
    }
    const mergedHeartbeat = {
      ...(runtimeConfig.heartbeat && typeof runtimeConfig.heartbeat === "object"
        ? runtimeConfig.heartbeat as Record<string, unknown>
        : {}),
      ...overlay.heartbeat,
    };
    return {
      ...runtimeConfig,
      heartbeat: mergedHeartbeat,
    };
  }, [isCreate, overlay.heartbeat, runtimeConfig, val]);
  return (
    <div className={cn("relative tabular-nums", cards && "space-y-6")}>
      {/* ---- Floating Save button (edit mode, when dirty) ---- */}
      {isDirty && !props.hideInlineSave && (
        <div className="sticky top-0 z-10 flex items-center justify-end border-b border-slate-200/90 bg-white/95 px-4 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] backdrop-blur-sm dark:border-white/[0.08] dark:bg-[#0e131d]/95 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-[#f59e0b]"><span aria-hidden className="h-1.5 w-1.5 rounded-full bg-amber-500 dark:bg-[#f59e0b]" />Unsaved changes</span>
            <Button
              size="sm"
              onClick={handleSave}
              disabled={!isCreate && props.isSaving}
              className="border border-blue-600/20 bg-blue-600 text-white hover:bg-blue-500 dark:border-[#60a5fa]/45 dark:bg-[#2563eb] dark:text-[#f8fafc] dark:hover:bg-[#3b82f6]"
            >
              {!isCreate && props.isSaving ? "Saving..." : "Save"}
            </Button>
          </div>
        </div>
      )}

      {/* ---- [stage30-w5] 4-tab navigation ---- */}
      <div role="tablist" aria-label="Agent settings sections" className={cn("flex items-center gap-1 border-b border-slate-200/80 px-3 dark:border-white/[0.07]", cards && "border-b-0 px-0")}>
        {([
          ["basic", "기본 · 모델"],
          ["permissions", "권한 · 폴더"],
          ["behavior", "협업 · 실행"],
          ["advanced", "고급 · 환경"],
        ] as const).map(([tabId, tabLabel]) => (
          <button
            key={tabId}
            type="button"
            role="tab"
            id={`agent-tab-${tabId}`}
            aria-selected={activeTab === tabId}
            aria-controls={`agent-tabpanel-${tabId}`}
            onClick={() => setActiveTab(tabId)}
            className={cn(
              "border-b-2 px-3 py-1.5 text-xs font-medium transition-colors",
              activeTab === tabId
                ? "border-blue-600 text-blue-700 dark:border-blue-400 dark:text-blue-300"
                : "border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200",
            )}
          >
            {tabLabel}
          </button>
        ))}
      </div>

      {/* ---- [stage30-w5] Tab 1 (basic): identity + adapter + model/fallback chain ---- */}
      {activeTab === "basic" && (
        <div
          role="tabpanel"
          id="agent-tabpanel-basic"
          aria-labelledby="agent-tab-basic"
          tabIndex={0}
          className={cn(!cards && "border-b border-slate-200/80 dark:border-white/[0.07]")}
        >
      {/* ---- Identity (edit only) ---- */}
      {!isCreate && (
        <div className={cn(!cards && "border-b border-slate-200/80 dark:border-white/[0.07]")}>
          {cards
            ? <h3 className="text-sm font-semibold uppercase tracking-[0.08em] text-slate-700 dark:text-[#eef2f8] mb-3">Identity</h3>
            : <div className="px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500 dark:text-[#8f9db3]">Identity</div>
          }
          <div className={cn(cards ? "tactile-card rounded-[12px] border-slate-200/90 bg-white/95 p-4 space-y-3 dark:border-white/[0.08] dark:bg-none dark:bg-[#0e131d] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_10px_28px_-18px_rgba(0,0,0,0.85)]" : "px-4 pb-3 space-y-3")}>
            <Field label="Name" hint={help.name}>
              <DraftInput
                value={eff("identity", "name", props.agent.name)}
                onCommit={(v) => mark("identity", "name", v)}
                immediate
                className={tactileInputClass}
                placeholder="Agent name"
              />
            </Field>
            <Field label="Title" hint={help.title}>
              <DraftInput
                value={eff("identity", "title", props.agent.title ?? "")}
                onCommit={(v) => mark("identity", "title", v || null)}
                immediate
                className={tactileInputClass}
                placeholder="e.g. VP of Engineering"
              />
            </Field>
            <Field label="Reports to" hint={help.reportsTo}>
              <ReportsToPicker
                agents={companyAgents}
                value={eff("identity", "reportsTo", props.agent.reportsTo ?? null)}
                onChange={(id) => mark("identity", "reportsTo", id)}
                excludeAgentIds={[props.agent.id]}
                chooseLabel="Choose manager…"
              />
            </Field>
            <Field label="Capabilities" hint={help.capabilities}>
              <MarkdownEditor
                value={eff("identity", "capabilities", props.agent.capabilities ?? "")}
                onChange={(v) => mark("identity", "capabilities", v || null)}
                placeholder="Describe what this agent can do..."
                contentClassName="min-h-[44px] text-sm font-mono"
                imageUploadHandler={async (file) => {
                  const asset = await uploadMarkdownImage.mutateAsync({
                    file,
                    namespace: `agents/${props.agent.id}/capabilities`,
                  });
                  return asset.contentPath;
                }}
              />
            </Field>
            {isLocal && !props.hidePromptTemplate && (
              <>
                <Field label="Prompt Template" hint={help.promptTemplate}>
                  <MarkdownEditor
                    value={eff(
                      "adapterConfig",
                      "promptTemplate",
                      String(config.promptTemplate ?? ""),
                    )}
                    onChange={(v) => mark("adapterConfig", "promptTemplate", v ?? "")}
                    placeholder="You are agent {{ agent.name }}. Your role is {{ agent.role }}..."
                    contentClassName="min-h-[88px] text-sm font-mono"
                    imageUploadHandler={async (file) => {
                      const namespace = `agents/${props.agent.id}/prompt-template`;
                      const asset = await uploadMarkdownImage.mutateAsync({ file, namespace });
                      return asset.contentPath;
                    }}
                  />
                </Field>
                <div className="rounded-[10px] border border-amber-600/25 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-[#f59e0b]/35 dark:bg-[#f59e0b]/10 dark:text-[#f59e0b]">
                  Prompt template is replayed on every heartbeat. Keep it compact and dynamic to avoid recurring token cost and cache churn.
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ---- Adapter ---- */}
      <div className={cn(!cards && (isCreate ? "border-t border-slate-200/80 dark:border-white/[0.07]" : "border-b border-slate-200/80 dark:border-white/[0.07]"))}>
        <div className={cn(cards ? "flex items-center justify-between mb-3" : "px-4 py-2 flex items-center justify-between gap-2")}>
          {cards
            ? <h3 className="text-sm font-semibold uppercase tracking-[0.08em] text-slate-700 dark:text-[#eef2f8]">Adapter</h3>
            : <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500 dark:text-[#8f9db3]">Adapter</span>
          }
          {showAdapterTestEnvironmentButton && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 rounded-md border-slate-200/90 bg-white px-2.5 text-xs text-slate-700 hover:border-blue-500/40 hover:bg-slate-50 dark:border-white/[0.1] dark:bg-[#090c12] dark:text-[#eef2f8] dark:hover:border-[#60a5fa]/40 dark:hover:bg-[#141b29]"
              onClick={() => testEnvironment.mutate()}
              disabled={testEnvironment.isPending || !selectedCompanyId}
            >
              {testEnvironment.isPending ? "Testing..." : "Test environment"}
            </Button>
          )}
        </div>
        <div className={cn(cards ? "tactile-card rounded-[12px] border-slate-200/90 bg-white/95 p-4 space-y-3 dark:border-white/[0.08] dark:bg-none dark:bg-[#0e131d] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_10px_28px_-18px_rgba(0,0,0,0.85)]" : "px-4 pb-3 space-y-3")}>
          {showAdapterTypeField && (
            <Field label="Adapter type" hint={help.adapterType}>
              <AdapterTypeDropdown
                value={adapterType}
                onChange={(t) => {
                  if (isCreate) {
                    // Reset all adapter-specific fields to defaults when switching adapter type
                    const { adapterType: _at, ...defaults } = defaultCreateValues;
                    const nextValues: CreateConfigValues = { ...defaults, adapterType: t };
                    if (t === "codex_local") {
                      nextValues.model = DEFAULT_CODEX_LOCAL_MODEL;
                      nextValues.dangerouslyBypassSandbox =
                        DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX;
                    } else if (t === "commandcode_local") {
                      nextValues.model = "";
                      nextValues.dangerouslySkipPermissions = false;
                    }
                    set!(nextValues);
                  } else {
                    // Clear all adapter config and explicitly blank out model + effort/mode keys
                    // so the old adapter's values don't bleed through via eff()
                    setOverlay((prev) => ({
                      ...prev,
                      adapterType: t,
                      adapterConfig: {
                        model:
                          t === "codex_local"
                            ? DEFAULT_CODEX_LOCAL_MODEL
                            : "",
                        effort: "",
                        modelReasoningEffort: "",
                        thinking: "",
                        ...(t === "codex_local"
                          ? {
                              dangerouslyBypassApprovalsAndSandbox:
                                DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX,
                            }
                          : {}),
                      },
                    }));
                  }
                }}
              />
            </Field>
          )}

          {testEnvironment.error && (
            <div className="rounded-[10px] border border-red-600/25 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-400/35 dark:bg-red-500/10 dark:text-red-300">
              {testEnvironment.error instanceof Error
                ? testEnvironment.error.message
                : "Environment test failed"}
            </div>
          )}

          {testEnvironment.data && (
            <AdapterEnvironmentResult result={testEnvironment.data} />
          )}

          {/* Prompt template (create mode only — edit mode shows this in Identity) */}
          {isLocal && isCreate && (
            <>
              <Field label="Prompt Template" hint={help.promptTemplate}>
                <MarkdownEditor
                  value={val!.promptTemplate}
                  onChange={(v) => set!({ promptTemplate: v })}
                  placeholder="You are agent {{ agent.name }}. Your role is {{ agent.role }}..."
                  contentClassName="min-h-[88px] text-sm font-mono"
                  imageUploadHandler={async (file) => {
                    const namespace = "agents/drafts/prompt-template";
                    const asset = await uploadMarkdownImage.mutateAsync({ file, namespace });
                    return asset.contentPath;
                  }}
                />
              </Field>
              <div className="rounded-[10px] border border-amber-600/25 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-[#f59e0b]/35 dark:bg-[#f59e0b]/10 dark:text-[#f59e0b]">
                Prompt template is replayed on every heartbeat. Prefer small task framing and variables like <code>{"{{ context.* }}"}</code> or <code>{"{{ run.* }}"}</code>; avoid repeating stable instructions here.
              </div>
            </>
          )}

          {/* Adapter-specific fields */}
          <uiAdapter.ConfigFields {...adapterFieldProps} />
        </div>

      </div>

        {/* [stage30-w5] fallback chain + model + thinking stay on the basic tab */}
        {isLocal && (
          <div className={cn("space-y-3", !cards && "px-4 pb-3")}>
              {supportsAdapterFallback && (
                <AgentFallbackChainEditor
                  primaryAdapterType={adapterType}
                  primaryModel={currentModelId}
                  automatic={currentFallbackAutomatic}
                  order={currentFallbackOrder}
                  legacyFallbackCommand={currentFallbackCommand}
                  availableAdapters={fallbackAvailableAdapters}
                  primaryModels={models}
                  getModelsForAdapter={(type) => (type === adapterType ? models : [])}
                  gateSnapshot={usageLimitGateQuery.data ?? null}
                  onChangeAutomatic={(automatic) =>
                    isCreate
                      ? set!({ fallbackAutomatic: automatic === true ? undefined : false })
                      : markFallbackConfigField("automatic", automatic === true ? undefined : false)
                  }
                  onChangeOrder={(nextOrder) =>
                    isCreate
                      ? set!({ fallbackOrder: nextOrder.length > 0 ? nextOrder : undefined })
                      : markFallbackConfigField("order", nextOrder.length > 0 ? nextOrder : undefined)
                  }
                  onChangeLegacyCommand={(command) =>
                    isCreate
                      ? set!({ fallbackCommand: command })
                      : config.fallbackCommand !== undefined
                        ? mark("adapterConfig", "fallbackCommand", command || undefined)
                        : markFallbackConfigField("command", command || undefined)
                  }
                />
              )}

              <ModelDropdown
                models={models}
                value={currentModelId}
                onChange={handleModelChange}
                open={modelOpen}
                onOpenChange={setModelOpen}
                allowDefault
                required={false}
                groupByProvider={false}
              />
              {fetchedModelsError && (
                <p className="text-xs text-destructive">
                  {fetchedModelsError instanceof Error
                    ? fetchedModelsError.message
                    : "Failed to load adapter models."}
                </p>
              )}

              <ThinkingEffortDropdown
                value={currentThinkingEffort}
                options={thinkingEffortOptions}
                onChange={(v) =>
                  isCreate
                    ? set!({ thinkingEffort: v })
                    : mark("adapterConfig", thinkingEffortKey, v || undefined)
                }
                open={thinkingEffortOpen}
                onOpenChange={setThinkingEffortOpen}
              />
              {adapterType === "codex_local" &&
                codexSearchEnabled &&
                currentThinkingEffort === "minimal" && (
                  <p className="text-xs text-amber-700 dark:text-[#f59e0b]">
                    Codex may reject `minimal` thinking when search is enabled.
                  </p>
                )}
        </div>
      )}

        </div>
      )}

      {/* ---- [stage30-w5] Tab 2 (permissions): botPolicy (OpenBot) ---- */}
      {activeTab === "permissions" && (
        <div
          role="tabpanel"
          id="agent-tabpanel-permissions"
          aria-labelledby="agent-tab-permissions"
          tabIndex={0}
          className={cn(!cards && "px-4 py-4")}
        >
          <AgentPermissionsFoldersTab policy={currentBotPolicy} onChange={updateBotPolicy} />
        </div>
      )}

      {/* ---- [stage30-w5] Tab 4 (advanced): CLI command, cwd, bootstrap legacy, env ---- */}
      {activeTab === "advanced" && (
        <div
          role="tabpanel"
          id="agent-tabpanel-advanced"
          aria-labelledby="agent-tab-advanced"
          tabIndex={0}
          className={cn(!cards && "border-b border-slate-200/80 dark:border-white/[0.07]")}
        >
          {isLocal && (
            <div className={cn("space-y-3", !cards && "px-4 py-3")}>
              <Field label="Command" hint={help.localCommand}>
                <DraftInput
                  value={
                    isCreate
                      ? val!.command
                      : eff("adapterConfig", "command", String(config.command ?? ""))
                  }
                  onCommit={(v) =>
                    isCreate
                      ? set!({ command: v })
                      : mark("adapterConfig", "command", v || undefined)
                  }
                  immediate
                  className={tactileInputClass}
                  placeholder={
                    adapterType === "codex_local"
                      ? "codex"
                      : adapterType === "commandcode_local"
                        ? "cmd"
                        : adapterType === "pi_local"
                          ? "pi"
                          : "claude"
                  }
                />
              </Field>
              {showLegacyWorkingDirectoryField && (
                <Field label="Working directory (deprecated)" hint={help.cwd}>
                  <div className="flex items-center gap-2 rounded-md border border-slate-200/90 bg-white px-2.5 py-1.5 text-slate-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.85)] dark:border-white/[0.1] dark:bg-[#090c12] dark:text-[#eef2f8] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
                    <FolderOpen className="h-3.5 w-3.5 shrink-0 text-slate-400 dark:text-[#627089]" />
                    <DraftInput
                      value={
                        isCreate
                          ? val!.cwd
                          : eff("adapterConfig", "cwd", String(config.cwd ?? ""))
                      }
                      onCommit={(v) =>
                        isCreate
                          ? set!({ cwd: v })
                          : mark("adapterConfig", "cwd", v || undefined)
                      }
                      immediate
                      className="w-full bg-transparent font-mono text-sm outline-none placeholder:text-slate-400 dark:placeholder:text-[#627089]"
                      placeholder="/path/to/project"
                    />
                    <ChoosePathButton />
                  </div>
                </Field>
              )}
              {!isCreate && typeof config.bootstrapPromptTemplate === "string" && config.bootstrapPromptTemplate && (
                <>
                  <Field label="Bootstrap prompt (legacy)" hint={help.bootstrapPrompt}>
                    <MarkdownEditor
                      value={eff(
                        "adapterConfig",
                        "bootstrapPromptTemplate",
                        String(config.bootstrapPromptTemplate ?? ""),
                      )}
                      onChange={(v) =>
                        mark("adapterConfig", "bootstrapPromptTemplate", v || undefined)
                      }
                      placeholder="Optional initial setup prompt for the first run"
                      contentClassName="min-h-[44px] text-sm font-mono"
                      imageUploadHandler={async (file) => {
                        const namespace = `agents/${props.agent.id}/bootstrap-prompt`;
                        const asset = await uploadMarkdownImage.mutateAsync({ file, namespace });
                        return asset.contentPath;
                      }}
                    />
                  </Field>
                  <div className="rounded-[10px] border border-amber-600/25 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-[#f59e0b]/35 dark:bg-[#f59e0b]/10 dark:text-[#f59e0b]">
                    Bootstrap prompt is legacy and will be removed in a future release. Consider moving this content into the agent&apos;s prompt template or instructions file instead.
                  </div>
                </>
              )}
              {adapterType === "claude_local" && (
                <ClaudeLocalAdvancedFields {...adapterFieldProps} />
              )}
              {adapterType === "commandcode_local" && (
                <CommandCodeLocalAdvancedFields {...adapterFieldProps} />
              )}
              <Field label="Extra args (comma-separated)" hint={help.extraArgs}>
                <DraftInput
                  value={
                    isCreate
                      ? val!.extraArgs
                      : eff("adapterConfig", "extraArgs", formatArgList(config.extraArgs))
                  }
                  onCommit={(v) =>
                    isCreate
                      ? set!({ extraArgs: v })
                      : mark("adapterConfig", "extraArgs", v ? parseCommaArgs(v) : undefined)
                  }
                  immediate
                  className={tactileInputClass}
                  placeholder="e.g. --verbose, --foo=bar"
                />
              </Field>
              <Field label="Environment variables" hint={help.envVars}>
                <EnvVarEditor
                  value={
                    isCreate
                      ? ((val!.envBindings ?? EMPTY_ENV) as Record<string, EnvBinding>)
                      : ((eff("adapterConfig", "env", (config.env ?? EMPTY_ENV) as Record<string, EnvBinding>))
                      )
                  }
                  secrets={availableSecrets}
                  onCreateSecret={async (name, value) => {
                    const created = await createSecret.mutateAsync({ name, value });
                    return created;
                  }}
                  onChange={(env) =>
                    isCreate
                      ? set!({ envBindings: env ?? {}, envVars: "" })
                      : mark("adapterConfig", "env", env ?? {})
                  }
                />
              </Field>
              {/* Edit-only: timeout + grace period */}
              {!isCreate && (
                <>
                  <Field label="Timeout (sec)" hint={help.timeoutSec}>
                    <DraftNumberInput
                      value={eff(
                        "adapterConfig",
                        "timeoutSec",
                        Number(config.timeoutSec ?? 0),
                      )}
                      onCommit={(v) => mark("adapterConfig", "timeoutSec", v)}
                      immediate
                      className={tactileInputClass}
                    />
                  </Field>
                  <Field label="Interrupt grace period (sec)" hint={help.graceSec}>
                    <DraftNumberInput
                      value={eff(
                        "adapterConfig",
                        "graceSec",
                        Number(config.graceSec ?? 15),
                      )}
                      onCommit={(v) => mark("adapterConfig", "graceSec", v)}
                      immediate
                      className={tactileInputClass}
                    />
                  </Field>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* ---- [stage30-w5] Tab 3 (behavior): policy + Run Policy as children ---- */}
      {activeTab === "behavior" && (
        <div
          role="tabpanel"
          id="agent-tabpanel-behavior"
          aria-labelledby="agent-tab-behavior"
          tabIndex={0}
          className={cn(!cards && "px-4 py-3")}
        >
          <AgentBehaviorTab policy={currentBotPolicy} onChange={updateBotPolicy}>
      {/* ---- Run Policy ---- */}
      {isCreate && showCreateRunPolicySection ? (
        <div className={cn(!cards && "border-b border-slate-200/80 dark:border-white/[0.07]")}>
          {cards
            ? <h3 className="text-sm font-semibold uppercase tracking-[0.08em] text-slate-700 dark:text-[#eef2f8] flex items-center gap-2 mb-3"><Heart className="h-3 w-3" /> Run Policy</h3>
            : <div className="px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500 dark:text-[#8f9db3] flex items-center gap-2"><Heart className="h-3 w-3" /> Run Policy</div>
          }
          <div className={cn(cards ? "tactile-card rounded-[12px] border-slate-200/90 bg-white/95 p-4 space-y-3 dark:border-white/[0.08] dark:bg-none dark:bg-[#0e131d] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_10px_28px_-18px_rgba(0,0,0,0.85)]" : "px-4 pb-3 space-y-3")}>
            <ToggleWithNumber
              label="Heartbeat on interval"
              hint={help.heartbeatInterval}
              checked={val!.heartbeatEnabled}
              onCheckedChange={(v) => set!({ heartbeatEnabled: v })}
              number={val!.intervalSec}
              onNumberChange={(v) => set!({ intervalSec: v })}
              numberLabel="sec"
              numberPrefix="Run heartbeat every"
              numberHint={help.intervalSec}
              showNumber={val!.heartbeatEnabled}
            />
          </div>
        </div>
      ) : !isCreate ? (
        <div className={cn(!cards && "border-b border-slate-200/80 dark:border-white/[0.07]")}>
          {cards
            ? <h3 className="text-sm font-semibold uppercase tracking-[0.08em] text-slate-700 dark:text-[#eef2f8] flex items-center gap-2 mb-3"><Heart className="h-3 w-3" /> Run Policy</h3>
            : <div className="px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500 dark:text-[#8f9db3] flex items-center gap-2"><Heart className="h-3 w-3" /> Run Policy</div>
          }
          <div className={cn(cards ? "tactile-card overflow-hidden rounded-[12px] border-slate-200/90 bg-white/95 dark:border-white/[0.08] dark:bg-none dark:bg-[#0e131d] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_10px_28px_-18px_rgba(0,0,0,0.85)]" : "")}>
            <div className={cn(cards ? "p-4 space-y-3" : "px-4 pb-3 space-y-3")}>
              <ToggleWithNumber
                label="Heartbeat on interval"
                hint={help.heartbeatInterval}
                checked={
                  eff("heartbeat", "enabled", heartbeat.enabled !== false) &&
                  eff("heartbeat", "intervalSec", Number(heartbeat.intervalSec ?? 0)) > 0
                }
                onCheckedChange={(v) => {
                  mark("heartbeat", "enabled", v);
                  // Enabling interval heartbeat requires a positive interval — the
                  // server skips scheduling when intervalSec <= 0, so seed the
                  // default cadence when none is stored (prevents toggle snapback).
                  if (v && !(eff("heartbeat", "intervalSec", Number(heartbeat.intervalSec ?? 0)) > 0)) {
                    mark("heartbeat", "intervalSec", 300);
                  }
                }}
                number={eff("heartbeat", "intervalSec", Number(heartbeat.intervalSec ?? 300))}
                onNumberChange={(v) => mark("heartbeat", "intervalSec", v)}
                numberLabel="sec"
                numberPrefix="Run heartbeat every"
                numberHint={help.intervalSec}
                showNumber={
                  eff("heartbeat", "enabled", heartbeat.enabled !== false) &&
                  eff("heartbeat", "intervalSec", Number(heartbeat.intervalSec ?? 0)) > 0
                }
              />
            </div>
            <CollapsibleSection
              title="Advanced Run Policy"
              bordered={cards}
              open={runPolicyAdvancedOpen}
              onToggle={() => setRunPolicyAdvancedOpen(!runPolicyAdvancedOpen)}
            >
            <div className="space-y-3">
              <ToggleField
                label="Wake on demand"
                hint={help.wakeOnDemand}
                checked={eff(
                  "heartbeat",
                  "wakeOnDemand",
                  heartbeat.wakeOnDemand !== false,
                )}
                onChange={(v) => mark("heartbeat", "wakeOnDemand", v)}
              />
              <Field label="Cooldown (sec)" hint={help.cooldownSec}>
                <DraftNumberInput
                  value={eff(
                    "heartbeat",
                    "cooldownSec",
                    Number(heartbeat.cooldownSec ?? 10),
                  )}
                  onCommit={(v) => mark("heartbeat", "cooldownSec", v)}
                  immediate
                  className={tactileInputClass}
                />
              </Field>
              <Field label="Max concurrent runs" hint={help.maxConcurrentRuns}>
                <DraftNumberInput
                  value={eff(
                    "heartbeat",
                    "maxConcurrentRuns",
                    Number(heartbeat.maxConcurrentRuns ?? 1),
                  )}
                  onCommit={(v) => mark("heartbeat", "maxConcurrentRuns", v)}
                  immediate
                  className={tactileInputClass}
                />
              </Field>
              {/* [session rotation threshold] runtime-managed adapters only — claude/codex
                  manage context natively and the runtime never rotates their sessions. */}
              {adapterType !== "claude_local" && adapterType !== "codex_local" && (
                <Field
                  label="Session rotation limit (tokens)"
                  hint="Rotate to a fresh session when the last run's raw input reaches this many tokens. Unset uses the adapter default; 0 disables only the token threshold. Other run, age, and message limits still apply."
                >
                  <DraftNumberInput
                    value={sessionTokenThresholdFieldValue(adapterType, sessionCompaction)}
                    onEmpty={() => {
                      if (!("maxRawInputTokens" in sessionCompaction)) return;
                      mark(
                        "heartbeat",
                        "sessionCompaction",
                        updateSessionTokenThreshold(
                          sessionCompaction,
                          sessionTokenDefault,
                          sessionTokenDefault,
                        ),
                      );
                    }}
                    onCommit={(v) => mark(
                      "heartbeat",
                      "sessionCompaction",
                      updateSessionTokenThreshold(
                        sessionCompaction,
                        v,
                        sessionTokenDefault,
                      ),
                    )}
                    className={tactileInputClass}
                  />
                </Field>
              )}
              {(() => {
                // [agent fit observation] core가 주기적으로 자동 계산한 제안 (agent-model-fit 코어편입).
                //   읽기전용 — 실제 변경은 항상 사람이 위 필드/모델 설정에서 승인.
                const fit = (!isCreate && props.agent.metadata && typeof props.agent.metadata === "object"
                  ? (props.agent.metadata as Record<string, unknown>).fitProfile : null) as {
                  computedAt?: string; windowDays?: number; runs?: number;
                  thresholdVerdict?: { verdict?: string; reason?: string; suggestedTokens?: number | null };
                  modelVerdict?: { verdict?: string; reasons?: string[] };
                } | null;
                if (!fit?.computedAt) return null;
                const tv = fit.thresholdVerdict;
                const mv = fit.modelVerdict;
                const ageHours = Math.max(0, Math.round((Date.now() - new Date(fit.computedAt).getTime()) / 3_600_000));
                return (
                  <div className="rounded-[10px] border border-blue-600/20 bg-blue-50/80 p-3 text-xs space-y-1 tabular-nums dark:border-[#60a5fa]/30 dark:bg-[#60a5fa]/10">
                    <div className="font-medium text-slate-600 dark:text-[#8f9db3]">
                      Auto fit proposal (last {fit.windowDays ?? 14}d · {fit.runs ?? "?"} runs · {ageHours}h ago · proposals only, human approves changes)
                    </div>
                    {tv && (
                      <div>
                        <span className="font-medium">Session threshold:</span>{" "}
                        <span className={tv.verdict === "raise" ? "text-amber-700 dark:text-[#f59e0b]" : ""}>
                          {tv.verdict}
                        </span>
                        {tv.suggestedTokens ? ` → ${tv.suggestedTokens.toLocaleString("en-US")} tokens` : ""}
                        {tv.reason ? <span className="text-muted-foreground"> — {tv.reason}</span> : null}
                      </div>
                    )}
                    {mv && mv.verdict && (
                      <div>
                        <span className="font-medium">Model tier:</span> {mv.verdict}
                        {mv.reasons?.[0] ? <span className="text-muted-foreground"> — {mv.reasons[0]}</span> : null}
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          </CollapsibleSection>
          </div>
        </div>
      ) : null}
          </AgentBehaviorTab>
        </div>
      )}

    </div>
  );
}
