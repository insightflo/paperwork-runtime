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

export const HERMIT_AUDIT_TOTAL = 25;

export function auditProgressText(progress: { completed: number; total?: number } | null | undefined): string {
  return `${progress?.completed ?? 0} / ${progress?.total ?? HERMIT_AUDIT_TOTAL}`;
}

function Section(props: { title: string; children: ReactNode }) {
  return (
    <section
      className="rounded-lg border p-3 space-y-2"
      style={{ backgroundColor: "var(--openbot-surface-25d-bg)", borderColor: "var(--openbot-surface-25d-border)" }}
    >
      <h3 className="text-xs font-semibold" style={{ color: "var(--openbot-text-secondary)" }}>{props.title}</h3>
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
        <div className="flex-1 h-2 rounded-full overflow-hidden" style={{ backgroundColor: "var(--openbot-ring-track)" }}>
          <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: over ? "var(--openbot-danger)" : "var(--openbot-success)" }} />
        </div>
        <span className="w-14 text-right font-mono">{measured ? `${pct.toFixed(0)}%` : "측정 불가"}</span>
      </div>
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground pl-5">
        <span>알림 임계값 {props.threshold}%</span>
        <input
          type="range" min={10} max={99} step={1} value={props.threshold} disabled={!props.canEdit}
          onChange={(e) => props.onThreshold(Number(e.target.value))}
          onPointerUp={props.onCommitThreshold} onKeyUp={props.onCommitThreshold}
          className="w-24 h-1 accent-current" aria-label={`${props.label} 알림 임계값`}
        />
      </div>
    </div>
  );
}

