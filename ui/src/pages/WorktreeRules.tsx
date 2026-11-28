import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  worktreeApi,
  type WorktreeRule,
  type RuleSeverity,
  type RuleAction,
  type CreateRuleInput,
  type UpdateRuleInput,
  type Predicate,
} from "../api/worktree";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ShieldCheck,
  Plus,
  Trash2,
  ChevronDown,
  ChevronRight,
  ToggleLeft,
  ToggleRight,
  Code2,
  FormInput,
} from "lucide-react";
import { cn } from "../lib/utils";
import { HermitGateAndOpsPanel } from "../components/HermitGateAndOpsPanel";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SEVERITIES: RuleSeverity[] = ["MUST", "SHOULD", "MAY"];

// Combo 1 tactile cockpit signals: lime/cobalt/amber telemetry on legible light and obsidian dark surfaces.
const SEVERITY_COLORS: Record<RuleSeverity, string> = {
  MUST: "bg-rose-500/10 text-rose-700 dark:bg-[#fb7185]/15 dark:text-[#fb7185]",
  SHOULD: "bg-amber-500/10 text-amber-700 dark:bg-[#f59e0b]/15 dark:text-[#f59e0b]",
  MAY: "bg-blue-500/10 text-blue-700 dark:bg-[#60a5fa]/15 dark:text-[#60a5fa]",
};

const SEVERITY_DOTS: Record<RuleSeverity, string> = { MUST: "bg-rose-500 dark:bg-[#fb7185]", SHOULD: "bg-amber-500 dark:bg-[#f59e0b]", MAY: "bg-blue-600 dark:bg-[#60a5fa]" };

const RULE_ACTIONS: RuleAction[] = [
  "tool_call",
  "file_read",
  "file_write",
  "file_delete",
  "network_request",
  "command_execution",
  "state_query",
];

// Predicate operators available in the form builder
const PREDICATE_OPERATORS = ["$eq", "$ne", "$contains", "$startsWith", "$endsWith", "$in", "$notIn", "$matches", "$gt", "$lt"] as const;
type PredicateOperator = typeof PREDICATE_OPERATORS[number];

// ---------------------------------------------------------------------------
// Types for the form builder
// ---------------------------------------------------------------------------

interface PredicateClause {
  field: string;
  operator: PredicateOperator;
  value: string;
}

function clausesToPredicate(clauses: PredicateClause[]): Predicate {
  const result: Predicate = {};
  for (const clause of clauses) {
    if (!clause.field.trim()) continue;
    const isArrayOp = clause.operator === "$in" || clause.operator === "$notIn";
    const val = isArrayOp
      ? clause.value.split(",").map((v) => v.trim()).filter(Boolean)
      : clause.value;
    result[clause.field.trim()] = { [clause.operator]: val };
  }
  return result;
}

function predicateToClauses(pred: Predicate): PredicateClause[] {
  const clauses: PredicateClause[] = [];
  for (const [field, val] of Object.entries(pred)) {
    if (typeof val === "object" && val !== null && !Array.isArray(val)) {
      const ops = Object.keys(val as object) as PredicateOperator[];
      for (const op of ops) {
        if (PREDICATE_OPERATORS.includes(op)) {
          const raw = (val as Record<string, unknown>)[op];
          clauses.push({
            field,
            operator: op,
            value: Array.isArray(raw) ? raw.join(", ") : String(raw ?? ""),
          });
        }
      }
    }
  }
  return clauses.length > 0 ? clauses : [{ field: "", operator: "$eq", value: "" }];
}

// ---------------------------------------------------------------------------
// SeverityBadge
// ---------------------------------------------------------------------------

function SeverityBadge({ severity }: { severity: RuleSeverity }) {
  return (
    <span className={cn("text-xs px-1.5 py-0.5 rounded font-mono font-medium", SEVERITY_COLORS[severity])}>
      {severity}
    </span>
  );
}

// ---------------------------------------------------------------------------
// PredicateFormBuilder
// ---------------------------------------------------------------------------

interface PredicateFormBuilderProps {
  clauses: PredicateClause[];
  onChange: (clauses: PredicateClause[]) => void;
  canAdmin: boolean;
}

