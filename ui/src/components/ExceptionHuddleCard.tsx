import { useEffect, useId, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

export type ExceptionHuddleStatus = "open" | "decided" | "timed_out" | "cancelled";
export type ExceptionHuddleDecisionKind = "retry_with_guidance" | "accept_with_waiver" | "replan_remaining" | "escalate";

export interface ExceptionHuddleDecision {
  kind: ExceptionHuddleDecisionKind;
  rationale: string;
  guidance?: string;
  waiverCondition?: string;
  replanSummary?: string;
  escalationReason?: string;
  forcedByChair?: boolean;
}

export interface ExceptionHuddle {
  id: string;
  status: ExceptionHuddleStatus;
  currentRound: number;
  maxRounds: number;
  timeoutAt: string;
  failureSummary: string;
  workProductLinks: string[];
  participants: { ownerName: string; producerName: string; validatorName: string };
  decision?: ExceptionHuddleDecision | null;
}

export interface ExceptionHuddleDecisionInput {
  kind: ExceptionHuddleDecisionKind;
  rationale: string;
  guidance?: string;
  waiverCondition?: string;
  replanSummary?: string;
  escalationReason?: string;
}

interface DecisionOption {
  kind: ExceptionHuddleDecisionKind;
  label: string;
  detailLabel: string;
}

const DECISION_OPTIONS: DecisionOption[] = [
  { kind: "retry_with_guidance", label: "Retry with guidance", detailLabel: "Guidance" },
  { kind: "accept_with_waiver", label: "Accept with waiver", detailLabel: "Waiver condition" },
  { kind: "replan_remaining", label: "Replan remaining work", detailLabel: "Replan summary" },
  { kind: "escalate", label: "Escalate", detailLabel: "Escalation reason" },
];

function decisionLabel(kind: ExceptionHuddleDecisionKind) {
  return DECISION_OPTIONS.find((option) => option.kind === kind)?.label ?? kind;
}

function statusClass(status: ExceptionHuddleStatus) {
  if (status === "open") return "border-blue-600/30 bg-blue-500/10 text-blue-700 dark:border-[#60a5fa]/35 dark:bg-[#60a5fa]/12 dark:text-[#60a5fa]";
  if (status === "decided") return "border-lime-600/30 bg-lime-500/10 text-lime-800 dark:border-[#a3e635]/35 dark:bg-[#a3e635]/12 dark:text-[#a3e635]";
  if (status === "timed_out") return "border-amber-600/30 bg-amber-500/10 text-amber-800 dark:border-[#f59e0b]/35 dark:bg-[#f59e0b]/12 dark:text-[#f59e0b]";
  return "border-slate-500/30 bg-slate-500/10 text-slate-700 dark:border-white/15 dark:bg-white/[0.06] dark:text-slate-300";
}

function decisionDetailRows(decision: ExceptionHuddleDecision) {
  return [
    ["Guidance", decision.guidance],
    ["Waiver condition", decision.waiverCondition],
    ["Replan summary", decision.replanSummary],
    ["Escalation reason", decision.escalationReason],
  ].filter((row): row is [string, string] => typeof row[1] === "string" && row[1] !== "");
}

export function ExceptionHuddleCard({
  huddle,
  canDecide = false,
  onDecide,
  isSubmitting = false,
}: {
  huddle: ExceptionHuddle;
  canDecide?: boolean;
  onDecide?: (decision: ExceptionHuddleDecisionInput) => Promise<void> | void;
  isSubmitting?: boolean;
}) {
  const idBase = useId();
  const errorId = `${idBase}-decision-error`;
  const rationaleId = `${idBase}-rationale`;
  const detailId = `${idBase}-detail`;
  const errorRef = useRef<HTMLDivElement>(null);
  const [kind, setKind] = useState<ExceptionHuddleDecisionKind>("retry_with_guidance");
  const [rationale, setRationale] = useState("");
  const [detail, setDetail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const selectedOption = DECISION_OPTIONS.find((option) => option.kind === kind) ?? DECISION_OPTIONS[0]!;
  const canUseForm = (huddle.status === "open" || huddle.status === "timed_out") && canDecide;
  const participantChips = [
    ["Owner (Chair)", huddle.participants.ownerName],
    ["Producer", huddle.participants.producerName],
    ["Validator", huddle.participants.validatorName],
  ];

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  function buildPayload(trimmedRationale: string, trimmedDetail: string): ExceptionHuddleDecisionInput {
    const base = { kind, rationale: trimmedRationale };
    if (kind === "retry_with_guidance") return { ...base, guidance: trimmedDetail };
    if (kind === "accept_with_waiver") return { ...base, waiverCondition: trimmedDetail };
    if (kind === "replan_remaining") return { ...base, replanSummary: trimmedDetail };
    return { ...base, escalationReason: trimmedDetail };
  }

  async function submitDecision() {
    const trimmedRationale = rationale.trim();
    const trimmedDetail = detail.trim();
    if (!trimmedRationale) {
      setError("Rationale is required.");
      return;
    }
    if (!trimmedDetail) {
      setError(`${selectedOption.detailLabel} is required.`);
      return;
    }
    setError(null);
    try {
      await onDecide?.(buildPayload(trimmedRationale, trimmedDetail));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Decision submission failed.");
    }
  }

  return (
    <article aria-labelledby={`${idBase}-heading`} className="tactile-card rounded-[12px] border border-border/80 bg-card/90 p-4 text-card-foreground tabular-nums shadow-[inset_0_1px_0_rgba(255,255,255,0.75),0_10px_28px_rgba(15,23,42,0.08)] dark:border-white/[0.08] dark:bg-[#0e131d] dark:text-[#eef2f8] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_10px_28px_rgba(0,0,0,0.42)]">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border/70 pb-3 dark:border-white/[0.07]">
        <div className="min-w-0">
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground dark:text-[#8f9db3]">Structured exception huddle</p>
          <h2 id={`${idBase}-heading`} className="mt-1 text-lg font-semibold tracking-[-0.01em]">Exception huddle {huddle.id}</h2>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground dark:text-[#9aa7bd]">
            <span className="font-medium text-foreground dark:text-[#eef2f8]">Round {huddle.currentRound}/{huddle.maxRounds}</span>
            <span>5-min deadline: <time dateTime={huddle.timeoutAt}>{huddle.timeoutAt}</time></span>
          </div>
        </div>
        <Badge variant="outline" className={cn("px-2 py-1 font-mono text-[11px] uppercase tracking-wider", statusClass(huddle.status))}>{huddle.status}</Badge>
      </header>

      <section aria-label="Huddle participants" className="mt-3 flex flex-wrap gap-2">
        {participantChips.map(([role, name]) => (
          <span key={role} className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-background/70 px-2.5 py-1 text-xs dark:border-white/[0.09] dark:bg-[#07090d]">
            <span className="font-semibold text-foreground dark:text-[#eef2f8]">{role}</span>
            <span className="text-muted-foreground dark:text-[#9aa7bd]">{name}</span>
          </span>
        ))}
      </section>

      <section className="mt-4 rounded-[10px] border border-red-500/20 bg-red-500/[0.05] p-3 dark:border-red-400/20 dark:bg-red-500/[0.08]">
        <h3 className="text-sm font-semibold text-red-900 dark:text-red-100">Failure summary</h3>
        <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-red-900/85 dark:text-red-100/80">{huddle.failureSummary}</p>
      </section>

      <section className="mt-4">
        <h3 className="text-sm font-semibold">Work products</h3>
        {huddle.workProductLinks.length > 0 ? (
          <ul className="mt-2 space-y-1.5">
            {huddle.workProductLinks.map((link) => (
              <li key={link}>
                <a href={link} target="_blank" rel="noopener noreferrer" className="break-all text-sm font-medium text-blue-700 underline underline-offset-2 hover:text-blue-800 dark:text-[#60a5fa] dark:hover:text-[#a3e635]">{link}</a>
              </li>
            ))}
          </ul>
        ) : <p className="mt-1 text-sm text-muted-foreground dark:text-[#9aa7bd]">No work products linked.</p>}
      </section>

      {huddle.status === "decided" && huddle.decision ? (
        <section role="status" aria-live="polite" className="mt-4 rounded-[10px] border border-lime-600/25 bg-lime-500/[0.07] p-3 dark:border-[#a3e635]/25 dark:bg-[#a3e635]/[0.08]">
          <h3 className="text-sm font-semibold">Structured decision</h3>
          <dl className="mt-2 space-y-2 text-sm">
            <div>
              <dt className="font-medium text-muted-foreground dark:text-[#9aa7bd]">Decision</dt>
              <dd>{decisionLabel(huddle.decision.kind)} <code className="text-xs">{huddle.decision.kind}</code></dd>
            </div>
            <div>
              <dt className="font-medium text-muted-foreground dark:text-[#9aa7bd]">Rationale</dt>
              <dd className="whitespace-pre-wrap">{huddle.decision.rationale}</dd>
            </div>
            {decisionDetailRows(huddle.decision).map(([label, value]) => (
              <div key={label}>
                <dt className="font-medium text-muted-foreground dark:text-[#9aa7bd]">{label}</dt>
                <dd className="whitespace-pre-wrap">{value}</dd>
              </div>
            ))}
          </dl>
          {huddle.decision.forcedByChair ? <p className="mt-2 text-xs font-semibold">Forced by Owner Chair</p> : null}
        </section>
      ) : null}

      {canUseForm ? (
        <form noValidate className="mt-4 rounded-[10px] border border-border/70 bg-background/60 p-3 dark:border-white/[0.08] dark:bg-[#07090d]/80" onSubmit={(event) => { event.preventDefault(); void submitDecision(); }}>
          <fieldset disabled={isSubmitting} className="space-y-3">
            <legend className="text-sm font-semibold">Owner decision</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {DECISION_OPTIONS.map((option) => {
                const optionId = `${idBase}-kind-${option.kind}`;
                return (
                  <div key={option.kind} className="flex items-start gap-2 rounded-md border border-border/60 px-2.5 py-2 dark:border-white/[0.08]">
                    <input id={optionId} type="radio" name={`${idBase}-decision-kind`} value={option.kind} checked={kind === option.kind} disabled={isSubmitting} onChange={() => { setKind(option.kind); setDetail(""); setError(null); }} className="mt-1 size-4 accent-primary" />
                    <Label htmlFor={optionId} className="flex min-w-0 flex-col items-start gap-0.5 text-sm">
                      <span>{option.label}</span>
                      <code className="text-[11px] font-normal text-muted-foreground dark:text-[#8f9db3]">{option.kind}</code>
                    </Label>
                  </div>
                );
              })}
            </div>

            <div className="space-y-2">
              <Label htmlFor={rationaleId}>Rationale <span aria-hidden="true">*</span></Label>
              <Textarea id={rationaleId} name="rationale" value={rationale} required disabled={isSubmitting} aria-invalid={error?.startsWith("Rationale") || undefined} aria-describedby={error ? errorId : undefined} onChange={(event) => setRationale(event.target.value)} />
            </div>

            <div className="space-y-2">
              <Label htmlFor={detailId}>{selectedOption.detailLabel} <span aria-hidden="true">*</span></Label>
              <Textarea id={detailId} name="detail" value={detail} required disabled={isSubmitting} aria-invalid={(error !== null && !error.startsWith("Rationale")) || undefined} aria-describedby={error ? errorId : undefined} onChange={(event) => setDetail(event.target.value)} />
            </div>

            {error ? (
              <div id={errorId} ref={errorRef} tabIndex={-1} role="alert" aria-live="assertive" className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm font-medium text-red-700 outline-none dark:border-red-400/30 dark:bg-red-500/10 dark:text-red-200">{error}</div>
            ) : null}

            <div className="flex justify-end">
              <Button type="button" disabled={isSubmitting || !onDecide} onClick={() => { void submitDecision(); }}>
                {isSubmitting ? "Submitting…" : "Submit decision"}
              </Button>
            </div>
          </fieldset>
        </form>
      ) : null}
    </article>
  );
}