export function HermitGateAndOpsPanel(props: { companyId: string }) {
  const { companyId } = props;
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
    if (!thresholdsReady) return;
    setOpsError(null);
    try {
      await opsConsoleApi.updateThresholds(companyId, thresholds);
      invalidateOverview();
    } catch (err) {
      setOpsError(toErrorMsg(err, "리소스 임계값 저장에 실패했습니다"));
    }
  };

  const runValidate = async (stage: "pre-commit" | "pr") => {
    const paths = claimForm.paths.split(",").map((p) => p.trim()).filter(Boolean);
    const resolved = paths.length > 0 ? paths : claims[0]?.paths ?? [];
    if (resolved.length === 0) { setValidateResult("검증할 경로를 입력해 주세요"); return; }
    try {
      const res = await hermitGateApi.validate(companyId, { stage, taskId: claimForm.taskId || claims[0]?.taskId, paths: resolved });
      setValidateResult(res.ok ? "검증 통과" : `검증 실패: ${res.errors.join("; ") || "unknown"}`);
    } catch { setValidateResult("검증 엔드포인트 연결 불가"); }
  };

  const addDecision = async () => {
    if (!decisionForm.decision) return;
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
    <div className="space-y-3">
      {opsError && <p className="text-[11px] px-1" style={{ color: "var(--openbot-danger-text)" }}>{opsError}</p>}
      <Section title="Hermit 게이트 — 활성 경로 클레임">
        {stateQ.isError ? <Unavailable name="클레임" /> : (
          <div className="space-y-1">
            {claims.length === 0 && <p className="text-[11px] text-muted-foreground">활성 클레임 없음.</p>}
            {claims.map((c) => (
              <div key={c.id} className="flex items-center gap-2 text-[11px] font-mono border border-border/50 rounded px-2 py-1">
                <span className="shrink-0">{c.taskId}</span>
                <span className="text-muted-foreground shrink-0">{c.worktreeName}</span>
                <span className="flex-1 min-w-0 truncate text-muted-foreground">{c.paths.join(", ")}</span>
                <Button variant="ghost" size="sm" className="h-5 px-1.5 text-[10px] text-destructive"
                  onClick={async () => {
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
          <Input className="h-7 w-24 text-[11px]" placeholder="taskId" value={claimForm.taskId} onChange={(e) => setClaimForm({ ...claimForm, taskId: e.target.value })} />
          <Input className="h-7 w-28 text-[11px]" placeholder="worktree" value={claimForm.worktreeName} onChange={(e) => setClaimForm({ ...claimForm, worktreeName: e.target.value })} />
          <Input className="h-7 flex-1 min-w-32 text-[11px]" placeholder="paths (쉼표 구분)" value={claimForm.paths} onChange={(e) => setClaimForm({ ...claimForm, paths: e.target.value })} />
          <Button size="sm" className="h-7 px-2 text-[11px]" onClick={submitClaim}>클레임</Button>
        </div>
        {claimError && <p className="text-[11px]" style={{ color: "var(--openbot-danger-text)" }}>{claimError}</p>}
      </Section>

      <Section title={`25-PR 누적 감사 — ${auditProgressText(audit)}`}>
        {stateQ.isError ? <Unavailable name="감사 진행" /> : (
          <>
            <div className="h-2 rounded-full overflow-hidden" style={{ backgroundColor: "var(--openbot-ring-track)" }}>
              <div className="h-full rounded-full" style={{ width: `${auditPct}%`, backgroundColor: "var(--openbot-ring-fill)" }} />
            </div>
            <div className="flex items-center gap-1.5 flex-wrap">
              <Input className="h-7 flex-1 min-w-32 text-[11px]" placeholder="보류 범위 (쉼표 구분)" value={pendingScope} onChange={(e) => setPendingScope(e.target.value)} />
              <Button variant="outline" size="sm" className="h-7 px-2 text-[11px]" disabled={!pendingScope.trim()}
                onClick={async () => {
                  const scopes = pendingScope.split(",").map((s) => s.trim()).filter(Boolean);
                  setOpsError(null);
                  try { await hermitGateApi.completeAudit(companyId, { pendingScopes: scopes }); setPendingScope(""); invalidateState(); }
                  catch (err) { setOpsError(toErrorMsg(err, "보류 범위 적용에 실패했습니다")); }
                }}>
                보류 범위 적용
              </Button>
              <Button size="sm" className="h-7 px-2 text-[11px]" disabled={(audit?.completed ?? 0) === 0 && !audit?.lastAuditMergeSha}
                onClick={async () => {
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
          <Button variant="outline" size="sm" className="h-7 px-2 text-[11px]" onClick={() => runValidate("pre-commit")}>pre-commit 검증</Button>
          <Button variant="outline" size="sm" className="h-7 px-2 text-[11px]" onClick={() => runValidate("pr")}>PR 검증</Button>
          {validateResult && <span className="text-[10px] text-muted-foreground">{validateResult}</span>}
        </div>
      </Section>

      <Section title="핵심 결정 원장">
        {stateQ.isError ? <Unavailable name="결정 원장" /> : (
          <div className="space-y-1">
            {decisions.length === 0 && <p className="text-[11px] text-muted-foreground">기록된 결정 없음.</p>}
            {decisions.map((d: CoreDecision) => (
              <div key={d.id} className="text-[11px] border border-border/50 rounded px-2 py-1.5 space-y-0.5">
                <div className="font-medium">{d.decision}</div>
                <div className="text-muted-foreground">근거·가정 → {d.rationale}</div>
                <div className="text-muted-foreground">영향 → {d.impact}</div>
                <div className="text-muted-foreground">수정할 위치 → {d.amendTarget}</div>
              </div>
            ))}
          </div>
        )}
        <div className="grid grid-cols-2 gap-1.5">
          {(["decision", "rationale", "impact", "amendTarget"] as const).map((k) => (
            <Input key={k} className="h-7 text-[11px]" placeholder={{ decision: "결정", rationale: "근거·가정", impact: "영향", amendTarget: "수정할 위치" }[k]}
              value={decisionForm[k]} onChange={(e) => setDecisionForm({ ...decisionForm, [k]: e.target.value })} />
          ))}
        </div>
        <Button size="sm" className="h-7 px-2 text-[11px]" onClick={addDecision} disabled={!decisionForm.decision}>결정 기록</Button>
      </Section>

      <Section title="시스템 리소스">
        {overviewQ.isError || !usage ? <Unavailable name="리소스" /> : (
          <div className="space-y-2">
            <ResourceBar label="CPU" icon={<Cpu className="h-3.5 w-3.5" />} percent={usage.cpuPercent} threshold={thresholds.cpuPercent}
              canEdit={thresholdsReady} onThreshold={(v) => setThresholds({ ...thresholds, cpuPercent: v })} onCommitThreshold={commitThresholds} />
            <ResourceBar label="RAM" icon={<MemoryStick className="h-3.5 w-3.5" />} percent={usage.ramPercent} threshold={thresholds.ramPercent}
              canEdit={thresholdsReady} onThreshold={(v) => setThresholds({ ...thresholds, ramPercent: v })} onCommitThreshold={commitThresholds} />
            <ResourceBar label="Disk" icon={<HardDrive className="h-3.5 w-3.5" />} percent={usage.diskPercent} threshold={thresholds.diskPercent}
              canEdit={thresholdsReady} onThreshold={(v) => setThresholds({ ...thresholds, diskPercent: v })} onCommitThreshold={commitThresholds} />
          </div>
        )}
      </Section>

      <Section title="백그라운드 프로세스">
        {overviewQ.isError ? <Unavailable name="프로세스" /> : (
          <div className="space-y-1">
            {processes.length === 0 && <p className="text-[11px] text-muted-foreground">실행 중인 프로세스 없음.</p>}
            {processes.map((p) => (
              <div key={p.pid} className={cn("flex items-center gap-2 text-[11px] font-mono border border-border/50 rounded px-2 py-1")}>
                <span className="w-14 shrink-0">{p.pid}</span>
                <span className="w-16 shrink-0 text-muted-foreground">{p.etime}</span>
                <span className="flex-1 min-w-0 truncate">{p.command}</span>
                {p.ownedChild && (
                  <Button variant="ghost" size="sm" className="h-5 px-1.5 text-[10px] text-destructive"
                    onClick={async () => {
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
