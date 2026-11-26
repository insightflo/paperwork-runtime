import type { ReactNode } from "react";
import { UserPlus, Lightbulb, ShieldAlert, ShieldCheck, GitBranch } from "lucide-react";
import { formatCents } from "../lib/utils";
import { ReplacementApprovalPayload } from "./ReplacementApprovalPayload";
import { L, useCompanyLanguage } from "../lib/companyLanguage";
import type { CompanyDefaultLanguage } from "@paperclipai/shared";
import { humanLabel } from "../lib/humanLabels";

const VIEWER_CLASS =
  "tactile-card mt-3 space-y-2 rounded-[12px] border-slate-200/90 bg-white/95 p-3 text-sm text-slate-700 dark:border-white/[0.08] dark:bg-none dark:bg-[#0e131d] dark:text-[#cbd5e1] [&>section]:mt-0";
const LABEL_CLASS = "w-20 shrink-0 text-xs text-slate-500 dark:text-[#8b97ad] sm:w-24";
const LABEL_START_CLASS = `${LABEL_CLASS} pt-0.5`;
const VALUE_CHIP =
  "rounded-md border border-slate-200/80 bg-slate-50 px-1.5 py-0.5 font-mono text-[11px] text-slate-600 dark:border-white/[0.08] dark:bg-[#090c12] dark:text-[#9fb0c8]";
const INSET_PANEL =
  "rounded-[10px] border border-slate-200/80 bg-slate-50/85 px-3 py-2 text-xs text-slate-600 dark:border-white/[0.07] dark:bg-[#090c12] dark:text-[#9fb0c8]";

function PayloadShell({ children }: { children: ReactNode }) {
  return <div className={VIEWER_CLASS}>{children}</div>;
}

const typeLabels = {
  hire_agent: { en: "Hire Agent", ko: "에이전트 고용 승인" },
  approve_ceo_strategy: { en: "CEO Strategy", ko: "전략 승인" },
  budget_override_required: { en: "Budget Override", ko: "예산 상한 초과 승인" },
  external_automation: { en: "External Automation", ko: "외부 자동화 승인" },
  workflow_replacement: { en: "Rerun Replacement", ko: "교체 실행 승인" },
};
const fieldLabels: Record<string, { en: string; ko: string }> = {
  Name: { en: "Name", ko: "이름" }, Role: { en: "Role", ko: "역할" }, Title: { en: "Title", ko: "직함" },
  Icon: { en: "Icon", ko: "아이콘" }, Capabilities: { en: "Capabilities", ko: "기능" }, Adapter: { en: "Adapter", ko: "어댑터" },
  Skills: { en: "Skills", ko: "스킬" }, Scope: { en: "Scope", ko: "범위" }, Window: { en: "Window", ko: "기간" },
  Metric: { en: "Metric", ko: "지표" }, Limit: { en: "Limit", ko: "상한" }, Observed: { en: "Observed", ko: "현재 지출" },
  Repository: { en: "Repository", ko: "저장소" }, Branch: { en: "Branch", ko: "브랜치" }, Commit: { en: "Commit", ko: "커밋" },
  Action: { en: "Action", ko: "실행 작업" },
};
function FieldLabel({ label }: { label: string }) {
  const lang = useCompanyLanguage();
  return <>{fieldLabels[label] ? L(lang, fieldLabels[label]) : label}</>;
}

export const typeLabel: Record<string, string> = {
  hire_agent: "Hire Agent",
  approve_ceo_strategy: "CEO Strategy",
  budget_override_required: "Budget Override",
  external_automation: "External Automation",
  workflow_replacement: "교체 실행 승인",
};

/** Build a contextual label for an approval, e.g. "Hire Agent: Designer" */
export function approvalLabel(type: string, payload?: Record<string, unknown> | null, language: CompanyDefaultLanguage = "en"): string {
  const labels = Object.hasOwn(typeLabels, type) ? typeLabels[type as keyof typeof typeLabels] : undefined;
  const base = labels ? L(language, labels) : type;
  if (type === "hire_agent" && payload?.name) {
    return `${base}: ${String(payload.name)}`;
  }
  if (type === "external_automation") {
    const repo = typeof payload?.repository === "string" ? payload.repository : "";
    const branch = typeof payload?.branch === "string" ? payload.branch : "";
    const title = typeof payload?.title === "string" ? payload.title : "";
    if (title) return title;
    if (repo && branch) return `${base}: ${repo} (${branch})`;
    if (repo) return `${base}: ${repo}`;
  }
  return base;
}

export const typeIcon: Record<string, typeof UserPlus> = {
  hire_agent: UserPlus,
  approve_ceo_strategy: Lightbulb,
  budget_override_required: ShieldAlert,
  external_automation: GitBranch,
};

export const defaultTypeIcon = ShieldCheck;

function PayloadField({ label, value }: { label: string; value: unknown }) {
  if (!value) return null;
  return (
    <div className="flex items-center gap-2">
      <span className={LABEL_CLASS}><FieldLabel label={label} /></span>
      <span>{String(value)}</span>
    </div>
  );
}

function SkillList({ values }: { values: unknown }) {
  if (!Array.isArray(values)) return null;
  const items = values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);
  if (items.length === 0) return null;

  return (
    <div className="flex items-start gap-2">
      <span className={LABEL_START_CLASS}><FieldLabel label="Skills" /></span>
      <div className="flex flex-wrap gap-1.5">
        {items.map((item) => (
          <span
            key={item}
            className={VALUE_CHIP}
          >
            {item}
          </span>
        ))}
      </div>
    </div>
  );
}

