import { useMemo, useState } from "react";
import { ArrowLeftRight, ChevronDown, ChevronUp, Plus, Trash2, type LucideIcon } from "lucide-react";
import type { AdapterFallbackChainEntry } from "@paperclipai/adapter-utils/types";
import type { UsageLimitGateSnapshot } from "../api/instanceSettings";
import { Field, ToggleField } from "./agent-config-primitives";

export const MAX_FALLBACK_ENTRIES = 8;

const THINKING_OPTIONS = ["", "low", "medium", "high"];
const inputClass =
  "w-full rounded-md border border-slate-200/90 bg-white px-2.5 py-1.5 text-sm text-slate-900 outline-none transition-[border-color,box-shadow] placeholder:text-slate-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-white/[0.1] dark:bg-[#090c12] dark:text-[#eef2f8] dark:placeholder:text-[#627089] dark:focus:border-[#60a5fa]";
const rowButtonClass =
  "inline-flex h-6 w-6 items-center justify-center rounded-md border border-slate-200/90 bg-white text-slate-500 transition-colors hover:border-blue-500/40 hover:bg-slate-50 hover:text-blue-600 disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/[0.1] dark:bg-[#090c12] dark:text-[#8f9db3] dark:hover:border-[#60a5fa]/40 dark:hover:bg-[#141b29] dark:hover:text-[#60a5fa]";
const badgeClass =
  "rounded border border-slate-200/90 bg-slate-50 px-1.5 py-0.5 text-[10px] font-medium text-slate-600 dark:border-white/[0.1] dark:bg-white/[0.04] dark:text-[#8f9db3]";

type EntryDraft = Pick<AdapterFallbackChainEntry, "adapterType" | "provider" | "model">;
/** Identity input; extra fields like thinking are accepted and ignored for identity. */
type EntryIdentity = EntryDraft & Partial<Pick<AdapterFallbackChainEntry, "thinking" | "command">>;

const trim = (value: string | undefined): string => (typeof value === "string" ? value.trim() : "");
const strField = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

export function entryKey(entry: EntryDraft): string {
  return `${trim(entry.adapterType)}|${trim(entry.provider)}|${trim(entry.model)}`;
}

export function findDuplicateIndex(order: AdapterFallbackChainEntry[], entry: EntryIdentity, ignoreIndex?: number): number {
  const key = entryKey(entry);
  return order.findIndex((existing, index) => index !== ignoreIndex && entryKey(existing) === key);
}

export function addFallbackEntry(
  order: AdapterFallbackChainEntry[],
  entry: EntryDraft,
): { ok: true; order: AdapterFallbackChainEntry[] } | { ok: false; reason: "empty-model" | "duplicate" | "cap" } {
  if (trim(entry.model) === "") return { ok: false, reason: "empty-model" };
  if (findDuplicateIndex(order, entry) >= 0) return { ok: false, reason: "duplicate" };
  if (order.length >= MAX_FALLBACK_ENTRIES) return { ok: false, reason: "cap" };
  const next: AdapterFallbackChainEntry = { model: trim(entry.model) };
  if (trim(entry.adapterType) !== "") next.adapterType = trim(entry.adapterType);
  if (trim(entry.provider) !== "") next.provider = trim(entry.provider);
  return { ok: true, order: [...order, next] };
}

export function moveFallbackEntry(order: AdapterFallbackChainEntry[], index: number, delta: number): AdapterFallbackChainEntry[] {
  const target = index + delta;
  if (index < 0 || index >= order.length || target < 0 || target >= order.length) return [...order];
  const next = [...order];
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved);
  return next;
}

export function removeFallbackEntry(order: AdapterFallbackChainEntry[], index: number): AdapterFallbackChainEntry[] {
  return order.filter((_, i) => i !== index);
}

export function normalizeFallbackOrder(value: unknown): AdapterFallbackChainEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: AdapterFallbackChainEntry[] = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) continue;
    const record = raw as Record<string, unknown>;
    if (typeof record.model !== "string" || record.model.trim() === "") continue;
    entries.push({
      adapterType: strField(record.adapterType),
      command: strField(record.command),
      provider: strField(record.provider),
      model: record.model,
      thinking: strField(record.thinking),
    });
  }
  return entries;
}

export interface AgentFallbackChainEditorProps {
  primaryAdapterType: string;
  primaryModel: string;
  automatic: boolean;
  order: AdapterFallbackChainEntry[];
  legacyFallbackCommand: string;
  availableAdapters: ReadonlyArray<{ type: string; label: string }>;
  /** Models for the currently selected primary adapter (or fetched per adapter via optional hook/callback). */
  primaryModels: ReadonlyArray<{ id: string; label: string }>;
  /** Optional resolver for models of a chosen adapterType (falls back to free-text model input if empty). */
  getModelsForAdapter?: (adapterType: string) => ReadonlyArray<{ id: string; label: string }>;
  /** [stage28-w2] Live usage-limit gate snapshot; when present, each backup row shows a gate badge. */
  gateSnapshot?: UsageLimitGateSnapshot | null;
  onChangeAutomatic: (automatic: boolean) => void;
  onChangeOrder: (order: AdapterFallbackChainEntry[]) => void;
  onChangeLegacyCommand: (command: string) => void;
  disabled?: boolean;
}

