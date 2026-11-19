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

function ResourceBar(props: { label: string; icon: ReactNode; percent: number; threshold: number; onThreshold: (v: number) => void }) {
  const pct = Math.max(0, Math.min(100, props.percent));
  const over = pct >= props.threshold;
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5 text-[11px]">
        {props.icon}
        <span className="w-8">{props.label}</span>
        <div className="flex-1 h-2 rounded-full overflow-hidden" style={{ backgroundColor: "var(--openbot-ring-track)" }}>
          <div
            className="h-full rounded-full transition-all"
            style={{
              width: `${pct}%`,
              backgroundColor: over ? "var(--openbot-danger)" : "var(--openbot-success)",
            }}
          />
        </div>
        <span className="w-10 text-right font-mono">{pct.toFixed(0)}%</span>
      </div>
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground pl-5">
        <span>알림 임계값 {props.threshold}%</span>
        <input
          type="range" min={50} max={100} step={5} value={props.threshold}
          onChange={(e) => props.onThreshold(Number(e.target.value))}
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
  const [pendingScope, setPendingScope] = useState("");
  const [decisionForm, setDecisionForm] = useState({ decision: "", rationale: "", impact: "", amendTarget: "" });
  const [thresholds, setThresholds] = useState<ResourceAlertThresholds>({ cpuPercent: 90, ramPercent: 90, diskPercent: 90 });
  const [validateResult, setValidateResult] = useState<string | null>(null);

  const claimsQ = useQuery({ queryKey: ["hg-claims", companyId], queryFn: () => hermitGateApi.claims(companyId), retry: false });
  const auditQ = useQuery({ queryKey: ["hg-audit", companyId], queryFn: () => hermitGateApi.auditProgress(companyId), retry: false });
  const decisionsQ = useQuery({ queryKey: ["hg-decisions", companyId], queryFn: () => hermitGateApi.decisions(companyId), retry: false });
  const resourcesQ = useQuery({ queryKey: ["ops-resources", companyId], queryFn: () => opsConsoleApi.resources(companyId), refetchInterval: 10_000, retry: false });
  const thresholdsQ = useQuery({ queryKey: ["ops-thresholds", companyId], queryFn: () => opsConsoleApi.thresholds(companyId), retry: false });
  const processesQ = useQuery({ queryKey: ["ops-processes", companyId], queryFn: () => opsConsoleApi.processes(companyId), refetchInterval: 10_000, retry: false });

  useEffect(() => {
    if (thresholdsQ.data) setThresholds(thresholdsQ.data);
  }, [thresholdsQ.data]);

  const invalidate = (key: string) => queryClient.invalidateQueries({ queryKey: [key, companyId] });

  const submitClaim = async () => {
    const paths = claimForm.paths.split(",").map((p) => p.trim()).filter(Boolean);
    if (!claimForm.taskId || !claimForm.worktreeName || paths.length === 0) return;
    try {
      await hermitGateApi.claim(companyId, { taskId: claimForm.taskId, worktreeName: claimForm.worktreeName, paths });
      setClaimForm({ taskId: "", worktreeName: "", paths: "" });
      invalidate("hg-claims");
    } catch { /* noop */ }
  };

  const saveThresholds = async (next: ResourceAlertThresholds) => {
    setThresholds(next);
    try { await opsConsoleApi.updateThresholds(companyId, next); } catch { /* noop */ }
  };

  const runValidate = async (stage: "pre-commit" | "pr") => {
    try {
      const paths = claimForm.paths.split(",").map((p) => p.trim()).filter(Boolean);
      const res = await hermitGateApi.validate(companyId, {
        stage,
        taskId: claimForm.taskId || claims[0]?.taskId,
        paths: paths.length > 0 ? paths : claims[0]?.paths,
      });
      setValidateResult(res.ok ? "검증 통과" : `검증 실패: ${res.errors.join("; ") || "unknown"}`);
    } catch {
      setValidateResult("검증 엔드포인트 연결 불가");
    }
  };

  const addDecision = async () => {
    if (!decisionForm.decision) return;
    try {
      await hermitGateApi.createDecision(companyId, decisionForm);
      setDecisionForm({ decision: "", rationale: "", impact: "", amendTarget: "" });
      invalidate("hg-decisions");
    } catch { /* noop */ }
  };

  const usage = resourcesQ.data;
  const claims = claimsQ.data ?? [];
  const decisions = decisionsQ.data ?? [];
  const processes = processesQ.data ?? [];
  const auditPct = Math.min(100, ((auditQ.data?.completed ?? 0) / (auditQ.data?.total ?? HERMIT_AUDIT_TOTAL)) * 100);

  return (
    <div className="space-y-3">
      <Section title="Hermit 게이트 — 활성 경로 클레임">
        {claimsQ.isError ? <Unavailable name="클레임" /> : (
          <div className="space-y-1">
            {claims.length === 0 && <p className="text-[11px] text-muted-foreground">활성 클레임 없음.</p>}
            {claims.map((c) => (
              <div key={c.id} className="flex items-center gap-2 text-[11px] font-mono border border-border/50 rounded px-2 py-1">
                <span className="shrink-0">{c.taskId}</span>
                <span className="text-muted-foreground shrink-0">{c.worktreeName}</span>
                <span className="flex-1 min-w-0 truncate text-muted-foreground">{c.paths.join(", ")}</span>
                <Button variant="ghost" size="sm" className="h-5 px-1.5 text-[10px] text-destructive"
                  onClick={async () => { try { await hermitGateApi.releaseClaim(companyId, c.taskId); invalidate("hg-claims"); } catch { /* noop */ } }}>
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
      </Section>

      <Section title={`25-PR 누적 감사 — ${auditProgressText(auditQ.data)}`}>
        {auditQ.isError ? <Unavailable name="감사 진행" /> : (
          <>
            <div className="h-2 rounded-full overflow-hidden" style={{ backgroundColor: "var(--openbot-ring-track)" }}>
              <div className="h-full rounded-full" style={{ width: `${auditPct}%`, backgroundColor: "var(--openbot-ring-fill)" }} />
            </div>
            <div className="flex items-center gap-1.5">
              <Input className="h-7 flex-1 text-[11px]" placeholder="보류 범위 (선택)" value={pendingScope} onChange={(e) => setPendingScope(e.target.value)} />
              <Button size="sm" className="h-7 px-2 text-[11px]"
                onClick={async () => {
                  try {
                    await hermitGateApi.completeAudit(companyId, { pendingScopes: pendingScope ? [pendingScope] : [] });
                    setPendingScope("");
                    invalidate("hg-audit");
                  } catch { /* noop */ }
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
        {decisionsQ.isError ? <Unavailable name="결정 원장" /> : (
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
        {resourcesQ.isError || !usage ? <Unavailable name="리소스" /> : (
          <div className="space-y-2">
            <ResourceBar label="CPU" icon={<Cpu className="h-3.5 w-3.5" />} percent={usage.cpuPercent} threshold={thresholds.cpuPercent}
              onThreshold={(v) => saveThresholds({ ...thresholds, cpuPercent: v })} />
            <ResourceBar label="RAM" icon={<MemoryStick className="h-3.5 w-3.5" />} percent={usage.ramPercent} threshold={thresholds.ramPercent}
              onThreshold={(v) => saveThresholds({ ...thresholds, ramPercent: v })} />
            <ResourceBar label="Disk" icon={<HardDrive className="h-3.5 w-3.5" />} percent={usage.diskPercent} threshold={thresholds.diskPercent}
              onThreshold={(v) => saveThresholds({ ...thresholds, diskPercent: v })} />
          </div>
        )}
      </Section>

      <Section title="백그라운드 프로세스">
        {processesQ.isError ? <Unavailable name="프로세스" /> : (
          <div className="space-y-1">
            {processes.length === 0 && <p className="text-[11px] text-muted-foreground">실행 중인 프로세스 없음.</p>}
            {processes.map((p) => (
              <div key={p.pid} className={cn("flex items-center gap-2 text-[11px] font-mono border border-border/50 rounded px-2 py-1")}>
                <span className="w-14 shrink-0">{p.pid}</span>
                <span className="w-16 shrink-0 text-muted-foreground">{p.etime}</span>
                <span className="flex-1 min-w-0 truncate">{p.command}</span>
                {p.ownedChild && (
                  <Button variant="ghost" size="sm" className="h-5 px-1.5 text-[10px] text-destructive"
                    onClick={async () => { try { await opsConsoleApi.stopProcess(companyId, p.pid); invalidate("ops-processes"); } catch { /* noop */ } }}>
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