export function HireAgentPayload({ payload }: { payload: Record<string, unknown> }) {
  return (
    <PayloadShell>
      <div className="flex items-center gap-2">
        <span className={LABEL_CLASS}><FieldLabel label="Name" /></span>
        <span className="font-medium">{String(payload.name ?? "—")}</span>
      </div>
      <PayloadField label="Role" value={payload.role} />
      <PayloadField label="Title" value={payload.title} />
      <PayloadField label="Icon" value={payload.icon} />
      {!!payload.capabilities && (
        <div className="flex items-start gap-2">
          <span className={LABEL_START_CLASS}><FieldLabel label="Capabilities" /></span>
          <span className="text-slate-500 dark:text-[#8b97ad]">{String(payload.capabilities)}</span>
        </div>
      )}
      {!!payload.adapterType && (
        <div className="flex items-center gap-2">
          <span className={LABEL_CLASS}><FieldLabel label="Adapter" /></span>
          <span className={VALUE_CHIP}>
            {String(payload.adapterType)}
          </span>
        </div>
      )}
      <SkillList values={payload.desiredSkills} />
    </PayloadShell>
  );
}

export function CeoStrategyPayload({ payload }: { payload: Record<string, unknown> }) {
  const lang = useCompanyLanguage();
  const plan = payload.plan ?? payload.description ?? payload.strategy ?? payload.text;
  return (
    <PayloadShell>
      <PayloadField label="Title" value={payload.title} />
      {!!plan && (
        <div className={`${INSET_PANEL} mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap font-mono`}>
          {String(plan)}
        </div>
      )}
      {!plan && (<div><p className="text-xs text-slate-500 dark:text-[#8b97ad]">{L(lang, { en: "Raw data", ko: "원본 데이터" })}</p>
        <pre className={`${INSET_PANEL} mt-2 max-h-48 overflow-x-auto`}>
          {JSON.stringify(payload, null, 2)}
        </pre></div>
      )}
    </PayloadShell>
  );
}

export function BudgetOverridePayload({ payload }: { payload: Record<string, unknown> }) {
  const budgetAmount = typeof payload.budgetAmount === "number" ? payload.budgetAmount : null;
  const observedAmount = typeof payload.observedAmount === "number" ? payload.observedAmount : null;
  return (
    <PayloadShell>
      <PayloadField label="Scope" value={payload.scopeName ?? payload.scopeType} />
      <PayloadField label="Window" value={payload.windowKind} />
      <PayloadField label="Metric" value={payload.metric} />
      {(budgetAmount !== null || observedAmount !== null) ? (
        <div className={INSET_PANEL}>
          <FieldLabel label="Limit" /> {budgetAmount !== null ? formatCents(budgetAmount) : "—"} · <FieldLabel label="Observed" /> {observedAmount !== null ? formatCents(observedAmount) : "—"}
        </div>
      ) : null}
      {!!payload.guidance && (
        <p className="text-slate-500 dark:text-[#8b97ad]">{String(payload.guidance)}</p>
      )}
    </PayloadShell>
  );
}

function shortSha(sha: string): string {
  return typeof sha === "string" && sha.length > 12 ? `${sha.slice(0, 12)}…` : sha;
}

export function ExternalAutomationPayload({ payload }: { payload: Record<string, unknown> }) {
  const lang = useCompanyLanguage();
  const checks = Array.isArray(payload.checks) ? payload.checks : [];
  return (
    <PayloadShell>
      <PayloadField label="Repository" value={payload.repository} />
      <PayloadField label="Branch" value={payload.branch} />
      {typeof payload.commit === "string" && payload.commit && (
        <div className="flex items-center gap-2">
          <span className={LABEL_CLASS}><FieldLabel label="Commit" /></span>
          <span className={VALUE_CHIP}>{shortSha(payload.commit)}</span>
        </div>
      )}
      <PayloadField label="Action" value={payload.intendedAction} />
      {typeof payload.summary === "string" && payload.summary && (
        <p className="text-slate-500 dark:text-[#8b97ad]">{payload.summary}</p>
      )}
      {checks.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-1">
          {checks.map((check, index) => {
            const entry = (check ?? {}) as Record<string, unknown>;
            const name = typeof entry.name === "string" ? entry.name : `check ${index + 1}`;
            const conclusion = typeof entry.conclusion === "string" ? entry.conclusion : (typeof entry.status === "string" ? entry.status : "unknown");
            return (
              <span key={index} className={VALUE_CHIP}>
                {name} · <span title={conclusion}>{humanLabel(lang, "ciConclusion", conclusion).label}</span>
              </span>
            );
          })}
        </div>
      )}
    </PayloadShell>
  );
}

export function ApprovalPayloadRenderer({ type, payload }: { type: string; payload: Record<string, unknown> }) {
  if (type === "workflow_replacement") return <PayloadShell><ReplacementApprovalPayload payload={payload} /></PayloadShell>;
  if (type === "hire_agent") return <HireAgentPayload payload={payload} />;
  if (type === "budget_override_required") return <BudgetOverridePayload payload={payload} />;
  if (type === "external_automation") return <ExternalAutomationPayload payload={payload} />;
  return <CeoStrategyPayload payload={payload} />;
}