export type BackupGateState = "ready" | "limit" | "cooldown";

const normalizePart = (value: string | null | undefined): string =>
  typeof value === "string" ? value.trim().toLowerCase() : "";

/**
 * [stage28-w2] 백업 엔트리가 현재 사용량 제한(쿼터) 또는 실패 쿨다운 홀드에 걸렸는지 판정.
 * 스냅샷의 null 필드는 와일드카드이고, 나머지 필드는 trim·대소문자 무시로 정확히 일치해야 한다.
 * adapterType 미지정 엔트리는 기본 어댑터(primaryAdapterType)로 실행되므로 이를 상속해 비교한다.
 */
export function resolveBackupEntryGateState(
  entry: EntryIdentity,
  primaryAdapterType: string,
  gateSnapshot?: UsageLimitGateSnapshot | null,
): BackupGateState {
  if (!gateSnapshot) return "ready";
  const adapter = normalizePart(entry.adapterType) || normalizePart(primaryAdapterType);
  const provider = normalizePart(entry.provider);
  const model = normalizePart(entry.model);
  const matches = (candidate: { adapterType: string | null; provider: string | null; model: string | null }): boolean =>
    (candidate.adapterType === null || normalizePart(candidate.adapterType) === adapter) &&
    (candidate.provider === null || normalizePart(candidate.provider) === provider) &&
    (candidate.model === null || normalizePart(candidate.model) === model);
  if (gateSnapshot.limitedModels.some(matches)) return "limit";
  if (gateSnapshot.failedModels.some(matches)) return "cooldown";
  return "ready";
}

const GATE_BADGE_LABEL: Record<BackupGateState, string> = { limit: "쿼터 제한", cooldown: "쿨다운", ready: "대기" };
const GATE_BADGE_CLASS: Record<BackupGateState, string> = {
  limit: "rounded border border-amber-500/40 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:border-amber-400/40 dark:bg-amber-400/10 dark:text-amber-300",
  cooldown: badgeClass,
  ready: badgeClass,
};

function GateBadge({ state }: { state: BackupGateState }) {
  return (
    <span data-gate-state={state} className={GATE_BADGE_CLASS[state]}>{GATE_BADGE_LABEL[state]}</span>
  );
}

function RowIconButton({ label, icon: Icon, onClick, disabled }: { label: string; icon: LucideIcon; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" aria-label={label} disabled={disabled} onClick={onClick} className={rowButtonClass}>
      <Icon className="h-3 w-3" />
    </button>
  );
}