function PredicateFormBuilder({ clauses, onChange, canAdmin }: PredicateFormBuilderProps) {
  function update(i: number, partial: Partial<PredicateClause>) {
    onChange(clauses.map((c, idx) => (idx === i ? { ...c, ...partial } : c)));
  }

  function addClause() {
    onChange([...clauses, { field: "", operator: "$eq", value: "" }]);
  }

  function removeClause(i: number) {
    const next = clauses.filter((_, idx) => idx !== i);
    onChange(next.length > 0 ? next : [{ field: "", operator: "$eq", value: "" }]);
  }

  return (
    <div className="space-y-2">
      {clauses.map((clause, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input
            className="h-7 text-xs w-32 shrink-0"
            aria-label={`Condition ${i + 1} field`} placeholder="field"
            value={clause.field}
            disabled={!canAdmin}
            onChange={(e) => update(i, { field: e.target.value })}
          />
          <Select value={clause.operator} onValueChange={(v) => update(i, { operator: v as PredicateOperator })}>
            <SelectTrigger aria-label={`Condition ${i + 1} operator`} className="h-7 text-xs w-32 shrink-0" disabled={!canAdmin}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PREDICATE_OPERATORS.map((op) => (
                <SelectItem key={op} value={op}>{op}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            className="h-7 text-xs flex-1"
            placeholder={
              clause.operator === "$in" || clause.operator === "$notIn"
                ? "val1, val2, ..."
                : "value"
            }
            aria-label={`Condition ${i + 1} value`} value={clause.value}
            disabled={!canAdmin}
            onChange={(e) => update(i, { value: e.target.value })}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="shrink-0 text-muted-foreground hover:text-destructive"
            aria-label={`Remove condition ${i + 1}`} onClick={() => removeClause(i)}
            disabled={!canAdmin}
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-6 text-xs text-muted-foreground"
        onClick={addClause}
        disabled={!canAdmin}
      >
        <Plus className="h-3 w-3 mr-1" />
        Add condition
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// RuleForm — shared between create and edit
// ---------------------------------------------------------------------------

interface RuleFormValues {
  name: string;
  severity: RuleSeverity;
  action: string;
  message: string;
  enabled: boolean;
  // builder mode
  clauses: PredicateClause[];
  // raw JSON mode
  predicateJson: string;
  useRawJson: boolean;
}

function defaultFormValues(rule?: WorktreeRule): RuleFormValues {
  if (rule) {
    return {
      name: rule.name,
      severity: rule.severity as RuleSeverity,
      action: rule.action,
      message: rule.message,
      enabled: rule.enabled,
      clauses: predicateToClauses(rule.predicate),
      predicateJson: JSON.stringify(rule.predicate, null, 2),
      useRawJson: false,
    };
  }
  return {
    name: "",
    severity: "SHOULD",
    action: "tool_call",
    message: "",
    enabled: true,
    clauses: [{ field: "", operator: "$eq", value: "" }],
    predicateJson: "{}",
    useRawJson: false,
  };
}

interface RuleFormProps { initial?: WorktreeRule; canAdmin: boolean; onSubmit: (input: CreateRuleInput) => void; onCancel: () => void; isPending: boolean; error: string | null }

function RuleForm({ initial, canAdmin, onSubmit, onCancel, isPending, error }: RuleFormProps) {
  const [values, setValues] = useState<RuleFormValues>(() => defaultFormValues(initial));
  const [jsonError, setJsonError] = useState<string | null>(null);

  function set<K extends keyof RuleFormValues>(key: K, val: RuleFormValues[K]) {
    setValues((v) => ({ ...v, [key]: val }));
  }

  function toggleMode() {
    if (!values.useRawJson) {
      // switching to raw — serialize current clauses
      const pred = clausesToPredicate(values.clauses);
      set("predicateJson", JSON.stringify(pred, null, 2));
    } else {
      // switching to builder — try to parse current JSON
      try {
        const pred = JSON.parse(values.predicateJson) as Predicate;
        set("clauses", predicateToClauses(pred));
        setJsonError(null);
      } catch {
        setJsonError("Invalid JSON — fix before switching to form mode");
        return;
      }
    }
    set("useRawJson", !values.useRawJson);
  }

  function buildPredicate(): Predicate | null {
    if (values.useRawJson) {
      try {
        return JSON.parse(values.predicateJson) as Predicate;
      } catch {
        setJsonError("Invalid JSON predicate");
        return null;
      }
    }
    return clausesToPredicate(values.clauses);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canAdmin) return;
    setJsonError(null);
    const predicate = buildPredicate();
    if (predicate === null) return;
    if (!values.name.trim()) return;
    if (!values.action) return;

    onSubmit({
      name: values.name.trim(),
      severity: values.severity,
      action: values.action,
      predicate,
      message: values.message.trim(),
      enabled: values.enabled,
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 tactile-card p-4 dark:bg-none dark:border-white/[0.08] dark:bg-[#0e131d]">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-[#8b97ad]">{initial ? "Edit Rule" : "New Rule"}</p>
        <div className="flex shrink-0 gap-2">
          <Button type="submit" aria-live="polite" size="sm" variant="outline" className="h-7 rounded-lg bg-blue-600 px-2.5 text-xs font-semibold text-white hover:bg-blue-500 dark:bg-[#2563eb] dark:text-[#f8fafc] dark:hover:bg-[#3b82f6]" disabled={isPending || !canAdmin} title={!canAdmin ? "Admin role required to save rules" : undefined}>
            {isPending ? "Saving..." : initial ? "Save" : "Create"}
          </Button>
          <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
      {/* Name */}
      <div className="space-y-1.5">
        <label className="text-xs text-slate-500 dark:text-[#8b97ad]">Name</label>
        <Input
          className="h-8 text-sm"
          aria-label="Name" value={values.name}
          disabled={!canAdmin}
          onChange={(e) => set("name", e.target.value)}
          placeholder="e.g. Block file writes outside workspace"
          required
        />
      </div>
      {/* Severity + Action row */}
      <div className="flex gap-3">
        <div className="space-y-1.5 w-32 shrink-0">
          <label className="text-xs text-slate-500 dark:text-[#8b97ad]">Severity</label>
          <Select value={values.severity} onValueChange={(v) => set("severity", v as RuleSeverity)}>
            <SelectTrigger aria-label="Severity" className="h-8 text-sm" disabled={!canAdmin}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SEVERITIES.map((s) => (
                <SelectItem key={s} value={s}>{s}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5 flex-1">
          <label className="text-xs text-slate-500 dark:text-[#8b97ad]">Action</label>
          <Select value={values.action} onValueChange={(v) => set("action", v)}>
            <SelectTrigger aria-label="Action" className="h-8 text-sm" disabled={!canAdmin}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RULE_ACTIONS.map((a) => (
                <SelectItem key={a} value={a}>{a}</SelectItem>
              ))}
              <SelectItem value="__custom__">custom…</SelectItem>
            </SelectContent>
          </Select>
          {values.action === "__custom__" && (
            <Input aria-label="Custom action name" className="h-8 text-sm mt-1" placeholder="custom action name" disabled={!canAdmin} onChange={(e) => set("action", e.target.value)} />
          )}
        </div>
      </div>
      {/* Message */}
      <div className="space-y-1.5">
        <label className="text-xs text-slate-500 dark:text-[#8b97ad]">Violation message</label>
        <Input
          className="h-8 text-sm"
          aria-label="Violation message" value={values.message}
          disabled={!canAdmin}
          onChange={(e) => set("message", e.target.value)}
          placeholder="e.g. File writes outside workspace are not allowed"
        />
      </div>
      {/* Predicate section */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-xs text-slate-500 dark:text-[#8b97ad]">Predicate</label>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 text-xs gap-1.5"
            onClick={toggleMode}
            disabled={!canAdmin}
          >
            {values.useRawJson
              ? <><FormInput className="h-3 w-3" /> Form</>
              : <><Code2 className="h-3 w-3" /> JSON</>}
          </Button>
        </div>
        {values.useRawJson ? (
          <textarea
            className={cn("h-32 w-full resize-y rounded-md border bg-white px-3 py-2 font-mono text-xs text-slate-900 whitespace-pre-wrap focus:outline-none focus:ring-1 focus:ring-blue-500 dark:bg-[#090c12] dark:text-[#eef2f8] dark:focus:ring-[#60a5fa]", jsonError ? "border-destructive" : "border-slate-200/90 dark:border-white/[0.1]")}
            aria-label="Predicate JSON" value={values.predicateJson}
            onChange={(e) => { set("predicateJson", e.target.value); setJsonError(null); }}
            disabled={!canAdmin}
            spellCheck={false}
          />
        ) : (
          <PredicateFormBuilder clauses={values.clauses} canAdmin={canAdmin} onChange={(c) => set("clauses", c)} />
        )}
        {jsonError && <p role="alert" className="text-xs text-destructive">{jsonError}</p>}
        <p className="text-xs text-slate-500 dark:text-[#8b97ad]">
          Operators: $eq $ne $contains $startsWith $endsWith $in $notIn $matches $gt $lt
        </p>
      </div>
      {/* Enabled */}
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className={cn(values.enabled ? "text-lime-700 dark:text-[#a3e635]" : "text-slate-500 dark:text-[#8b97ad]")}
          onClick={() => { if (!canAdmin) return; set("enabled", !values.enabled); }}
          disabled={!canAdmin}
          aria-label="Rule enabled" aria-pressed={values.enabled} title={values.enabled ? "Enabled — click to disable" : "Disabled — click to enable"}
        >
          {values.enabled
            ? <ToggleRight className="h-4 w-4" />
            : <ToggleLeft className="h-4 w-4" />}
        </Button>
        <span className="text-xs text-slate-500 dark:text-[#8b97ad]">{values.enabled ? "Enabled" : "Disabled"}</span>
      </div>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </form>
  );
}

// ---------------------------------------------------------------------------
// RuleRow
// ---------------------------------------------------------------------------

interface RuleRowProps { rule: WorktreeRule; companyId: string; canAdmin: boolean }

/** Fixed column tracks: name (flexes, truncates) | severity | action | controls (never wraps). */
const RULE_ROW_TRACKS =
  "grid grid-cols-[minmax(0,1fr)_max-content_max-content] items-center gap-3 px-3 sm:grid-cols-[minmax(0,1fr)_4rem_10rem_max-content]";

function RuleRow({ rule, companyId, canAdmin }: RuleRowProps) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [mutError, setMutError] = useState<string | null>(null);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: queryKeys.worktree.rules(companyId) });

  const toggleMutation = useMutation({
    mutationFn: (enabled: boolean) => worktreeApi.updateRule(rule.id, { enabled }),
    onSuccess: invalidate,
  });

  const deleteMutation = useMutation({ mutationFn: () => worktreeApi.deleteRule(rule.id), onSuccess: invalidate });

  const updateMutation = useMutation({
    mutationFn: (data: UpdateRuleInput) => worktreeApi.updateRule(rule.id, data),
    onSuccess: () => { invalidate(); setEditing(false); setMutError(null); },
    onError: (err) => setMutError(err instanceof Error ? err.message : "Failed to update"),
  });

  if (editing) {
    return (
      <div className="border-b border-slate-200/90 dark:border-white/[0.08] p-3 last:border-b-0">
        <RuleForm
          initial={rule}
          canAdmin={canAdmin}
          onSubmit={(input) => { if (!canAdmin) return; updateMutation.mutate(input); }}
          onCancel={() => { setEditing(false); setMutError(null); }}
          isPending={updateMutation.isPending}
          error={mutError}
        />
      </div>
    );
  }

  return (
    <div className={cn("border-b border-slate-200/90 dark:border-white/[0.08] transition-colors last:border-b-0 hover:bg-slate-50 dark:hover:bg-[#141b29]", !rule.enabled && "opacity-60")}>
      {/* Row header */}
      <div className={cn(RULE_ROW_TRACKS, "h-10 text-sm")}>
        <span className="flex min-w-0 items-center gap-3">
          <button
            className="shrink-0 p-0.5 text-slate-500 dark:text-[#8b97ad] hover:text-slate-900 dark:hover:text-[#eef2f8]"
            onClick={() => setExpanded((v) => !v)}
            type="button" aria-expanded={expanded} aria-label={expanded ? "Collapse rule" : "Expand rule"}
          >
            {expanded
              ? <ChevronDown className="h-3.5 w-3.5" />
              : <ChevronRight className="h-3.5 w-3.5" />}
          </button>
          <ShieldCheck className="h-4 w-4 shrink-0 text-slate-500 dark:text-[#8b97ad]" />
          <span className="min-w-0 flex-1 truncate font-medium text-slate-950 dark:text-[#eef2f8]">{rule.name}</span>
        </span>
        <SeverityBadge severity={rule.severity as RuleSeverity} />
        <span className="hidden min-w-0 truncate font-mono text-xs text-slate-500 dark:text-[#8b97ad] sm:block">{rule.action}</span>
        {/* Toggle enabled · Edit · Delete */}
        <span className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            className={cn("shrink-0", rule.enabled ? "text-lime-700 dark:text-[#a3e635]" : "text-slate-500 dark:text-[#8b97ad]")}
            onClick={() => { if (!canAdmin) return; toggleMutation.mutate(!rule.enabled); }}
            disabled={toggleMutation.isPending || !canAdmin}
            title={!canAdmin ? "Admin role required to change rules" : rule.enabled ? "Disable" : "Enable"}
            type="button" aria-label={rule.enabled ? "Disable rule" : "Enable rule"}
          >
            {rule.enabled
              ? <ToggleRight className="h-4 w-4" />
              : <ToggleLeft className="h-4 w-4" />}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-xs text-slate-500 dark:text-[#8b97ad] hover:text-slate-900 dark:hover:text-[#eef2f8]"
            type="button" onClick={() => { if (!canAdmin) return; setEditing(true); }}
            disabled={!canAdmin}
            title={!canAdmin ? "Admin role required to edit rules" : undefined}
          >
            Edit
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="shrink-0 text-slate-500 dark:text-[#8b97ad] hover:text-destructive"
            onClick={() => { if (!canAdmin) return; deleteMutation.mutate(); }}
            disabled={deleteMutation.isPending || !canAdmin}
            title={!canAdmin ? "Admin role required to delete rules" : undefined}
            type="button" aria-label="Delete rule"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </span>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="space-y-2 px-10 pb-3 text-xs text-slate-500 dark:text-[#8b97ad]">
          {rule.message && (
            <p><span className="font-medium text-slate-950 dark:text-[#eef2f8]">Message:</span> {rule.message}</p>
          )}
          <div>
            <p className="mb-1 font-medium text-slate-950 dark:text-[#eef2f8]">Predicate:</p>
            <pre className="overflow-x-auto rounded-md border border-slate-200/90 bg-white text-slate-900 dark:border-white/[0.1] dark:bg-[#090c12] dark:text-[#eef2f8] p-2 font-mono text-xs whitespace-pre-wrap break-all">
              {JSON.stringify(rule.predicate, null, 2)}
            </pre>
          </div>
          <p>
            <span className="font-medium text-slate-950 dark:text-[#eef2f8]">Version:</span> {rule.version}
            {" · "}
            <span className="font-medium text-slate-950 dark:text-[#eef2f8]">Created by:</span> {rule.createdBy}
          </p>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// WorktreeRules page
// ---------------------------------------------------------------------------

type MainTab = "rules" | "ops";
type SeverityFilter = RuleSeverity | "all";

const MAIN_TABS: { id: MainTab; label: string }[] = [
  { id: "rules", label: "승인 가드레일 (Approval Gates)" }, { id: "ops", label: "Hermit Gate & 리소스 콘솔" },
];

// Combo 1 segmented-control primitives.
const SEGMENT = "flex shrink-0 items-center gap-0.5 rounded-lg border border-slate-200/90 bg-slate-100/80 p-0.5 dark:border-white/[0.08] dark:bg-[#090c12]";
const SEGMENT_ACTIVE = "bg-white text-slate-950 shadow-sm dark:bg-[#151d2b] dark:text-[#eef2f8] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]";
const SEGMENT_IDLE = "text-slate-600 hover:text-slate-950 dark:text-[#8b97ad] dark:hover:text-[#eef2f8]";

/** One toolbar segment: 24px tall, never wraps. */
function Segment({ pressed, onClick, children }: { pressed: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn("h-6 cursor-pointer rounded px-2 text-xs whitespace-nowrap transition-colors", pressed ? SEGMENT_ACTIVE : SEGMENT_IDLE)}
    >
      {children}
    </button>
  );
}

export function WorktreeRules() {
  const { selectedCompanyId, canAdmin = true, currentRole } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>("all");
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [mainTab, setMainTab] = useState<MainTab>("rules");

  useEffect(() => {
    setBreadcrumbs([{ label: "Approval Gates" }]);
  }, [setBreadcrumbs]);

  // Listed unfiltered so strip counts stay complete; severity tabs filter client-side on the cached data.
  const { data: rules, isLoading, error } = useQuery({
    queryKey: queryKeys.worktree.rules(selectedCompanyId!),
    queryFn: () => worktreeApi.listRules(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const createMutation = useMutation({
    mutationFn: (data: CreateRuleInput) => worktreeApi.createRule(selectedCompanyId!, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.worktree.rules(selectedCompanyId!) });
      setShowCreateForm(false);
      setCreateError(null);
    },
    onError: (err) => setCreateError(err instanceof Error ? err.message : "Failed to create rule"),
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={ShieldCheck} message="Select a company to manage approval gates." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  const all = rules ?? [];
  const filtered = severityFilter === "all" ? all : all.filter((r) => r.severity === severityFilter);
  const countBySeverity = (s: RuleSeverity) => all.filter((r) => r.severity === s).length;
  const enabledCount = all.filter((r) => r.enabled).length;

  const selectSeverity = (next: SeverityFilter) => {
    setSeverityFilter((current) => (current === next ? "all" : next));
    setMainTab("rules");
  };

  return (
    <div className="space-y-2 tabular-nums">
      {error && <p role="alert" className="text-sm text-destructive">{error instanceof Error ? error.message : String(error)}</p>}

      {/* 1-row cockpit strip: rule counts double as severity-filter shortcuts */}
      <div className="cockpit-strip h-10 w-full gap-0 overflow-hidden rounded-xl border-slate-200/90 bg-white shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] dark:border-white/[0.08] dark:bg-[#0e131d] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_4px_20px_-8px_rgba(0,0,0,0.65)]" role="group" aria-label="Approval gates by severity">
        <span className="cockpit-cell shrink-0">
          <ShieldCheck className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="uppercase tracking-wide">Approval Gates</span>
        </span>
        <span className="cockpit-cell min-w-0 flex-1 justify-center" title="All rules">
          Total <b className="ml-1">{all.length}</b>
        </span>
        {SEVERITIES.map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={mainTab === "rules" && severityFilter === s}
            title={`Show ${s} rules`}
            onClick={() => selectSeverity(s)}
            className={cn(
              "cockpit-cell min-w-0 flex-1 cursor-pointer justify-center transition-colors",
              mainTab === "rules" && severityFilter === s ? "bg-slate-100/90 text-slate-950 shadow-[inset_0_-2px_0_#2563eb] dark:bg-[#151d2b] dark:text-[#edf2fb] dark:shadow-[inset_0_-2px_0_#60a5fa]" : "text-slate-600 hover:bg-slate-50 hover:text-slate-900 dark:text-[#8b97ad] dark:hover:bg-[#141b29] dark:hover:text-[#edf2fb]",
            )}
          >
            <span aria-hidden className={cn("h-1.5 w-1.5 shrink-0 rounded-full", SEVERITY_DOTS[s])} />
            <span className="truncate uppercase tracking-wide">{s}</span>
            <b className="ml-1">{countBySeverity(s)}</b>
          </button>
        ))}
        <span className="cockpit-cell min-w-0 flex-1 justify-center" title="Rules currently enforcing">
          Enabled <b className="ml-1">{enabledCount}</b>
        </span>
      </div>

      {/* Tight single-row 40px toolbar: sections · severity tabs · visible count · primary action. */}
      <div className="cockpit-toolbar tactile-card h-10 w-full rounded-xl pl-1.5 pr-1.5 dark:bg-none dark:border-white/[0.08] dark:bg-[#0e131d]">
        <div role="group" aria-label="Sections" className={SEGMENT}>
          {MAIN_TABS.map((tab) => (
            <Segment key={tab.id} pressed={mainTab === tab.id} onClick={() => setMainTab(tab.id)}>{tab.label}</Segment>
          ))}
        </div>
        {mainTab === "rules" && (
          <>
            <div role="group" aria-label="Filter rules by severity" className={SEGMENT}>
              {(["all", ...SEVERITIES] as const).map((s) => (
                <Segment key={s} pressed={severityFilter === s} onClick={() => setSeverityFilter(s)}>{s === "all" ? "All" : s}</Segment>
              ))}
            </div>
            <span aria-live="polite" className="ml-auto hidden shrink-0 text-[11px] text-slate-500 dark:text-[#8b97ad] sm:block">
              <span className="font-mono text-slate-950 dark:text-[#eef2f8]">{filtered.length}</span> of {all.length}
            </span>
            {!canAdmin && (
              <span
                className="inline-flex shrink-0 items-center rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:border-amber-500/35 dark:bg-amber-500/10 dark:text-amber-300"
                title="Owner or admin role required to create, edit, enable, or delete approval-gate rules"
              >
                Read-only{currentRole ? ` (${currentRole})` : ""}
              </span>
            )}
            <Button
              size="sm"
              variant="outline"
              type="button" aria-pressed={showCreateForm}
              className="h-7 shrink-0 rounded-lg bg-blue-600 px-2.5 text-xs font-semibold text-white hover:bg-blue-500 dark:bg-[#2563eb] dark:text-[#f8fafc] dark:hover:bg-[#3b82f6]"
              onClick={() => { if (!canAdmin) return; setShowCreateForm((v) => !v); setCreateError(null); }}
              disabled={!canAdmin}
              title={!canAdmin ? "Admin role required to create rules" : undefined}
            >
              <Plus className="h-3.5 w-3.5" />
              New Rule
            </Button>
          </>
        )}
      </div>

      {mainTab === "ops" && <HermitGateAndOpsPanel companyId={selectedCompanyId} />}

      {mainTab === "rules" && (
        <>
          <p className="px-0.5 text-xs text-slate-500 dark:text-[#8b97ad]">외부 발행·배포·신고·결제 등 자유 미션에서도 반드시 사람 승인이 필요한 하드 가드레일을 설정합니다. 일반 업무 규정·플레이북은 Wiki → KB 트리에 등록하세요.</p>

          {/* Create form */}
          {showCreateForm && (
            <RuleForm
              canAdmin={canAdmin}
              onSubmit={(input) => { if (!canAdmin) return; createMutation.mutate(input); }}
              onCancel={() => { setShowCreateForm(false); setCreateError(null); }}
              isPending={createMutation.isPending}
              error={createError}
            />
          )}

          {/* Empty state */}
          {filtered.length === 0 && !showCreateForm && (
            <EmptyState
              icon={ShieldCheck}
              message={severityFilter === "all" ? "No worktree rules yet." : `No ${severityFilter} rules.`}
              action={severityFilter === "all" && canAdmin ? "New Rule" : undefined}
              onAction={severityFilter === "all" && canAdmin ? () => setShowCreateForm(true) : undefined}
            />
          )}

          {/* Rule list */}
          {filtered.length > 0 && (
            <div aria-label="Worktree rules" className="tactile-card overflow-hidden dark:bg-none dark:border-white/[0.08] dark:bg-[#0e131d]">
              {filtered.map((rule) => (
                <RuleRow key={rule.id} rule={rule} companyId={selectedCompanyId} canAdmin={canAdmin} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
