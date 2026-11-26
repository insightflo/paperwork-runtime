import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Lock, Plus, RotateCcw, Save, ShieldCheck, Trash2 } from "lucide-react";
import type { BotCapabilityDataScope, EnterpriseBotCallableBy } from "../../api/enterprise-bots";

export interface BotCapabilityRule {
  capabilityKey: string;
  callableBy: EnterpriseBotCallableBy;
  dataScope: BotCapabilityDataScope;
  requiresApproval: boolean;
}

export interface CapabilityMatrixProps {
  capabilities: BotCapabilityRule[];
  canAdmin: boolean;
  saving?: boolean;
  onSave: (next: BotCapabilityRule[]) => Promise<void> | void;
  className?: string;
}

const CALLABLE_OPTIONS: EnterpriseBotCallableBy[] = ["self_only", "team", "company"];
const SCOPE_OPTIONS: BotCapabilityDataScope[] = ["self", "team", "company"];
const SELECT_CLASS =
  "h-7 rounded-md border border-slate-200/90 bg-white px-2 font-mono text-[11px] text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 disabled:cursor-not-allowed disabled:opacity-55 dark:border-white/[0.09] dark:bg-[#090d14] dark:text-[#edf2fb] dark:focus:border-[#60a5fa]";
const APPROVAL_ON =
  "border-amber-500/40 bg-amber-500/15 text-amber-800 dark:border-[#f59e0b]/40 dark:bg-[#f59e0b]/15 dark:text-[#fcd34d]";
const APPROVAL_OFF =
  "border-slate-200/90 bg-slate-100/80 text-slate-600 dark:border-white/[0.08] dark:bg-[#090d14] dark:text-[#8b97ad]";

export function countCapabilityDiffs(baseline: BotCapabilityRule[], draft: BotCapabilityRule[]): number {
  const baseMap = new Map(baseline.map((r) => [r.capabilityKey, r]));
  const draftMap = new Map(draft.map((r) => [r.capabilityKey, r]));
  let changes = 0;
  for (const [key, row] of draftMap) {
    const prev = baseMap.get(key);
    if (!prev || prev.callableBy !== row.callableBy || prev.dataScope !== row.dataScope || prev.requiresApproval !== row.requiresApproval) {
      changes += 1;
    }
  }
  for (const key of baseMap.keys()) {
    if (!draftMap.has(key)) changes += 1;
  }
  return changes;
}