export function AgentFallbackChainEditor(props: AgentFallbackChainEditorProps) {
  const { primaryAdapterType, primaryModel, automatic, order, legacyFallbackCommand, availableAdapters, getModelsForAdapter, gateSnapshot, onChangeAutomatic, onChangeOrder, onChangeLegacyCommand, disabled = false } = props;
  const [draftAdapterType, setDraftAdapterType] = useState(primaryAdapterType);
  const [draftProvider, setDraftProvider] = useState("");
  const [draftModel, setDraftModel] = useState("");
  const [draftThinking, setDraftThinking] = useState("");

  const candidateModels = useMemo(() => getModelsForAdapter?.(draftAdapterType) ?? [], [getModelsForAdapter, draftAdapterType]);
  const duplicateIndex = findDuplicateIndex(order, { adapterType: draftAdapterType, provider: draftProvider, model: draftModel });
  const atCap = order.length >= MAX_FALLBACK_ENTRIES;
  const duplicateNow = draftModel.trim() !== "" && duplicateIndex >= 0;
  const canAdd = !disabled && draftModel.trim() !== "" && !duplicateNow && !atCap;

  function handleAdd() {
    const result = addFallbackEntry(order, { adapterType: draftAdapterType, provider: draftProvider, model: draftModel });
    if (!result.ok) return;
    const added = result.order[result.order.length - 1];
    onChangeOrder([...order, draftThinking ? { ...added, thinking: draftThinking } : added]);
    setDraftProvider("");
    setDraftModel("");
    setDraftThinking("");
  }

  const hint = duplicateNow ? "Already in the chain." : atCap ? `Maximum ${MAX_FALLBACK_ENTRIES} backup entries.` : `Order is applied top-down (${order.length}/${MAX_FALLBACK_ENTRIES}).`;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <ArrowLeftRight className="h-3 w-3 text-slate-400 dark:text-[#627089]" />
        <span className="text-xs font-medium text-slate-700 dark:text-[#eef2f8]">Backup chain</span>
        <span className="text-[11px] text-slate-400 dark:text-[#627089]">primary: {primaryAdapterType} · {primaryModel || "—"}</span>
      </div>
      <ToggleField label="자동 폴백 전환 (Automatic failover)" checked={automatic} onChange={(v) => onChangeAutomatic(v)} />
      <p className="text-[11px] leading-snug text-slate-400 dark:text-[#627089]">쿼터 소진·과부하·오류 시 아래 순서대로 다음 프로바이더·모델로 자동 전환합니다</p>

      <div className="rounded-[10px] border border-slate-200/90 bg-white/60 p-2 dark:border-white/[0.08] dark:bg-white/[0.02]">
        {order.length === 0 && (
          <p className="px-1 py-2 text-xs text-slate-400 dark:text-[#627089]">No fallback entries yet — add a backup provider/model below.</p>
        )}
        {order.map((entry, index) => (
          <div key={`${entryKey(entry)}-${index}`} className="flex items-center gap-2 border-b border-slate-100 py-1.5 pl-1 last:border-b-0 dark:border-white/[0.06]">
            <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-100 text-[11px] font-semibold text-slate-600 tabular-nums dark:bg-white/[0.06] dark:text-[#8f9db3]">{index + 1}</span>
            <span className={badgeClass}>{availableAdapters.find((a) => a.type === entry.adapterType)?.label ?? entry.adapterType ?? "—"}</span>
            {entry.provider && (
              <span className="rounded border border-blue-600/20 bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 dark:border-[#60a5fa]/30 dark:bg-[#60a5fa]/10 dark:text-[#60a5fa]">{entry.provider}</span>
            )}
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-slate-800 dark:text-[#eef2f8]">{entry.model}</span>
            {entry.thinking && <span className={badgeClass}>{entry.thinking}</span>}
            {gateSnapshot && <GateBadge state={resolveBackupEntryGateState(entry, primaryAdapterType, gateSnapshot)} />}
            <span className="flex shrink-0 items-center gap-1">
              <RowIconButton label="Move up" icon={ChevronUp} disabled={disabled || index === 0} onClick={() => onChangeOrder(moveFallbackEntry(order, index, -1))} />
              <RowIconButton label="Move down" icon={ChevronDown} disabled={disabled || index === order.length - 1} onClick={() => onChangeOrder(moveFallbackEntry(order, index, 1))} />
              <RowIconButton label="Remove fallback entry" icon={Trash2} disabled={disabled} onClick={() => onChangeOrder(removeFallbackEntry(order, index))} />
            </span>
          </div>
        ))}
      </div>

      {!disabled && !atCap && (
        <div className="space-y-1.5 rounded-[10px] border border-slate-200/90 bg-white/60 p-2 dark:border-white/[0.08] dark:bg-white/[0.02]">
          <div className="grid grid-cols-2 gap-1.5">
            <select aria-label="Fallback adapter type" value={draftAdapterType} disabled={disabled} className={inputClass} onChange={(e) => setDraftAdapterType(e.target.value)}>
              {availableAdapters.map((adapter) => (
                <option key={adapter.type} value={adapter.type}>{adapter.label}</option>
              ))}
            </select>
            <input aria-label="Fallback provider (optional)" value={draftProvider} disabled={disabled} placeholder="provider (optional, e.g. openai)" className={inputClass} onChange={(e) => setDraftProvider(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            <div className="space-y-1">
              {candidateModels.length > 0 && (
                <select aria-label="Fallback model suggestions" value="" disabled={disabled} className={inputClass} onChange={(e) => e.target.value !== "" && setDraftModel(e.target.value)}>
                  <option value="">Choose a model…</option>
                  {candidateModels.map((model) => (
                    <option key={model.id} value={model.id}>{model.label}</option>
                  ))}
                </select>
              )}
              <input aria-label="Fallback model" value={draftModel} disabled={disabled} placeholder="model id (e.g. glm-5.3)" className={inputClass} onChange={(e) => setDraftModel(e.target.value)} />
            </div>
            <select aria-label="Fallback thinking effort" value={draftThinking} disabled={disabled} className={inputClass} onChange={(e) => setDraftThinking(e.target.value)}>
              {THINKING_OPTIONS.map((option) => (
                <option key={option} value={option}>{option === "" ? "Default" : option}</option>
              ))}
            </select>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-slate-400 dark:text-[#627089]">{hint}</span>
            <button
              type="button"
              disabled={!canAdd}
              onClick={handleAdd}
              className="inline-flex items-center gap-1 rounded-md border border-blue-600/20 bg-blue-600 px-2 py-1 text-xs font-medium text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40 dark:border-[#60a5fa]/45 dark:bg-[#2563eb] dark:text-[#f8fafc] dark:hover:bg-[#3b82f6]"
            >
              <Plus className="h-3 w-3" />
              Add backup
            </button>
          </div>
        </div>
      )}

      <details className="rounded-[10px] border border-slate-200/90 px-2 py-1.5 dark:border-white/[0.08]">
        <summary className="cursor-pointer text-[11px] text-slate-500 dark:text-[#8f9db3]">고급: 레거시 Fallback command</summary>
        <div className="pt-1.5">
          <Field label="Fallback command" hint="Alternate CLI command used for an automatic adapter fallback run after a lost local child process.">
            <input value={legacyFallbackCommand} disabled={disabled} placeholder="e.g. codex, claude" className={inputClass} onChange={(e) => onChangeLegacyCommand(e.target.value)} />
          </Field>
        </div>
      </details>
    </div>
  );
}
