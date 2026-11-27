import { useEffect, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Cpu, HardDrive, MemoryStick, Square } from "lucide-react";
import {
  hermitGateApi,
  opsConsoleApi,
  type CoreDecision,
  type ResourceAlertThresholds,
} from "../api/hermit-gate-and-ops";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "../lib/utils";
import { useCompany } from "../context/CompanyContext";

export const HERMIT_AUDIT_TOTAL = 25;

const INPUT_CLASS = "border-slate-200/90 bg-white text-slate-900 placeholder:text-slate-400 focus-visible:border-blue-500 focus-visible:ring-blue-500/15 dark:border-white/[0.09] dark:bg-background dark:text-slate-100 dark:placeholder:text-slate-500 dark:focus-visible:border-[var(--pw-cobalt)] dark:focus-visible:ring-[var(--pw-cobalt)]/20";
const INSET_ROW_CLASS = "rounded-[10px] border border-slate-200/80 bg-slate-50/70 px-2 py-1 dark:border-white/[0.07] dark:bg-background";

export function auditProgressText(progress: { completed: number; total?: number } | null | undefined): string {
  return `${progress?.completed ?? 0} / ${progress?.total ?? HERMIT_AUDIT_TOTAL}`;
}

function Section(props: { title: string; children: ReactNode }) {
  return (
    <section className="tactile-card rounded-[12px] border-slate-200/90 bg-white p-3 text-slate-900 tabular-nums shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_10px_28px_rgba(15,23,42,0.10)] dark:border-white/[0.08] dark:bg-card dark:text-slate-100 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_10px_28px_rgba(0,0,0,0.42)] space-y-2">
      <h3 className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-muted-foreground">{props.title}</h3>
      {props.children}
    </section>
  );
}

function Unavailable({ name }: { name: string }) {
  return <p className="text-[11px] text-muted-foreground">{name} 엔드포인트 연결 불가 (백엔드 미배포 시 정상).</p>;
}

function ResourceBar(props: {
  label: string;
  icon: ReactNode;
  percent: number | null;
  threshold: number;
  canEdit: boolean;
  onThreshold: (v: number) => void;
  onCommitThreshold: () => void;
}) {
  const measured = props.percent !== null;
  const pct = measured ? Math.max(0, Math.min(100, props.percent!)) : 0;
  const over = measured && pct >= props.threshold;
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5 text-[11px]">
        {props.icon}
        <span className="w-8">{props.label}</span>
        <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-200/90 dark:bg-white/[0.08]">
          <div className={cn("h-full rounded-full transition-[width]", over ? "bg-rose-500 dark:bg-[var(--pw-crimson)]" : "bg-lime-500 dark:bg-[var(--pw-lime)]")} style={{ width: `${pct}%` }} />
        </div>
        <span className="w-14 text-right font-mono tabular-nums text-slate-600 dark:text-muted-foreground">{measured ? `${pct.toFixed(0)}%` : "측정 불가"}</span>
      </div>
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground pl-5">
        <span>알림 임계값 {props.threshold}%</span>
        <input
          type="range" min={10} max={99} step={1} value={props.threshold} disabled={!props.canEdit}
          onChange={(e) => props.onThreshold(Number(e.target.value))}
          onPointerUp={props.onCommitThreshold} onKeyUp={props.onCommitThreshold}
          className="w-24 h-1 accent-current" aria-label={`${props.label} 알림 임계값`}
          title={!props.canEdit ? "임계값 저장은 관리자(owner·admin) 역할만 가능합니다" : undefined}
        />
      </div>
    </div>
  );
}