export function CapabilityMatrix({
  capabilities,
  canAdmin,
  saving = false,
  onSave,
  className = "",
}: CapabilityMatrixProps) {
  const [draft, setDraft] = useState<BotCapabilityRule[]>(capabilities);
  const [newKey, setNewKey] = useState("");
  const [newCallableBy, setNewCallableBy] = useState<EnterpriseBotCallableBy>("team");
  const [newDataScope, setNewDataScope] = useState<BotCapabilityDataScope>("team");
  const [newRequiresApproval, setNewRequiresApproval] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(capabilities);
    setAddError(null);
  }, [capabilities]);

  const dirtyCount = useMemo(() => countCapabilityDiffs(capabilities, draft), [capabilities, draft]);
  const isDirty = dirtyCount > 0;
  const readOnly = !canAdmin || saving;

  const updateRow = (key: string, patch: Partial<BotCapabilityRule>) =>
    setDraft((prev) => prev.map((row) => (row.capabilityKey === key ? { ...row, ...patch } : row)));
  const removeRow = (key: string) =>
    setDraft((prev) => prev.filter((row) => row.capabilityKey !== key));

  const handleAdd = (e: FormEvent) => {
    e.preventDefault();
    if (readOnly) return;
    const trimmed = newKey.trim();
    if (!trimmed) {
      setAddError("Enter a capability key.");
      return;
    }
    if (draft.some((r) => r.capabilityKey === trimmed)) {
      setAddError(`"${trimmed}" already exists.`);
      return;
    }
    setDraft((prev) => [
      ...prev,
      { capabilityKey: trimmed, callableBy: newCallableBy, dataScope: newDataScope, requiresApproval: newRequiresApproval },
    ]);
    setNewKey("");
    setNewRequiresApproval(false);
    setAddError(null);
  };

  return (
    <div
      data-capability-matrix
      className={`tactile-card space-y-3 rounded-xl border border-slate-200/90 bg-white p-3 text-xs tabular-nums dark:border-white/[0.08] dark:bg-none dark:bg-[#0e131d] ${className}`.trim()}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <ShieldCheck className="h-3.5 w-3.5 text-blue-600 dark:text-[#60a5fa]" aria-hidden />
          <h3 className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-[#8b97ad]">
            Capability Matrix ({draft.length})
          </h3>
          {isDirty && (
            <span
              data-dirty-badge
              className="rounded-full border px-2 py-0.5 font-mono text-[10.5px] font-medium"
              style={{
                borderColor: "var(--openbot-warning)",
                backgroundColor: "var(--openbot-warning-soft)",
                color: "var(--openbot-warning-text)",
              }}
            >
              {dirtyCount} unsaved {dirtyCount === 1 ? "change" : "changes"}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          {!canAdmin && (
            <span data-readonly-hint className="inline-flex items-center gap-1 text-[11px] text-slate-500 dark:text-[#8b97ad]">
              <Lock className="h-3 w-3" aria-hidden />
              Admin only
            </span>
          )}
          {isDirty && canAdmin && (
            <button
              type="button"
              disabled={saving}
              onClick={() => {
                setDraft(capabilities);
                setAddError(null);
              }}
              className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-lg border border-slate-200/90 bg-white px-2 text-[11px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-white/[0.1] dark:bg-[#090d14] dark:text-[#cbd5e1]"
            >
              <RotateCcw className="h-3 w-3" aria-hidden />
              Reset
            </button>
          )}
          <button
            type="button"
            data-save-matrix
            disabled={!canAdmin || !isDirty || saving}
            onClick={() => void onSave(draft)}
            className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-lg bg-blue-600 px-2.5 text-[11px] font-semibold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-[#2563eb] dark:hover:bg-[#3b82f6]"
          >
            <Save className="h-3 w-3" aria-hidden />
            {saving ? "Saving..." : "Save Matrix"}
          </button>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left text-[11px]">
          <thead>
            <tr className="border-b border-slate-200/80 text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-500 dark:border-white/[0.06] dark:text-[#8b97ad]">
              <th className="py-1.5 pr-2">Capability</th>
              <th className="py-1.5 pr-2">Callable By</th>
              <th className="py-1.5 pr-2">Data Scope</th>
              <th className="py-1.5 pr-2 text-center">Approval</th>
              <th className="w-7 py-1.5 text-right"><span className="sr-only">Remove</span></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200/60 dark:divide-white/[0.05]">
            {draft.length === 0 ? (
              <tr>
                <td colSpan={5} className="py-3 text-center text-slate-500 dark:text-[#8b97ad]">
                  No capabilities configured yet.
                </td>
              </tr>
            ) : (
              draft.map((row) => (
                <tr key={row.capabilityKey} data-capability-row={row.capabilityKey}>
                  <td className="py-1.5 pr-2 font-mono font-medium text-slate-900 dark:text-[#edf2fb]">{row.capabilityKey}</td>
                  <td className="py-1.5 pr-2">
                    <select
                      aria-label={`Callable by for ${row.capabilityKey}`}
                      disabled={readOnly}
                      value={row.callableBy}
                      onChange={(e) => updateRow(row.capabilityKey, { callableBy: e.target.value as EnterpriseBotCallableBy })}
                      className={SELECT_CLASS}
                    >
                      {CALLABLE_OPTIONS.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
                    </select>
                  </td>
                  <td className="py-1.5 pr-2">
                    <select
                      aria-label={`Data scope for ${row.capabilityKey}`}
                      disabled={readOnly}
                      value={row.dataScope}
                      onChange={(e) => updateRow(row.capabilityKey, { dataScope: e.target.value as BotCapabilityDataScope })}
                      className={SELECT_CLASS}
                    >
                      {SCOPE_OPTIONS.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
                    </select>
                  </td>
                  <td className="py-1.5 pr-2 text-center">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={row.requiresApproval}
                      aria-label={`Requires approval for ${row.capabilityKey}`}
                      disabled={readOnly}
                      onClick={() => updateRow(row.capabilityKey, { requiresApproval: !row.requiresApproval })}
                      className={`inline-flex h-6 min-w-[3.2rem] cursor-pointer items-center justify-center rounded-full border px-2 font-mono text-[10.5px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-55 ${row.requiresApproval ? APPROVAL_ON : APPROVAL_OFF}`}
                    >
                      {row.requiresApproval ? "req" : "auto"}
                    </button>
                  </td>
                  <td className="py-1.5 text-right">
                    <button
                      type="button"
                      aria-label={`Remove ${row.capabilityKey}`}
                      disabled={readOnly}
                      onClick={() => removeRow(row.capabilityKey)}
                      className="inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-rose-500/10 hover:text-rose-600 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:text-rose-300"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <form onSubmit={handleAdd} className="flex flex-wrap items-center gap-1.5 border-t border-slate-200/70 pt-2.5 dark:border-white/[0.06]">
        <input
          value={newKey}
          onChange={(e) => { setNewKey(e.target.value); if (addError) setAddError(null); }}
          disabled={readOnly}
          placeholder="Add capability (e.g. docs.search)"
          aria-label="New capability key"
          className="h-7 min-w-[140px] flex-1 rounded-md border border-slate-200/90 bg-slate-50/70 px-2 font-mono text-[11px] text-slate-900 outline-none placeholder:text-slate-400 focus:border-blue-500 focus:bg-white disabled:cursor-not-allowed disabled:opacity-55 dark:border-white/[0.09] dark:bg-[#090d14] dark:text-[#edf2fb] dark:placeholder:text-[#8b97ad]"
        />
        <select
          aria-label="New capability callable by"
          disabled={readOnly}
          value={newCallableBy}
          onChange={(e) => setNewCallableBy(e.target.value as EnterpriseBotCallableBy)}
          className={SELECT_CLASS}
        >
          {CALLABLE_OPTIONS.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
        </select>
        <select
          aria-label="New capability data scope"
          disabled={readOnly}
          value={newDataScope}
          onChange={(e) => setNewDataScope(e.target.value as BotCapabilityDataScope)}
          className={SELECT_CLASS}
        >
          {SCOPE_OPTIONS.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
        </select>
        <button
          type="button"
          role="switch"
          aria-checked={newRequiresApproval}
          aria-label="New capability requires approval"
          disabled={readOnly}
          onClick={() => setNewRequiresApproval((v) => !v)}
          className={`inline-flex h-7 cursor-pointer items-center rounded-md border px-2 font-mono text-[10.5px] font-medium disabled:cursor-not-allowed disabled:opacity-55 ${newRequiresApproval ? APPROVAL_ON : APPROVAL_OFF}`}
        >
          {newRequiresApproval ? "req" : "auto"}
        </button>
        <button
          type="submit"
          disabled={readOnly || !newKey.trim()}
          className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-md border border-slate-200/90 bg-white px-2 text-[11px] font-medium text-slate-800 hover:border-blue-500/40 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/[0.1] dark:bg-[#090d14] dark:text-[#edf2fb]"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden />
          Add
        </button>
      </form>

      {addError && <p role="alert" className="text-[11px] text-rose-600 dark:text-rose-300">{addError}</p>}
    </div>
  );
}
