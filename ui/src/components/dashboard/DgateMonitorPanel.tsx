import { cn } from "@/lib/utils";
import type { DgateDashboardBridgeResponse, DgateSnapshot } from "@/api/dashboard";
import { Radio, ShieldCheck, GitBranch, Activity, Cpu } from "lucide-react";

export type DgateMonitorResponse = DgateDashboardBridgeResponse & {
  stale?: boolean;
  reason?: string | null;
};

export interface DgateMonitorPanelProps {
  dgate?: DgateMonitorResponse | null;
  loading?: boolean;
  className?: string;
}

function asStr(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

function asNum(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function formatShortTime(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString("ko-KR", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function isWorkerActive(status: string): boolean {
  const s = status.toLowerCase();
  return s === "active" || s === "running" || s === "busy" || s === "working";
}

interface WorkerNodeProps {
  role: string;
  entry: Record<string, unknown>;
}

function WorkerNodeCard({ role, entry }: WorkerNodeProps) {
  const slot = asStr(entry.slot, role.slice(0, 2).toUpperCase());
  const name = asStr(entry.name ?? entry.label ?? entry.id, "unnamed");
  const address = asStr(entry.address ?? entry.terminal_id ?? entry.pane ?? entry.host, "");
  const cli = asStr(entry.cli ?? entry.tool ?? entry.adapter, "");
  const model = asStr(entry.model, "");
  const effort = asStr(entry.effort ?? entry.reasoning_effort, "");
  const status = asStr(entry.status, "idle");
  const repoTag = asStr(entry.repo_tag ?? entry.repo, "");
  const activity = asStr(entry.activity ?? entry.preview ?? entry.last_line, "");
  const active = isWorkerActive(status);

  const specParts = [cli, model, effort].filter(Boolean);

  return (
    <div className="flex flex-col justify-between gap-1.5 rounded-md border border-border/80 bg-muted/20 p-2.5 dark:border-[#242d3f] dark:bg-[#131823]">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0 rounded border border-[#5f8dff]/35 bg-[#5f8dff]/10 px-1.5 py-0.5 font-mono text-[9.5px] font-semibold text-[#3b82f6] dark:text-[#7aa2ff]">
            {slot}
          </span>
          <span className="truncate text-xs font-semibold text-foreground" title={name}>
            {name}
          </span>
        </div>
        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9.5px] font-medium",
            active
              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
              : "border-border bg-muted/40 text-muted-foreground dark:border-[#242d3f] dark:bg-[#151b28]",
          )}
        >
          <span className="relative flex h-1.5 w-1.5">
            {active && (
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
            )}
            <span
              className={cn(
                "relative inline-flex h-1.5 w-1.5 rounded-full",
                active ? "bg-emerald-500 dark:bg-emerald-400" : "bg-muted-foreground/50",
              )}
            />
          </span>
          {status}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
        {address && <span className="font-mono text-foreground/80">{address}</span>}
        {specParts.length > 0 && (
          <span className="truncate font-mono" title={specParts.join(" / ")}>
            {specParts.join(" / ")}
          </span>
        )}
        {repoTag && (
          <span className="ml-auto rounded border border-border/70 bg-background/60 px-1.5 py-0.2 font-mono text-[9.5px] text-foreground/80 dark:border-[#242d3f] dark:bg-[#0f1117]">
            {repoTag}
          </span>
        )}
      </div>

      {activity && (
        <p
          className="truncate rounded bg-muted/40 px-2 py-1 font-mono text-[10px] text-muted-foreground dark:bg-[#0b0e14]"
          title={activity}
        >
          {activity}
        </p>
      )}
    </div>
  );
}

function gateChipTone(status: string): string {
  const s = status.toLowerCase();
  if (s === "pass" || s === "passed" || s === "cleared") {
    return "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";
  }
  if (s === "challenge" || s === "fail" || s === "blocked") {
    return "border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-400";
  }
  if (s === "active" || s === "running" || s === "open") {
    return "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300";
  }
  return "border-border bg-muted/40 text-muted-foreground dark:border-[#242d3f] dark:bg-[#151b28]";
}

function pipelineChipTone(status: string): string {
  const s = status.toLowerCase();
  if (s === "running" || s === "active") {
    return "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";
  }
  if (s === "ready_pr" || s === "ready" || s === "merged") {
    return "border-[#5f8dff]/40 bg-[#5f8dff]/10 text-[#3b82f6] dark:text-[#7aa2ff]";
  }
  if (s === "escalated" || s === "failed" || s === "blocked") {
    return "border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-400";
  }
  return "border-border bg-muted/40 text-muted-foreground dark:border-[#242d3f] dark:bg-[#151b28]";
}

function extractPipelines(snapshot: DgateSnapshot): Array<Record<string, unknown>> {
  const localRepo = snapshot.local_repo;
  if (!localRepo || typeof localRepo !== "object") return [];
  const raw = (localRepo as Record<string, unknown>).pipelines;
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is Record<string, unknown> => !!item && typeof item === "object");
}

export function DgateMonitorPanel({
  dgate,
  loading = false,
  className,
}: DgateMonitorPanelProps) {
  if (loading) {
    return (
      <div
        className={cn(
          "rounded-lg border border-border bg-card p-4 dark:border-[#242d3f] dark:bg-[#0f1117]",
          className,
        )}
        aria-busy="true"
        aria-label="dgate 웹 모니터 로딩 중"
      >
        <div className="mb-3 h-5 w-48 animate-pulse rounded bg-muted" />
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          {[0, 1, 2].map((idx) => (
            <div
              key={idx}
              className="h-24 animate-pulse rounded-md border border-border/70 bg-muted/30 dark:border-[#242d3f] dark:bg-[#131823]"
            />
          ))}
        </div>
      </div>
    );
  }

  if (!dgate?.available || !dgate.snapshot) {
    const reason = dgate?.reason ?? dgate?.error ?? "dgate 웹 브리지 응답이 없습니다.";
    return (
      <div
        data-testid="dgate-offline-card"
        className={cn(
          "rounded-lg border border-border bg-card p-5 dark:border-[#242d3f] dark:bg-[#0f1117]",
          className,
        )}
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-muted/40 text-muted-foreground dark:border-[#242d3f] dark:bg-[#151b28]">
              <Radio className="h-4 w-4" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-xs font-semibold text-foreground">dgate 웹 모니터 미연결</h3>
                <span className="rounded-full border border-border bg-muted/50 px-2 py-0.5 font-mono text-[10px] text-muted-foreground dark:border-[#242d3f] dark:bg-[#151b28]">
                  OFFLINE
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{reason}</p>
              <p className="mt-2 rounded border border-border/70 bg-muted/30 px-2.5 py-1.5 font-mono text-[11px] text-foreground/85 dark:border-[#242d3f] dark:bg-[#131823]">
                연결 방법: <span className="text-[#5f8dff]">DGATE_WEB_URL</span> 환경변수 설정 또는{" "}
                <span className="text-[#84cc16]">POST /dashboard/dgate/snapshot</span> 푸시
              </p>
              <p className="mt-2 text-[11px] text-muted-foreground">
                네이티브 paperwork-runtime 실행 세션은 상단 첫 번째 탭(<strong>실행 중인 세션</strong>)에서 계속 확인할 수 있습니다.
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const snap = dgate.snapshot;
  const isStale = Boolean(dgate.stale);
  const outcomes = snap.outcomes ?? {};
  const passCount = asNum(outcomes.pass);
  const reworkCount = asNum(outcomes.rework);
  const failCount = asNum(outcomes.fail);
  const waitingCount = asNum(outcomes.waiting_human);
  const pipelines = extractPipelines(snap);
  const recentEvents = Array.isArray(snap.recent_events) ? snap.recent_events : [];

  const rosterGroups: Array<{ key: string; title: string; items: Array<Record<string, unknown>> }> = [
    { key: "workers", title: "Workers", items: Array.isArray(snap.workers) ? snap.workers : [] },
    { key: "verifiers", title: "Verifiers", items: Array.isArray(snap.verifiers) ? snap.verifiers : [] },
    { key: "advisors", title: "Advisors", items: Array.isArray(snap.advisors) ? snap.advisors : [] },
  ];

  return (
    <div
      data-testid="dgate-live-panel"
      className={cn(
        "flex flex-col gap-4 rounded-lg border border-border bg-card p-4 tabular-nums dark:border-[#242d3f] dark:bg-[#0f1117]",
        className,
      )}
    >
      {/* Top Summary Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3 dark:border-[#242d3f]">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-[10px] font-semibold",
              isStale
                ? "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300"
                : "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
            )}
          >
            <span className="relative flex h-1.5 w-1.5">
              {!isStale && (
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
              )}
              <span
                className={cn(
                  "relative inline-flex h-1.5 w-1.5 rounded-full",
                  isStale ? "bg-amber-500" : "bg-emerald-500 dark:bg-emerald-400",
                )}
              />
            </span>
            {isStale ? "STALE" : "dgate LIVE"}
          </span>

          <span className="font-mono text-[11px] text-muted-foreground">
            {formatShortTime(snap.timestamp)}
          </span>

          {snap.scope && (
            <span className="rounded border border-border/80 bg-muted/40 px-2 py-0.5 font-mono text-[10px] text-foreground dark:border-[#242d3f] dark:bg-[#151b28]">
              {snap.scope}
            </span>
          )}

          {snap.effort_level && (
            <span className="rounded border border-[#5f8dff]/35 bg-[#5f8dff]/10 px-2 py-0.5 font-mono text-[10px] text-[#3b82f6] dark:text-[#7aa2ff]">
              effort: {snap.effort_level}
            </span>
          )}
        </div>

        {/* Metrics & Outcomes Strip */}
        <div className="flex flex-wrap items-center gap-2 text-[10px]">
          <span className="rounded border border-border/80 bg-muted/30 px-2 py-0.5 font-mono text-foreground dark:border-[#242d3f] dark:bg-[#131823]">
            forks <strong>{snap.open_forks}</strong>/{snap.total_forks}
          </span>
          <span className="inline-flex items-center gap-1 rounded border border-border/80 bg-muted/30 px-2 py-0.5 font-mono text-foreground dark:border-[#242d3f] dark:bg-[#131823]">
            <Cpu className="h-3 w-3 text-[#84cc16]" />
            워커 <strong>{snap.mapped_count}</strong>/{snap.host_process_count}
          </span>
          <div className="flex items-center gap-1 font-mono">
            <span className="rounded border border-emerald-500/35 bg-emerald-500/10 px-1.5 py-0.5 text-emerald-600 dark:text-emerald-400">
              pass {passCount}
            </span>
            <span className="rounded border border-amber-500/35 bg-amber-500/10 px-1.5 py-0.5 text-amber-600 dark:text-amber-300">
              rework {reworkCount}
            </span>
            <span className="rounded border border-rose-500/35 bg-rose-500/10 px-1.5 py-0.5 text-rose-600 dark:text-rose-400">
              fail {failCount}
            </span>
            <span className="rounded border border-[#5f8dff]/35 bg-[#5f8dff]/10 px-1.5 py-0.5 text-[#3b82f6] dark:text-[#7aa2ff]">
              wait {waitingCount}
            </span>
          </div>
        </div>
      </div>

      {/* Active Workers & Topology Roster */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Active Workers &amp; Topology Roster
          </h4>
          <span className="font-mono text-[10px] text-muted-foreground">
            DB {snap.db_live ? "LIVE" : "SNAPSHOT"}
          </span>
        </div>

        {snap.lead && (
          <div>
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-[#84cc16]">
              Lead
            </p>
            <WorkerNodeCard role="LEAD" entry={snap.lead} />
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
          {rosterGroups.map((group) => (
            <div key={group.key} className="space-y-1.5">
              <div className="flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                <span>{group.title}</span>
                <span className="font-mono">{group.items.length}</span>
              </div>
              {group.items.length === 0 ? (
                <div className="rounded-md border border-dashed border-border/70 bg-muted/15 px-3 py-3 text-center text-[11px] text-muted-foreground dark:border-[#242d3f] dark:bg-[#111520]">
                  활성 {group.title} 없음
                </div>
              ) : (
                <div className="space-y-2">
                  {group.items.map((item, idx) => (
                    <WorkerNodeCard
                      key={asStr(item.id ?? item.name ?? item.slot, `${group.key}-${idx}`)}
                      role={group.title}
                      entry={item}
                    />
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Bayesian Routes & Active Gates */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <div className="space-y-2 lg:col-span-8">
          <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Bayesian Routes
          </h4>
          {Array.isArray(snap.routes) && snap.routes.length > 0 ? (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {snap.routes.map((route, idx) => {
                const name = asStr(route.route ?? route.name ?? route.kind, `route_${idx + 1}`);
                const rawP = asNum(route.p ?? route.posterior ?? route.prob, 0);
                const pct = Math.max(0, Math.min(100, rawP <= 1 ? Math.round(rawP * 100) : Math.round(rawP)));
                const mode = asStr(route.mode ?? route.decision ?? route.action, pct >= 70 ? "sharp" : "split");
                const isSharp = mode.toLowerCase() === "sharp";
                return (
                  <div
                    key={name}
                    className="rounded-md border border-border/80 bg-muted/20 p-2.5 dark:border-[#242d3f] dark:bg-[#131823]"
                  >
                    <div className="flex items-center justify-between gap-1">
                      <span className="truncate font-mono text-[10.5px] font-semibold text-foreground" title={name}>
                        {name}
                      </span>
                      <span
                        className={cn(
                          "shrink-0 rounded px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase",
                          isSharp
                            ? "bg-[#84cc16]/15 text-[#65a30d] dark:text-[#a3e635]"
                            : "bg-amber-500/15 text-amber-600 dark:text-amber-300",
                        )}
                      >
                        {mode}
                      </span>
                    </div>
                    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted dark:bg-slate-800">
                      <div
                        className={cn(
                          "h-full rounded-full transition-all",
                          isSharp ? "bg-[#84cc16]" : "bg-amber-500",
                        )}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <p className="mt-1 font-mono text-[10px] text-muted-foreground">
                      p = {(pct / 100).toFixed(2)} ({pct}%)
                    </p>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="rounded-md border border-dashed border-border/70 px-3 py-3 text-[11px] text-muted-foreground dark:border-[#242d3f]">
              라우트 텔레메트리 없음
            </div>
          )}
        </div>

        <div className="space-y-2 lg:col-span-4">
          <div className="flex items-center gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5 text-[#5f8dff]" />
            <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Active Gates (G1–G3)
            </h4>
          </div>
          {Array.isArray(snap.active_gates) && snap.active_gates.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {snap.active_gates.map((gate, idx) => {
                const label = asStr(gate.gate ?? gate.id ?? gate.name, `G${idx + 1}`);
                const status = asStr(gate.status ?? gate.verdict ?? gate.state, "pending");
                return (
                  <span
                    key={`${label}-${idx}`}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-[10px] font-semibold",
                      gateChipTone(status),
                    )}
                  >
                    <span>{label}</span>
                    <span className="opacity-75">{status}</span>
                  </span>
                );
              })}
            </div>
          ) : (
            <div className="rounded-md border border-dashed border-border/70 px-3 py-3 text-[11px] text-muted-foreground dark:border-[#242d3f]">
              활성 게이트 없음
            </div>
          )}
        </div>
      </div>

      {/* Local Pipelines & Recent Events */}
      <div className="grid grid-cols-1 gap-4 border-t border-border/70 pt-3 dark:border-[#242d3f] lg:grid-cols-12">
        <div className="space-y-2 lg:col-span-5">
          <div className="flex items-center gap-1.5">
            <GitBranch className="h-3.5 w-3.5 text-muted-foreground" />
            <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Local Pipelines
            </h4>
          </div>
          {pipelines.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {pipelines.map((p, idx) => {
                const name = asStr(p.name ?? p.branch ?? p.id, `pipeline-${idx + 1}`);
                const status = asStr(p.status ?? p.state, "running");
                return (
                  <span
                    key={`${name}-${idx}`}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-[10px]",
                      pipelineChipTone(status),
                    )}
                  >
                    <span className="font-semibold">{name}</span>
                    <span className="opacity-80">{status}</span>
                  </span>
                );
              })}
            </div>
          ) : (
            <p className="text-[11px] text-muted-foreground">실행 중인 로컬 파이프라인이 없습니다.</p>
          )}
        </div>

        <div className="space-y-2 lg:col-span-7">
          <div className="flex items-center gap-1.5">
            <Activity className="h-3.5 w-3.5 text-muted-foreground" />
            <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Recent Events
            </h4>
          </div>
          {recentEvents.length > 0 ? (
            <div className="max-h-36 space-y-1 overflow-y-auto rounded-md border border-border/70 bg-muted/20 p-2 font-mono text-[10.5px] dark:border-[#242d3f] dark:bg-[#0b0e14]">
              {recentEvents.slice(0, 12).map((ev, idx) => {
                const ts = asStr(ev.timestamp ?? ev.ts ?? ev.at, "");
                const kind = asStr(ev.kind ?? ev.type ?? ev.event, "event");
                const msg = asStr(ev.message ?? ev.summary ?? ev.detail ?? ev.label, "");
                return (
                  <div
                    key={`${ts}-${idx}`}
                    className="flex items-baseline gap-2 border-b border-border/40 pb-1 last:border-b-0 last:pb-0 dark:border-[#242d3f]/50"
                  >
                    {ts && <span className="shrink-0 text-[9.5px] text-muted-foreground">{formatShortTime(ts)}</span>}
                    <span className="shrink-0 rounded bg-muted px-1 py-0.2 text-[9.5px] font-semibold text-foreground dark:bg-[#151b28]">
                      {kind}
                    </span>
                    <span className="min-w-0 truncate text-muted-foreground">{msg || "—"}</span>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-[11px] text-muted-foreground">최근 이벤트가 없습니다.</p>
          )}
        </div>
      </div>
    </div>
  );
}