export function HermitGateAndOpsPanel(props: { companyId: string }) {
  const { companyId } = props;
  const { canWrite = true, canAdmin = true, currentRole } = useCompany();
  const queryClient = useQueryClient();
  const [claimForm, setClaimForm] = useState({ taskId: "", worktreeName: "", paths: "" });
  const [claimError, setClaimError] = useState<string | null>(null);
  const [opsError, setOpsError] = useState<string | null>(null);
  const [pendingScope, setPendingScope] = useState("");
  const [decisionForm, setDecisionForm] = useState({ decision: "", rationale: "", impact: "", amendTarget: "" });
  const [thresholds, setThresholds] = useState<ResourceAlertThresholds>({ cpuPercent: 85, ramPercent: 85, diskPercent: 90 });
  const [thresholdsReady, setThresholdsReady] = useState(false);
  const [validateResult, setValidateResult] = useState<string | null>(null);

  const stateQ = useQuery({ queryKey: ["hg-state", companyId], queryFn: () => hermitGateApi.state(companyId), retry: false });
  const overviewQ = useQuery({ queryKey: ["ops-overview", companyId], queryFn: () => opsConsoleApi.overview(companyId), refetchInterval: 10_000, retry: false });

  useEffect(() => {
    if (overviewQ.data?.thresholds) {
      setThresholds(overviewQ.data.thresholds);
      setThresholdsReady(true);
    }
  }, [overviewQ.data?.thresholds]);

  const invalidateState = () => queryClient.invalidateQueries({ queryKey: ["hg-state", companyId] });
  const invalidateOverview = () => queryClient.invalidateQueries({ queryKey: ["ops-overview", companyId] });

  const toErrorMsg = (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback);

  const submitClaim = async () => {
    if (!canWrite) return;
    const paths = claimForm.paths.split(",").map((p) => p.trim()).filter(Boolean);
    if (!claimForm.taskId || !claimForm.worktreeName || paths.length === 0) return;
    setClaimError(null);
    try {
      await hermitGateApi.claim(companyId, { taskId: claimForm.taskId, worktreeName: claimForm.worktreeName, paths });
      setClaimForm({ taskId: "", worktreeName: "", paths: "" });
      invalidateState();
    } catch (err) {
      setClaimError(toErrorMsg(err, "경로 클레임 충돌 또는 요청 실패"));
    }
  };

  const commitThresholds = async () => {
    if (!thresholdsReady || !canAdmin) return;
    setOpsError(null);
    try {
      await opsConsoleApi.updateThresholds(companyId, thresholds);
      invalidateOverview();
    } catch (err) {
      setOpsError(toErrorMsg(err, "리소스 임계값 저장에 실패했습니다"));
    }
  };

  const runValidate = async (stage: "pre-commit" | "pr") => {
    if (!canWrite) return;
    const paths = claimForm.paths.split(",").map((p) => p.trim()).filter(Boolean);
    const resolved = paths.length > 0 ? paths : claims[0]?.paths ?? [];
    if (resolved.length === 0) { setValidateResult("검증할 경로를 입력해 주세요"); return; }
    try {
      const res = await hermitGateApi.validate(companyId, { stage, taskId: claimForm.taskId || claims[0]?.taskId, paths: resolved });
      setValidateResult(res.ok ? "검증 통과" : `검증 실패: ${res.errors.join("; ") || "unknown"}`);
    } catch { setValidateResult("검증 엔드포인트 연결 불가"); }
  };

  const addDecision = async () => {
    if (!canWrite || !decisionForm.decision) return;
    setOpsError(null);
    try {
      await hermitGateApi.createDecision(companyId, decisionForm);
      setDecisionForm({ decision: "", rationale: "", impact: "", amendTarget: "" });
      invalidateState();
    } catch (err) {
      setOpsError(toErrorMsg(err, "핵심 결정 기록에 실패했습니다"));
    }
  };

  const usage = overviewQ.data?.resources;
  const claims = stateQ.data?.claims ?? [];
  const audit = stateQ.data?.audit;
  const decisions = stateQ.data?.decisions ?? [];
  const processes = overviewQ.data?.processes ?? [];
  const auditPct = Math.min(100, ((audit?.completed ?? 0) / (audit?.total ?? HERMIT_AUDIT_TOTAL)) * 100);

  return (
    <div className="space-y-3 tabular-nums">
      {opsError && <p className="rounded-[8px] border border-rose-500/25 bg-rose-500/10 px-2 py-1 text-[11px] font-medium text-rose-700 dark:border-[var(--pw-crimson)]/30 dark:bg-[var(--pw-crimson-soft)] dark:text-[var(--pw-crimson)]">{opsError}</p>}
      {!canWrite && <p className="text-[11px] font-medium text-amber-700 dark:text-amber-400" title="Member, admin, or owner role required for Hermit Gate and Ops actions">읽기 전용{currentRole ? ` (${currentRole})` : ""} — Hermit 게이트·Ops 변경 작업은 권한이 있는 역할만 가능합니다.</p>}
      <Section title="Hermit 게이트 — 활성 경로 클레임">
        {stateQ.isError ? <Unavailable name="클레임" /> : (
          <div className="space-y-1">
            {claims.length === 0 && <p className="text-[11px] text-muted-foreground">활성 클레임 없음.</p>}
            {claims.map((c) => (
              <div key={c.id} className={cn("flex items-center gap-2 font-mono text-[11px] tabular-nums", INSET_ROW_CLASS)}>
                <span className="shrink-0">{c.taskId}</span>
                <span className="text-muted-foreground shrink-0">{c.worktreeName}</span>
                <span className="flex-1 min-w-0 truncate text-muted-foreground">{c.paths.join(", ")}</span>
                <Button variant="ghost" size="sm" className="h-5 px-1.5 text-[10px] text-destructive" disabled={!canWrite}
                  onClick={async () => {
                    if (!canWrite) return;
                    setOpsError(null);
                    try { await hermitGateApi.releaseClaim(companyId, c.taskId); invalidateState(); }
                    catch (err) { setOpsError(toErrorMsg(err, "클레임 해제에 실패했습니다")); }
                  }}>
                  해제
                </Button>
              </div>
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-1.5">
          <Input className={cn(INPUT_CLASS, "h-7 w-24 text-[11px]")} placeholder="taskId" value={claimForm.taskId} disabled={!canWrite} onChange={(e) => setClaimForm({ ...claimForm, taskId: e.target.value })} />
          <Input className={cn(INPUT_CLASS, "h-7 w-28 text-[11px]")} placeholder="worktree" value={claimForm.worktreeName} disabled={!canWrite} onChange={(e) => setClaimForm({ ...claimForm, worktreeName: e.target.value })} />
          <Input className={cn(INPUT_CLASS, "h-7 flex-1 min-w-32 text-[11px]")} placeholder="paths (쉼표 구분)" value={claimForm.paths} disabled={!canWrite} onChange={(e) => setClaimForm({ ...claimForm, paths: e.target.value })} />
          <Button size="sm" className="h-7 px-2 text-[11px]" onClick={submitClaim} disabled={!canWrite} title={!canWrite ? "Member, admin, or owner role required" : undefined}>클레임</Button>
        </div>
        {claimError && <p className="text-[11px] font-medium text-rose-700 dark:text-[var(--pw-crimson)]">{claimError}</p>}
      </Section>

      <Section title={`25-PR 누적 감사 — ${auditProgressText(audit)}`}>
        {stateQ.isError ? <Unavailable name="감사 진행" /> : (
          <>
            <div className="h-2 overflow-hidden rounded-full bg-slate-200/90 dark:bg-white/[0.08]">
              <div className="h-full rounded-full bg-blue-500 transition-[width] dark:bg-[var(--pw-cobalt)]" style={{ width: `${auditPct}%` }} />
            </div>
            <div className="flex items-center gap-1.5 flex-wrap">
              <Input className={cn(INPUT_CLASS, "h-7 flex-1 min-w-32 text-[11px]")} placeholder="보류 범위 (쉼표 구분)" value={pendingScope} disabled={!canWrite} onChange={(e) => setPendingScope(e.target.value)} />
              <Button variant="outline" size="sm" className="h-7 px-2 text-[11px]" disabled={!pendingScope.trim() || !canWrite}
                onClick={async () => {
                  if (!canWrite) return;
                  const scopes = pendingScope.split(",").map((s) => s.trim()).filter(Boolean);
                  setOpsError(null);
                  try { await hermitGateApi.completeAudit(companyId, { pendingScopes: scopes }); setPendingScope(""); invalidateState(); }
                  catch (err) { setOpsError(toErrorMsg(err, "보류 범위 적용에 실패했습니다")); }
                }}>
                보류 범위 적용
              </Button>
              <Button size="sm" className="h-7 px-2 text-[11px]" disabled={(audit?.completed ?? 0) === 0 && !audit?.lastAuditMergeSha || !canWrite}
                onClick={async () => {
                  if (!canWrite) return;
                  setOpsError(null);
                  try { await hermitGateApi.completeAudit(companyId, {}); invalidateState(); }
                  catch (err) { setOpsError(toErrorMsg(err, "감사 완료 처리에 실패했습니다")); }
                }}>
                감사 완료
              </Button>
            </div>
          </>
        )}
        <div className="flex items-center gap-1.5">
          <Button variant="outline" size="sm" className="h-7 px-2 text-[11px]" onClick={() => runValidate("pre-commit")} disabled={!canWrite}>pre-commit 검증</Button>
          <Button variant="outline" size="sm" className="h-7 px-2 text-[11px]" onClick={() => runValidate("pr")} disabled={!canWrite}>PR 검증</Button>
          {validateResult && <span className="text-[10px] text-muted-foreground">{validateResult}</span>}
        </div>
      </Section>

      <Section title="핵심 결정 원장">
        {stateQ.isError ? <Unavailable name="결정 원장" /> : (
          <div className="space-y-1">
            {decisions.length === 0 && <p className="text-[11px] text-muted-foreground">기록된 결정 없음.</p>}
            {decisions.map((d: CoreDecision) => (
              <div key={d.id} className={cn("text-[11px] space-y-0.5", INSET_ROW_CLASS, "py-1.5")}>
                <div className="font-medium text-slate-900 dark:text-slate-100">{d.decision}</div>
                <div className="text-slate-500 dark:text-muted-foreground">근거·가정 → {d.rationale}</div>
                <div className="text-slate-500 dark:text-muted-foreground">영향 → {d.impact}</div>
                <div className="text-slate-500 dark:text-muted-foreground">수정할 위치 → {d.amendTarget}</div>
              </div>
            ))}
          </div>
        )}
        <div className="grid grid-cols-2 gap-1.5">
          {(["decision", "rationale", "impact", "amendTarget"] as const).map((k) => (
            <Input key={k} className="h-7 text-[11px]" placeholder={{ decision: "결정", rationale: "근거·가정", impact: "영향", amendTarget: "수정할 위치" }[k]}
              value={decisionForm[k]} disabled={!canWrite} onChange={(e) => setDecisionForm({ ...decisionForm, [k]: e.target.value })} />
          ))}
        </div>
        <Button size="sm" className="h-7 px-2 text-[11px]" onClick={addDecision} disabled={!decisionForm.decision || !canWrite}>결정 기록</Button>
      </Section>

      <Section title="시스템 리소스">
        {overviewQ.isError || !usage ? <Unavailable name="리소스" /> : (
          <div className="space-y-2">
            <ResourceBar label="CPU" icon={<Cpu className="h-3.5 w-3.5" />} percent={usage.cpuPercent} threshold={thresholds.cpuPercent}
              canEdit={thresholdsReady && canAdmin} onThreshold={(v) => setThresholds({ ...thresholds, cpuPercent: v })} onCommitThreshold={commitThresholds} />
            <ResourceBar label="RAM" icon={<MemoryStick className="h-3.5 w-3.5" />} percent={usage.ramPercent} threshold={thresholds.ramPercent}
              canEdit={thresholdsReady && canAdmin} onThreshold={(v) => setThresholds({ ...thresholds, ramPercent: v })} onCommitThreshold={commitThresholds} />
            <ResourceBar label="Disk" icon={<HardDrive className="h-3.5 w-3.5" />} percent={usage.diskPercent} threshold={thresholds.diskPercent}
              canEdit={thresholdsReady && canAdmin} onThreshold={(v) => setThresholds({ ...thresholds, diskPercent: v })} onCommitThreshold={commitThresholds} />
          </div>
        )}
      </Section>

      <Section title="백그라운드 프로세스">
        {overviewQ.isError ? <Unavailable name="프로세스" /> : (
          <div className="space-y-1">
            {processes.length === 0 && <p className="text-[11px] text-muted-foreground">실행 중인 프로세스 없음.</p>}
            {processes.map((p) => (
              <div key={p.pid} className={cn("flex items-center gap-2 font-mono text-[11px] tabular-nums", INSET_ROW_CLASS)}>
                <span className="w-14 shrink-0">{p.pid}</span>
                <span className="w-16 shrink-0 text-muted-foreground">{p.etime}</span>
                <span className="flex-1 min-w-0 truncate">{p.command}</span>
                {p.ownedChild && (
                  <Button variant="ghost" size="sm" className="h-5 px-1.5 text-[10px] text-destructive" disabled={!canAdmin} title={!canAdmin ? "Admin role required to stop processes" : undefined}
                    onClick={async () => {
                      if (!canAdmin) return;
                      setOpsError(null);
                      try { await opsConsoleApi.stopProcess(companyId, p.pid); invalidateOverview(); }
                      catch (err) { setOpsError(toErrorMsg(err, "프로세스 중지에 실패했습니다")); }
                    }}>
                    <Square className="h-3 w-3 mr-0.5" />중지
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}
